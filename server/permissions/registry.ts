// Responder pelo escritório: registro dos pedidos de permissão pendentes.
//
// O hook PermissionRequest do Claude Code (mod/habblaud-permissoes/hooks/permission-hook.mjs, pelo plugin
// habblaud-permissoes ou pelo npm run hooks:install) manda cada pedido para POST /api/permissions e fica esperando a decisão em GET /api/permissions/:id/wait (long-poll).
// A página responde em POST /api/permissions/:id/decision. O registro:
// - só aceita o pedido se alguma página local estiver aberta e a sessão for conhecida (senão o hook sai
//   na hora e o terminal segue normal);
// - publica o pedido no agente (AgentInfo.permission, via Office) e avisa no feed;
// - entrega a decisão ao hook (allow/deny) ou o libera sem decisão ("responder no terminal");
// - descarta pedidos órfãos: tempo limite do hook, hook que morreu (sem ninguém esperando), agente que
//   saiu e pedido respondido no próprio terminal (o tool_result aparece no transcript).
import { randomBytes } from 'node:crypto';
import { describeTool, maskSecrets, truncate } from '../../shared/activity';
import type { Activity, AgentInfo, PermissionDecision, PermissionRequestInfo, PermissionSuggestionInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { toolView } from '../sources/terminal';
import { callSignature, scanToolCall } from './transcript';

/** Tempo que o hook espera por padrão (ele manda o próprio em `timeout_ms`). */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
/** Folga depois do tempo limite do hook antes de o pedido sumir sozinho. */
export const EXPIRY_GRACE_MS = 5_000;
/** Resposta mais longa de um long-poll (o hook pergunta de novo em seguida). */
export const WAIT_MAX_MS = 25_000;
/** Sem nenhum hook esperando há este tempo = o hook morreu (cancelado, tempo esgotado, sessão interrompida). */
export const ORPHAN_MS = 8_000;
/** Decisão guardada para o hook que estava entre duas esperas vir buscar. */
export const RESOLVED_KEEP_MS = 30_000;
/** Intervalo mínimo entre conferências do transcript de um pedido. */
export const SCAN_EVERY_MS = 1_000;
/** Principal que esperava (diálogo aberto) e deixou de esperar há este tempo: respondeu no terminal. */
export const LEFT_WAITING_MS = 3_000;
export const MAX_PENDING = 32;
/** Ferramentas que o hook não manda: a resposta é uma escolha do usuário, não aprovar/recusar. */
export const UNSUPPORTED_TOOLS = new Set(['AskUserQuestion']);

const DESTINATIONS = new Set(['session', 'localSettings', 'projectSettings', 'userSettings']);
const MAX_SUGGESTIONS = 4;
const MAX_MESSAGE = 1_000;
const RULE_MAX = 160;

/** O que o registro usa do Office (interface mínima: facilita os testes). */
export interface OfficeLike {
  get(id: string): AgentInfo | undefined;
  list(): AgentInfo[];
  markDirty(): void;
  addActivity(id: string, activity: Activity, current: boolean, opts?: { feed?: boolean }): void;
  /** Aviso "pede permissão" (mesmo dedupe do aviso "precisa de você" do status). */
  noticePermission(id: string, what: string): void;
}

export interface RegistryOptions {
  office: OfficeLike;
  /** Páginas locais conectadas (Hub.localSize): sem nenhuma, o pedido não é desviado do terminal. */
  viewers: () => number;
  /** Transcript de um agente presente (ClaudeWatcher.transcriptPathOf). */
  transcriptPathOf?: (agentId: string) => string | undefined;
  /** Decisão para um pedido fictício do demo (Office.decideDemoPermission); true = era do demo. */
  demoDecide?: (id: string, d: PermissionDecision) => boolean;
  /** Detalhe de um pedido fictício do demo (o snapshot já o traz). */
  demoDetail?: (id: string) => PermissionRequestInfo | undefined;
  now?: () => number;
  /** Intervalo do relógio interno (start). */
  tickMs?: number;
  orphanMs?: number;
  resolvedKeepMs?: number;
  maxPending?: number;
}

export type SkipReason = 'no-viewers' | 'unknown-session' | 'unsupported-tool' | 'too-many';
export type RegisterResult = { id: string; expiresAt: number } | { skip: SkipReason };
export type ReleaseReason = 'terminal' | 'answered' | 'expired' | 'orphan' | 'gone' | 'shutdown';

/** Resposta de uma espera do hook. */
export type WaitResult =
  | { status: 'pending' }
  | { status: 'decided'; behavior: 'allow' | 'deny'; message?: string; interrupt?: boolean; suggestion?: number }
  | { status: 'released'; reason: ReleaseReason };

export type DecideResult = 'ok' | 'not-found' | 'conflict' | 'invalid';

/** Erro de validação do corpo vindo do hook (vira 400). */
export class InvalidRequest extends Error {}

interface Waiter {
  done: (r: WaitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Pending {
  /** Versão completa (com `input`): GET /api/permissions/:id. */
  info: PermissionRequestInfo;
  agentId: string;
  sessionId: string;
  /** agent_id do hook (pedido de subagente). */
  hookAgentId?: string;
  signature: string;
  toolUseId?: string;
  lastScanAt: number;
  /** O registro de sessões já mostrou o principal esperando (o diálogo abriu no terminal). */
  sawWaiting?: boolean;
  /** Desde quando ele deixou de esperar (depois de ter esperado). */
  notWaitingSince?: number;
  waiters: Set<Waiter>;
  /** Desde quando não há hook esperando. */
  idleSince: number;
  outcome?: Exclude<WaitResult, { status: 'pending' }>;
  resolvedAt?: number;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Agente que ainda pode receber um pedido (não saiu nem concluiu). */
function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

/** "Bash(npm test:*)" a partir de {toolName, ruleContent}. */
function ruleText(raw: unknown): string | undefined {
  const r = rec(raw);
  const tool = shortStr(r?.toolName, 200);
  if (!tool) return undefined;
  const content = typeof r?.ruleContent === 'string' && r.ruleContent.trim() ? r.ruleContent : undefined;
  return truncate(maskSecrets(content ? `${tool}(${content})` : tool), RULE_MAX);
}

/**
 * Sugestões "sempre permitir" que o Promp IA oferece: só `addRules` com `behavior: "allow"` num destino
 * conhecido. A página escolhe pela posição e o hook aplica a sugestão ORIGINAL que recebeu do Claude Code
 * (o servidor nunca inventa regras).
 */
export function pickSuggestions(raw: unknown): PermissionSuggestionInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionSuggestionInfo[] = [];
  raw.forEach((s, index) => {
    const r = rec(s);
    if (!r || r.type !== 'addRules' || r.behavior !== 'allow' || typeof r.destination !== 'string' || !DESTINATIONS.has(r.destination)) return;
    const rules = Array.isArray(r.rules) ? r.rules.map(ruleText).filter((x): x is string => !!x) : [];
    if (!rules.length || out.length >= MAX_SUGGESTIONS) return;
    out.push({ index, rules: rules.slice(0, 4), destination: r.destination });
  });
  return out;
}

/**
 * Põe o pedido pendente no agente do snapshot (cópia já clonada pelo Office). Enquanto há pedido, o agente
 * aparece como 'waiting' — inclusive o subagente em segundo plano, cujo diálogo só aparece no terminal
 * depois que o hook responde (o registro de sessões do Claude Code não diz que ele espera).
 */
export function applyPermission(a: AgentInfo, p: PermissionRequestInfo | undefined): AgentInfo {
  if (!p || !present(a)) return a;
  a.permission = p;
  if (a.status !== 'waiting') {
    a.status = 'waiting';
    a.statusSince = p.createdAt;
  }
  a.waitingFor ??= 'aprovar uma permissão';
  return a;
}

/** Valida o JSON do hook (o mesmo que o Claude Code entrega no stdin, com `timeout_ms` do hook). */
export function parseHookInput(raw: unknown): {
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  tool: string;
  input: Rec;
  suggestions: unknown;
  timeoutMs: number;
} {
  const r = rec(raw);
  const sessionId = shortStr(r?.session_id, 200);
  const tool = shortStr(r?.tool_name, 200);
  if (!r || !sessionId || !tool) throw new InvalidRequest('esperado o JSON do hook PermissionRequest (session_id e tool_name)');
  const t = typeof r.timeout_ms === 'number' && Number.isFinite(r.timeout_ms) ? r.timeout_ms : DEFAULT_TIMEOUT_MS;
  return {
    sessionId,
    agentId: shortStr(r.agent_id, 200),
    agentType: shortStr(r.agent_type, 120),
    cwd: shortStr(r.cwd, 4_096),
    tool,
    input: rec(r.tool_input) ?? {},
    suggestions: r.permission_suggestions,
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, t)),
  };
}

/** Corpo de uma decisão vinda da página. */
export function parseDecision(raw: unknown): PermissionDecision | undefined {
  const r = rec(raw);
  if (!r || (r.behavior !== 'allow' && r.behavior !== 'deny' && r.behavior !== 'terminal')) return undefined;
  const d: PermissionDecision = { behavior: r.behavior };
  if (r.behavior === 'deny') {
    if (typeof r.message === 'string' && r.message.trim()) d.message = r.message.trim().slice(0, MAX_MESSAGE);
    if (r.interrupt === true) d.interrupt = true;
  }
  if (r.behavior === 'allow' && r.suggestion !== undefined) {
    if (typeof r.suggestion !== 'number' || !Number.isInteger(r.suggestion) || r.suggestion < 0) return undefined;
    d.suggestion = r.suggestion;
  }
  return d;
}

export class PermissionRegistry {
  private pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly orphanMs: number;
  private readonly resolvedKeepMs: number;
  private readonly maxPending: number;

  constructor(private readonly opts: RegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.orphanMs = opts.orphanMs ?? ORPHAN_MS;
    this.resolvedKeepMs = opts.resolvedKeepMs ?? RESOLVED_KEEP_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`permissions-tick:${errMsg(err)}`, `Pedidos de permissão: falha no relógio (${errMsg(err)}).`);
      }
    }, this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  /** Para o relógio e libera quem estiver esperando (o hook sai sem decidir). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.pending.values()) if (!p.outcome) this.release(p, 'shutdown');
  }

  /** Pedidos em aberto (sem decisão). */
  get size(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.outcome) n++;
    return n;
  }

  /**
   * Registra um pedido vindo do hook. `{skip}` = não desviar (o hook sai na hora e o terminal segue):
   * ninguém olhando, sessão desconhecida, ferramenta que não se aprova/recusa ou pedidos demais.
   * Corpo inválido: lança InvalidRequest.
   */
  register(raw: unknown): RegisterResult {
    const req = parseHookInput(raw);
    if (UNSUPPORTED_TOOLS.has(req.tool)) return { skip: 'unsupported-tool' };
    if (this.opts.viewers() <= 0) return { skip: 'no-viewers' };
    const target = this.resolveAgent(req.sessionId, req.agentId, req.agentType);
    if (!target) return { skip: 'unknown-session' };
    if (this.size >= this.maxPending) return { skip: 'too-many' };

    const now = this.now();
    const id = `p-${now.toString(36)}-${++this.seq}-${randomBytes(9).toString('base64url')}`;
    const view = toolView(req.tool, req.input, req.cwd);
    const desc = describeTool(req.tool, req.input);
    const info: PermissionRequestInfo = { id, tool: req.tool, title: view.title, text: desc.text, icon: desc.icon, createdAt: now, expiresAt: now + req.timeoutMs };
    if (view.input) info.input = view.input;
    if (view.inputKind) info.inputKind = view.inputKind;
    if (target.subagent) info.subagent = target.subagent;
    const suggestions = pickSuggestions(req.suggestions);
    if (suggestions.length) info.suggestions = suggestions;

    const p: Pending = {
      info,
      agentId: target.id,
      sessionId: req.sessionId,
      signature: callSignature(req.tool, req.input),
      lastScanAt: 0,
      waiters: new Set(),
      idleSince: now,
    };
    if (req.agentId) p.hookAgentId = req.agentId;
    this.pending.set(id, p);

    const by = target.subagent ? ` (subagente ${target.subagent})` : '';
    this.opts.office.addActivity(target.id, { id: `${target.id}#perm:${id}`, at: now, kind: 'wait', icon: '🔐', text: truncate(`Pede permissão: ${desc.text}`, 46), detail: view.title, tool: 'PermissionRequest' }, false);
    this.opts.office.noticePermission(target.id, `${desc.text}${by}`);
    this.opts.office.markDirty();
    return { id, expiresAt: info.expiresAt + EXPIRY_GRACE_MS };
  }

  /** Detalhe completo de um pedido em aberto (com os argumentos), ou undefined. */
  detail(id: string): PermissionRequestInfo | undefined {
    const p = this.pending.get(id);
    if (p && !p.outcome) return { ...p.info, ...this.queueOf(p) };
    return this.opts.demoDetail?.(id);
  }

  /**
   * Pedido mais antigo de cada agente (sem `input`, que só sai pelo detalhe), com quantos esperam depois
   * dele. É o que o Office põe no snapshot.
   */
  snapshot(): Map<string, PermissionRequestInfo> {
    const out = new Map<string, PermissionRequestInfo>();
    const counts = new Map<string, number>();
    for (const p of this.pending.values()) {
      if (p.outcome) continue;
      counts.set(p.agentId, (counts.get(p.agentId) ?? 0) + 1);
      if (out.has(p.agentId)) continue;
      const { input: _input, inputKind: _kind, ...info } = p.info;
      out.set(p.agentId, info);
    }
    for (const [agentId, info] of out) {
      const n = (counts.get(agentId) ?? 1) - 1;
      if (n > 0) info.queued = n;
    }
    return out;
  }

  /**
   * Espera a decisão de um pedido por até `ms`. undefined = id desconhecido (o hook desiste). `cancel`
   * desliga a espera (conexão fechada). Uma decisão já tomada volta na hora.
   */
  wait(id: string, ms: number): { result: Promise<WaitResult>; cancel: () => void } | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    if (p.outcome) {
      const outcome = p.outcome;
      // Entregue: não precisa mais guardar.
      this.pending.delete(id);
      return { result: Promise.resolve(outcome), cancel: () => {} };
    }
    let waiter: Waiter | undefined;
    const result = new Promise<WaitResult>((done) => {
      const timer = setTimeout(() => this.dropWaiter(p, waiter!, { status: 'pending' }), Math.max(0, Math.min(ms, WAIT_MAX_MS)));
      timer.unref?.();
      waiter = { done, timer };
      p.waiters.add(waiter);
    });
    return { result, cancel: () => waiter && this.dropWaiter(p, waiter) };
  }

  /** Decisão da página. Pedido do demo vai para `demoDecide`. */
  decide(id: string, d: PermissionDecision): DecideResult {
    const p = this.pending.get(id);
    if (!p) return this.opts.demoDecide?.(id, d) ? 'ok' : 'not-found';
    if (p.outcome) return 'conflict';
    if (d.suggestion !== undefined && !p.info.suggestions?.some((s) => s.index === d.suggestion)) return 'invalid';
    if (d.behavior === 'terminal') {
      this.release(p, 'terminal');
      return 'ok';
    }
    const outcome: WaitResult = { status: 'decided', behavior: d.behavior };
    if (d.message) outcome.message = d.message;
    if (d.interrupt) outcome.interrupt = true;
    if (d.suggestion !== undefined) outcome.suggestion = d.suggestion;
    this.resolve(p, outcome);
    const now = this.now();
    const act: Activity =
      d.behavior === 'allow'
        ? { id: `${p.agentId}#perm-ok:${id}`, at: now, kind: 'other', icon: '✅', text: d.suggestion !== undefined ? 'Aprovado no Promp IA (sempre permitir)' : 'Aprovado no Promp IA', detail: p.info.title, tool: 'PermissionRequest' }
        : { id: `${p.agentId}#perm-no:${id}`, at: now, kind: 'wait', icon: '🚫', text: 'Recusado no Promp IA', detail: d.message ? `${p.info.title} — ${d.message}` : p.info.title, tool: 'PermissionRequest' };
    this.opts.office.addActivity(p.agentId, act, false);
    return 'ok';
  }

  /** Relógio: expiração, órfãos, agente que saiu, resposta no terminal e limpeza das decisões entregues. */
  tick(): void {
    const now = this.now();
    for (const [id, p] of this.pending) {
      if (p.outcome) {
        if (now - (p.resolvedAt ?? now) >= this.resolvedKeepMs) this.pending.delete(id);
        continue;
      }
      if (now >= p.info.expiresAt + EXPIRY_GRACE_MS) this.release(p, 'expired');
      else if (!p.waiters.size && now - p.idleSince >= this.orphanMs) this.release(p, 'orphan');
      else if (!present(this.opts.office.get(p.agentId))) this.release(p, 'gone');
      else if (now - p.lastScanAt >= SCAN_EVERY_MS && this.answeredInTerminal(p, now)) this.release(p, 'answered');
      else if (this.leftWaiting(p, now)) this.release(p, 'answered');
    }
  }

  // ---------------------------------------------------------------- internos

  private resolveAgent(sessionId: string, agentId?: string, agentType?: string): { id: string; subagent?: string } | undefined {
    const office = this.opts.office;
    if (agentId) {
      const subId = `${sessionId}:${agentId}`;
      if (present(office.get(subId))) return { id: subId };
    }
    const main = office.list().find((a) => a.kind === 'main' && a.sessionId === sessionId && a.status !== 'offline');
    if (!main) return undefined;
    return agentId ? { id: main.id, subagent: agentType ?? 'subagente' } : { id: main.id };
  }

  private queueOf(p: Pending): { queued?: number } {
    let n = 0;
    for (const o of this.pending.values()) if (o !== p && !o.outcome && o.agentId === p.agentId && o.info.createdAt >= p.info.createdAt) n++;
    return n ? { queued: n } : {};
  }

  /** O tool_result da chamada apareceu no transcript (respondido no terminal)? Nunca lança. */
  private answeredInTerminal(p: Pending, now: number): boolean {
    p.lastScanAt = now;
    // Subagente que o Promp IA não acompanha (pedido mostrado no principal): o transcript dele não é
    // conhecido e o do principal não tem a chamada; sobram a expiração e o órfão.
    if (p.hookAgentId && p.agentId !== `${p.sessionId}:${p.hookAgentId}`) return false;
    const path = this.opts.transcriptPathOf?.(p.agentId);
    if (!path) return false;
    try {
      const r = scanToolCall(path, { tool: p.info.tool, signature: p.signature, knownId: p.toolUseId, createdAt: p.info.createdAt });
      if (r.toolUseId) p.toolUseId = r.toolUseId;
      return r.answered;
    } catch {
      return false;
    }
  }

  /**
   * Plano B da resposta no terminal, só para pedidos do principal cuja chamada não foi achada no
   * transcript: o registro de sessões mostrou o diálogo aberto ('waiting') e depois deixou de mostrar
   * por LEFT_WAITING_MS. (Com a chamada achada, vale só o tool_result: pedidos em sequência do mesmo
   * agente passam por 'busy' entre um diálogo e outro.)
   */
  private leftWaiting(p: Pending, now: number): boolean {
    if (p.hookAgentId || p.toolUseId) return false;
    const a = this.opts.office.get(p.agentId);
    if (a?.kind !== 'main') return false;
    if (a.status === 'waiting') {
      p.sawWaiting = true;
      delete p.notWaitingSince;
      return false;
    }
    if (!p.sawWaiting) return false;
    p.notWaitingSince ??= now;
    return now - p.notWaitingSince >= LEFT_WAITING_MS;
  }

  private dropWaiter(p: Pending, w: Waiter, result?: WaitResult): void {
    if (!p.waiters.delete(w)) return;
    clearTimeout(w.timer);
    if (!p.waiters.size) p.idleSince = this.now();
    if (result) w.done(result);
  }

  private resolve(p: Pending, outcome: Exclude<WaitResult, { status: 'pending' }>): void {
    p.outcome = outcome;
    p.resolvedAt = this.now();
    const delivered = p.waiters.size > 0;
    for (const w of [...p.waiters]) this.dropWaiter(p, w, outcome);
    // Entregue a quem esperava: some já; senão fica guardado até o hook voltar (ou RESOLVED_KEEP_MS).
    if (delivered) this.pending.delete(p.info.id);
    this.opts.office.markDirty();
  }

  private release(p: Pending, reason: ReleaseReason): void {
    this.resolve(p, { status: 'released', reason });
  }
}
