#!/usr/bin/env node
// Hook PermissionRequest do CodeTown: deixa aprovar ou recusar pelo escritório os pedidos de permissão
// do Claude Code ("Do you want to…"). Chega à sessão de um destes jeitos (este arquivo é a fonte única
// dos dois):
//
// - plugin `codetown-permissoes` do marketplace do repositório (Claude Code 2.1.287+): o hooks.json ao
//   lado roda `node "${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs"`, com a porta vinda de CODETOWN_PORT.
//   O Claude Code copia SÓ a pasta do plugin para o cache de plugins: por isso nada de imports fora de
//   `node:*` aqui;
// - `npm run hooks:install` (versões anteriores), que grava em cada <conta>/settings.json:
//
//   node /caminho/do/codetown/mod/codetown-permissoes/hooks/permission-hook.mjs [--port 4747] [--timeout 300]
//
// O Claude Code mostra o diálogo no terminal e roda este hook AO MESMO TEMPO (vale o que responder
// primeiro); em subagentes em segundo plano o diálogo só aparece depois que o hook termina. O hook:
// 1. lê do stdin o JSON do pedido (session_id, tool_name, tool_input, permission_suggestions...);
// 2. manda para POST http://127.0.0.1:<porta>/api/permissions. Se o CodeTown não responder, recusar
//    (recurso desligado) ou disser que não há página aberta ou que não conhece a sessão, sai na hora,
//    sem decidir: o terminal segue normal;
// 3. senão, espera a decisão em GET /api/permissions/:id/wait (respostas de até 25 s, em laço) até o
//    tempo limite (padrão 5 min: --timeout <s> ou CODETOWN_PERMISSION_TIMEOUT);
// 4. aprovado/recusado: imprime a decisão (hookSpecificOutput.decision). "Responder no terminal",
//    tempo esgotado ou qualquer erro: sai sem imprimir nada, e vale o que você responder no terminal.
//
// Regras: Node puro (22+), sem dependências; nunca trava nem quebra a sessão (todo erro = sair sem
// decidir). Só fala com 127.0.0.1. CODETOWN_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const DEFAULT_TIMEOUT_S = 300;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 1_800;
/** Espera máxima de cada long-poll (o servidor responde "pending" e o hook pergunta de novo). */
const WAIT_S = 25;
/** Registrar o pedido: se o CodeTown não responder nisso, ele está fora do ar (ou travado). */
const REGISTER_TIMEOUT_MS = 2_000;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Textos dos argumentos mandados ao CodeTown (o servidor só mostra uma prévia). */
const MAX_STRING = 8_000;
/** Corpo do pedido (o servidor recusa acima de 256 KB). */
const MAX_BODY = 200_000;
/** Ferramentas cuja resposta é uma escolha, não aprovar/recusar: ficam só no terminal. */
const SKIP_TOOLS = new Set(['AskUserQuestion']);

const debug = process.env.CODETOWN_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[codetown-hook] ${msg}\n`) : () => {};

/** Porta e tempo limite: argumentos (--port, --timeout) ou ambiente (CODETOWN_PORT, CODETOWN_PERMISSION_TIMEOUT). */
export function parseOptions(argv, env = process.env) {
  const arg = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const port = Number.parseInt(arg('port') ?? env.CODETOWN_PORT ?? '', 10);
  const timeout = Number(arg('timeout') ?? env.CODETOWN_PERMISSION_TIMEOUT ?? '');
  return {
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, timeout)) : DEFAULT_TIMEOUT_S) * 1_000,
  };
}

/** Corta textos longos dos argumentos (conteúdo de um Write enorme, por exemplo). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/**
 * Corpo mandado ao CodeTown: só o que ele usa (nada de transcript_path nem do resto do stdin). Se ainda
 * ficar grande (muitas edições de uma vez), os textos são cortados mais curtos.
 */
export function requestBody(input, timeoutMs) {
  const body = { session_id: input.session_id, tool_name: input.tool_name, tool_input: {}, timeout_ms: timeoutMs };
  for (const k of ['agent_id', 'agent_type', 'cwd']) if (typeof input[k] === 'string') body[k] = input[k];
  if (Array.isArray(input.permission_suggestions)) body.permission_suggestions = input.permission_suggestions;
  for (const max of [MAX_STRING, 1_000, 200]) {
    body.tool_input = trimInput(input.tool_input ?? {}, max);
    if (JSON.stringify(body).length <= MAX_BODY) break;
  }
  return body;
}

/**
 * Saída do hook para uma decisão do CodeTown (undefined = sair sem decidir). Uma regra "sempre permitir"
 * escolhida na página volta só como a POSIÇÃO: aplica-se a sugestão original que o Claude Code mandou.
 */
export function decisionOutput(result, input) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') {
    const decision = { behavior: 'allow' };
    const list = Array.isArray(input?.permission_suggestions) ? input.permission_suggestions : [];
    const chosen = Number.isInteger(result.suggestion) ? list[result.suggestion] : undefined;
    if (chosen && typeof chosen === 'object') decision.updatedPermissions = [chosen];
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    const decision = { behavior: 'deny', message: reason ? `Recusado pelo usuário no CodeTown: ${reason}` : 'Recusado pelo usuário no CodeTown.' };
    if (result.interrupt === true) decision.interrupt = true;
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  return undefined;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Requisição ao CodeTown local; null = fora do ar, tempo esgotado ou resposta ilegível. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Decide o pedido (ou não). Devolve a saída a imprimir, ou undefined. Nunca lança. */
export async function run(argv = process.argv.slice(2), env = process.env, stdinText) {
  try {
    const opts = parseOptions(argv, env);
    const raw = stdinText ?? (await readStdin());
    if (!raw) return undefined;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || typeof input.tool_name !== 'string') return undefined;
    if (input.hook_event_name !== undefined && input.hook_event_name !== 'PermissionRequest') return undefined;
    if (SKIP_TOOLS.has(input.tool_name)) return undefined;

    const base = `http://127.0.0.1:${opts.port}`;
    const deadline = Date.now() + opts.timeoutMs;
    const reg = await call(base, 'POST', '/api/permissions', requestBody(input, opts.timeoutMs), REGISTER_TIMEOUT_MS);
    if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
      debug(`sem desvio (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'CodeTown fora do ar'})`);
      return undefined;
    }
    const id = encodeURIComponent(reg.json.id);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        debug('tempo esgotado: vale o terminal');
        return undefined;
      }
      const waitS = Math.max(0.05, Math.min(WAIT_S, left / 1_000));
      const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
      if (!r || r.status !== 200) return undefined;
      const status = r.json?.status;
      if (status === 'pending') continue;
      debug(`resposta: ${JSON.stringify(r.json)}`);
      return decisionOutput(r.json, input);
    }
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return undefined;
  }
}

/** Ponto de entrada (exportado para o atalho do caminho antigo, scripts/permission-hook.mjs). */
export async function main() {
  const { timeoutMs } = parseOptions(process.argv.slice(2));
  // Rede de segurança: nada mantém o processo vivo além do tempo limite.
  setTimeout(() => process.exit(0), timeoutMs + 15_000).unref();
  const out = await run();
  // Pipes são assíncronos no macOS: só sai depois que a decisão foi escrita.
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
  else process.exit(0);
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
