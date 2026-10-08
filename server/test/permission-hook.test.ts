// Hook PermissionRequest (scripts/permission-hook.mjs) rodado como processo de verdade contra o servidor
// de teste: stdin JSON → saída esperada (aprovar, recusar, "sempre permitir", terminal), saída rápida e
// sem decisão quando o CodeTown está fora do ar, desligado ou sem páginas abertas, e o tempo limite.
// Os processos são assíncronos (spawn): o servidor roda neste mesmo processo.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { hookJson, MAIN, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../scripts/permission-hook.mjs');

/** Funções exportadas pelo hook (JavaScript puro, sem tipos). */
interface HookModule {
  parseOptions(argv: string[], env: NodeJS.ProcessEnv): { port: number; timeoutMs: number };
  requestBody(input: Record<string, unknown>, timeoutMs: number): Record<string, unknown>;
  trimInput(v: unknown, max?: number): unknown;
  decisionOutput(result: unknown, input: unknown): unknown;
}
const { decisionOutput, parseOptions, requestBody, trimInput } = (await import(pathToFileURL(HOOK).href)) as HookModule;

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(stdin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env: { PATH: process.env.PATH, HOME: '/nao/existe', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** Espera até o pedido aparecer no registro e devolve o id dele. */
async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('o hook não registrou o pedido');
}

/** Porta livre sem ninguém escutando (CodeTown "fora do ar"). */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

let srv: PermissionServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

describe('permission-hook.mjs (processo)', () => {
  it('aprovar pelo CodeTown: imprime a decisão allow e sai com 0', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    const id = await pendingId(srv);
    expect(srv.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  });

  it('"sempre permitir": aplica a sugestão ORIGINAL do stdin pela posição', async () => {
    srv = await servePermissions();
    const input = hookJson();
    const run = runHook(JSON.stringify(input), ['--port', String(srv.port)]);
    srv.registry!.decide(await pendingId(srv), { behavior: 'allow', suggestion: 0 });
    const out = JSON.parse((await run).stdout);
    expect(out.hookSpecificOutput.decision).toEqual({ behavior: 'allow', updatedPermissions: [(input.permission_suggestions as unknown[])[0]] });
  });

  it('recusar com motivo (e interromper): decisão deny com a mensagem para o agente', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(hookJson()), [], { CODETOWN_PORT: String(srv.port) });
    srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'use pnpm', interrupt: true });
    const r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Recusado pelo usuário no CodeTown: use pnpm', interrupt: true });
  });

  it('"responder no terminal": sai sem decisão (stdout vazio)', async () => {
    srv = await servePermissions();
    const run = runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    srv.registry!.decide(await pendingId(srv), { behavior: 'terminal' });
    const r = await run;
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('CodeTown fora do ar: sai rápido, sem decisão', async () => {
    const r = await runHook(JSON.stringify(hookJson()), ['--port', String(await deadPort())]);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
  });

  it('recurso desligado (403) ou ninguém olhando: sai na hora, sem decisão', async () => {
    srv = await servePermissions({ enabled: false });
    let r = await runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    await srv.close();
    srv = await servePermissions({ viewers: 0 });
    r = await runHook(JSON.stringify(hookJson()), ['--port', String(srv.port)]);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(srv.registry!.size).toBe(0);
  });

  it('stdin inválido, outro evento ou AskUserQuestion: sai sem perguntar ao CodeTown', async () => {
    srv = await servePermissions();
    for (const stdin of ['', 'não é json', '[]', JSON.stringify(hookJson({ hook_event_name: 'PreToolUse' })), JSON.stringify(hookJson({ tool_name: 'AskUserQuestion' }))]) {
      const r = await runHook(stdin, ['--port', String(srv.port)]);
      expect(r, stdin).toMatchObject({ code: 0, stdout: '' });
    }
    expect(srv.registry!.size).toBe(0);
  });

  it('tempo limite (--timeout): desiste, sai sem decisão e o pedido some do escritório', async () => {
    srv = await servePermissions({ registry: { orphanMs: 300 } });
    const r = await runHook(JSON.stringify(hookJson()), ['--port', String(srv.port), '--timeout', '5']);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(12_000);
    await new Promise((ok) => setTimeout(ok, 600));
    expect(srv.registry!.size).toBe(0);
  }, 20_000);
});

describe('permission-hook.mjs (funções)', () => {
  it('parseOptions: argumentos, ambiente e limites', () => {
    expect(parseOptions([], {})).toEqual({ port: 4747, timeoutMs: 300_000 });
    expect(parseOptions(['--port', '4851', '--timeout', '60'], {})).toEqual({ port: 4851, timeoutMs: 60_000 });
    expect(parseOptions([], { CODETOWN_PORT: '4848', CODETOWN_PERMISSION_TIMEOUT: '1' })).toEqual({ port: 4848, timeoutMs: 5_000 });
    expect(parseOptions(['--port', 'x', '--timeout', '99999'], {})).toEqual({ port: 4747, timeoutMs: 1_800_000 });
  });

  it('requestBody: só o que o CodeTown usa, com textos cortados', () => {
    const body = requestBody(hookJson({ agent_id: 'a1', agent_type: 'Explore', tool_input: { content: 'x'.repeat(20_000) } }), 60_000);
    expect(Object.keys(body).sort()).toEqual(['agent_id', 'agent_type', 'cwd', 'permission_suggestions', 'session_id', 'timeout_ms', 'tool_input', 'tool_name']);
    expect((body.tool_input as { content: string }).content.length).toBe(8_000);
    expect(trimInput({ a: [{ b: 'y'.repeat(9_000) }] })).toEqual({ a: [{ b: 'y'.repeat(8_000) }] });
    // Muitas edições de uma vez: corta mais curto para caber no limite do servidor.
    const edits = Array.from({ length: 60 }, () => ({ old_string: 'o'.repeat(10_000), new_string: 'n'.repeat(10_000) }));
    const big = requestBody(hookJson({ tool_name: 'MultiEdit', tool_input: { file_path: '/a.ts', edits } }), 60_000);
    expect(JSON.stringify(big).length).toBeLessThan(200_000);
    expect((big.tool_input as { edits: Array<{ old_string: string }> }).edits[0].old_string.length).toBe(1_000);
  });

  it('decisionOutput: allow/deny no formato do hook; o resto = sem decisão', () => {
    expect(decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 5 }, hookJson())).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(decisionOutput({ status: 'decided', behavior: 'deny' }, hookJson())).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Recusado pelo usuário no CodeTown.' } },
    });
    expect(decisionOutput({ status: 'released', reason: 'terminal' }, hookJson())).toBeUndefined();
    expect(decisionOutput({ status: 'pending' }, hookJson())).toBeUndefined();
    expect(decisionOutput(undefined, hookJson())).toBeUndefined();
  });
});
