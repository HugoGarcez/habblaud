// Agentes do Orca (https://github.com/stablyai/orca): Codex, OpenCode, Antigravity, Gemini… rodando nos
// terminais do Orca viram personagens, na sala do worktree. O Claude Code fica com o ClaudeWatcher (transcripts),
// que sabe muito mais; daqui só vem quem não é Claude.
//
// Fonte: a CLI do próprio Orca, a cada ~2 s —
//   orca worktree ps --json     worktrees e o status de cada agente (estado, prompt, ferramenta atual)
//   orca terminal list --json   terminais vivos (o paneKey do agente é "<tabId>:<leafId>")
// O Orca guarda o último status de painéis já fechados: só entra quem tem o terminal aberto e, se está parado,
// teve atividade nas últimas horas (HABBLAUD_ORCA_IDLE_MIN).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describeCommand, describePrompt, describeTool, SPECIAL, truncate, type ActivityDescription } from '../../shared/activity';
import { hash32 } from '../../shared/hash';
import type { AccountInfo, AccountUsage, AgentStatus, SourceInfo } from '../../shared/types';
import { rollover, STALE_AFTER_MS } from '../accounts/usage';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';

/** Uso de 5 h/semanal de uma conta (ou grupo de modelos) de outro agente: Codex, Antigravity… */
export interface ExternalUsage {
  /** Tipo de agente do Orca dono da conta ('codex', 'antigravity'…). */
  agentType: string;
  /** Rótulo da conta/grupo ("~/.codex", "Gemini"…), único dentro do tipo. */
  label: string;
  /** O rótulo vai no nome do cartão também no principal (ex.: "Antigravity · Gemini"). */
  labelInName?: boolean;
  /** Onde os números foram lidos (vai na dica do cartão). */
  configDir: string;
  usage: AccountUsage;
}

export interface OrcaAgent {
  paneKey: string;
  parentPaneKey?: string;
  agentType: string;
  state: string;
  prompt?: string;
  taskTitle?: string;
  lastAssistantMessage?: string;
  toolName?: string;
  toolInput?: string;
  interrupted?: boolean;
  stateStartedAt?: number;
  updatedAt?: number;
  /** Caminho do worktree (= sala). */
  cwd: string;
  branch?: string;
}

/** Tipo de agente do Orca -> conta exibida no Habblaud (chip colorido com a sigla). */
const AGENT_KINDS: Record<string, { name: string; short: string; color: string }> = {
  codex: { name: 'Codex', short: 'CX', color: '#10a37f' },
  opencode: { name: 'OpenCode', short: 'OC', color: '#f5a623' },
  antigravity: { name: 'Antigravity', short: 'AG', color: '#4285f4' },
  gemini: { name: 'Gemini', short: 'GM', color: '#8e75ff' },
  cursor: { name: 'Cursor', short: 'CU', color: '#e8e8e8' },
  amp: { name: 'Amp', short: 'AM', color: '#f34e3f' },
  droid: { name: 'Droid', short: 'DR', color: '#ff7a00' },
  devin: { name: 'Devin', short: 'DV', color: '#2bb673' },
};
const OTHER_COLORS = ['#e06c9f', '#5cc97b', '#c9a35c', '#5cb8c9'];

export const ORCA_ACCOUNT_PREFIX = 'orca:';

export function orcaAccountId(agentType: string): string {
  return `${ORCA_ACCOUNT_PREFIX}${agentType}`;
}

export function agentKind(agentType: string): { name: string; short: string; color: string } {
  const known = AGENT_KINDS[agentType];
  if (known) return known;
  const name = agentType ? agentType[0].toUpperCase() + agentType.slice(1) : 'Agente';
  return { name, short: name.slice(0, 2).toUpperCase(), color: OTHER_COLORS[hash32(agentType) % OTHER_COLORS.length] };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Resultado de `orca worktree ps --json` -> agentes, cada um com o caminho do seu worktree. */
export function parseWorktreePs(raw: unknown): OrcaAgent[] {
  const result = (raw as { result?: { worktrees?: unknown } })?.result;
  const worktrees = Array.isArray(result?.worktrees) ? (result.worktrees as Array<Record<string, unknown>>) : [];
  const out: OrcaAgent[] = [];
  for (const w of worktrees) {
    const cwd = str(w.path);
    if (!cwd || w.isArchived === true) continue;
    const branch = str(w.branch)?.replace(/^refs\/heads\//, '');
    for (const a of Array.isArray(w.agents) ? (w.agents as Array<Record<string, unknown>>) : []) {
      const paneKey = str(a.paneKey);
      const agentType = str(a.agentType);
      const state = str(a.state);
      if (!paneKey || !agentType || !state) continue;
      const agent: OrcaAgent = { paneKey, agentType, state, cwd };
      if (branch) agent.branch = branch;
      const parent = str(a.parentPaneKey);
      if (parent) agent.parentPaneKey = parent;
      for (const k of ['prompt', 'taskTitle', 'lastAssistantMessage', 'toolName', 'toolInput'] as const) {
        const v = str(a[k]);
        if (v) agent[k] = v;
      }
      if (a.interrupted === true) agent.interrupted = true;
      const since = num(a.stateStartedAt);
      if (since !== undefined) agent.stateStartedAt = since;
      const upd = num(a.updatedAt);
      if (upd !== undefined) agent.updatedAt = upd;
      out.push(agent);
    }
  }
  return out;
}

/** Resultado de `orca terminal list --json` -> paneKeys ("<tabId>:<leafId>") dos terminais vivos. */
export function parseLivePanes(raw: unknown): Set<string> {
  const result = (raw as { result?: { terminals?: unknown } })?.result;
  const terms = Array.isArray(result?.terminals) ? (result.terminals as Array<Record<string, unknown>>) : [];
  const out = new Set<string>();
  for (const t of terms) {
    const tab = str(t.tabId);
    const leaf = str(t.leafId);
    if (tab && leaf && t.orphaned !== true) out.add(`${tab}:${leaf}`);
  }
  return out;
}

const ACTIVE_STATES = new Set(['working', 'monitoring', 'thinking', 'running', 'blocked', 'waiting', 'permission']);

/** Estado do Orca -> status do personagem. */
export function orcaStatus(a: Pick<OrcaAgent, 'state' | 'toolName'>): { status: AgentStatus; waitingFor?: string } {
  switch (a.state) {
    case 'working':
    case 'monitoring':
    case 'thinking':
    case 'running':
      return { status: 'working' };
    case 'blocked':
    case 'permission':
      return { status: 'waiting', waitingFor: a.toolName ? `aprovar ${truncate(a.toolName, 24)}` : 'aprovar uma permissão' };
    case 'waiting':
      return { status: 'waiting', waitingFor: 'responder no terminal' };
    default:
      // done, idle, error, interrupted, unverifiable…
      return { status: 'idle' };
  }
}

/** Está no escritório: terminal aberto e (trabalhando/esperando ou com atividade há menos de `idleMaxMs`). */
export function isPresent(a: OrcaAgent, live: ReadonlySet<string>, now: number, idleMaxMs: number): boolean {
  if (!live.has(a.paneKey)) return false;
  if (ACTIVE_STATES.has(a.state)) return true;
  const last = a.updatedAt ?? a.stateStartedAt;
  return last !== undefined && now - last < idleMaxMs;
}

/**
 * Ferramenta de qualquer agente -> atividade. Os nomes do Codex/OpenCode/Gemini viram os equivalentes do
 * Claude Code (o Orca entrega a entrada já como texto: comando, caminho ou padrão).
 */
export function describeOrcaTool(name: string, input?: string): ActivityDescription {
  const n = name.toLowerCase().replace(/[\s-]+/g, '_');
  const text = input ?? '';
  if (/^(bash|shell|exec|exec_command|run_shell_command|run_command|local_shell|terminal|command|unified_exec)$/.test(n))
    return describeCommand(text);
  if (/^(read|read_file|view|cat|open_file|read_many_files)$/.test(n)) return describeTool('Read', { file_path: text });
  if (/^(edit|replace|str_replace|apply_patch|patch|multiedit|multi_edit|edit_file)$/.test(n)) {
    const file = text.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/)?.[1] ?? text.split('\n')[0];
    return describeTool('Edit', { file_path: file });
  }
  if (/^(write|write_file|create|create_file)$/.test(n)) return describeTool('Write', { file_path: text });
  if (/^(grep|search|search_file_content|rg|codebase_search)$/.test(n)) return describeTool('Grep', { pattern: text });
  if (/^(glob|find|list|ls|list_directory|list_dir)$/.test(n)) return describeTool('Glob', { pattern: text || 'arquivos' });
  if (/^(webfetch|web_fetch|fetch)$/.test(n)) return describeTool('WebFetch', { url: text });
  if (/^(websearch|web_search|google_web_search)$/.test(n)) return describeTool('WebSearch', { query: text });
  if (/^(todowrite|todo_write|todoread|update_plan|plan)$/.test(n)) return describeTool('TodoWrite', {});
  if (/^(task|agent|spawn_agent)$/.test(n)) return describeTool('Agent', { description: text });
  // Nome no formato do Claude Code (Read, Bash…) ou desconhecido: o tradutor geral decide.
  const d = describeTool(name, { command: text, file_path: text, pattern: text, query: text, url: text, description: text });
  return d;
}

/** Acha a CLI do Orca: HABBLAUD_ORCA_BIN, o PATH ou o app instalado (macOS). */
export function findOrcaBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HABBLAUD_ORCA_BIN) return env.HABBLAUD_ORCA_BIN;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'orca'))) return join(dir, 'orca');
  }
  for (const p of ['/Applications/Orca.app/Contents/Resources/bin/orca', join(env.HOME ?? '', 'Applications/Orca.app/Contents/Resources/bin/orca')]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface OrcaWatcherOptions {
  office: Office;
  /** Caminho da CLI (ausente = fonte desligada). */
  bin?: string;
  /** Roda a CLI e devolve o stdout (testes). */
  run?: (args: string[]) => Promise<string>;
  now?: () => number;
  pollMs?: number;
  /** Quanto tempo um agente parado continua no escritório depois da última atividade (padrão 3 h). */
  idleMaxMs?: number;
  /** Tipos de agente ignorados (padrão: claude, que vem dos transcripts). */
  skipTypes?: string[];
  /**
   * Uso de 5 h/semanal das contas de outros agentes (antigravity-usage.ts). Por tipo, a primeira
   * entrada vai no cartão dos agentes ("orca:<tipo>"); as outras ganham cartão próprio.
   */
  usage?: () => ExternalUsage[];
}

interface Tracked {
  agentType: string;
  kind: 'main' | 'sub';
  prompt?: string;
  toolKey?: string;
  lastMessage?: string;
}

function withUsage(acc: AccountInfo, e: ExternalUsage, now: number): AccountInfo {
  acc.usage = rollover(e.usage, now);
  acc.usageStatus = now - e.usage.fetchedAt > STALE_AFTER_MS ? 'stale' : 'ok';
  acc.configDir = e.configDir;
  return acc;
}

export class OrcaWatcher {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private tracked = new Map<string, Tracked>();
  private types = new Set<string>();
  private info: SourceInfo;
  private readonly now: () => number;
  private readonly run: (args: string[]) => Promise<string>;
  private readonly skip: Set<string>;
  private readonly idleMaxMs: number;

  constructor(private readonly opts: OrcaWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.skip = new Set(opts.skipTypes ?? ['claude']);
    this.idleMaxMs = opts.idleMaxMs ?? 3 * 3_600_000;
    const bin = opts.bin;
    this.run =
      opts.run ??
      ((args) =>
        new Promise((resolve, reject) => {
          if (!bin) return reject(new Error('CLI do Orca não encontrada'));
          execFile(bin, args, { timeout: 8_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
        }));
    this.info = { label: 'orca', path: bin ?? 'orca', sessions: 0, ok: false };
  }

  get enabled(): boolean {
    return !!(this.opts.bin || this.opts.run);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  sources(): SourceInfo[] {
    return this.enabled ? [{ ...this.info }] : [];
  }

  /**
   * Contas "virtuais", uma por tipo de agente visto (Codex, OpenCode…), com o nº de sessões abertas, e o uso de
   * 5 h/semanal de quem tem (ver OrcaWatcherOptions.usage).
   */
  accounts(sessions: ReadonlyMap<string, number>): AccountInfo[] {
    const now = this.now();
    const byType = new Map<string, ExternalUsage[]>();
    for (const e of this.opts.usage?.() ?? []) byType.set(e.agentType, [...(byType.get(e.agentType) ?? []), e]);
    const types = new Set([...this.types, ...byType.keys()]);
    const out: AccountInfo[] = [];
    for (const t of [...types].sort()) {
      const k = agentKind(t);
      const id = orcaAccountId(t);
      const [first, ...rest] = byType.get(t) ?? [];
      const name = first?.labelInName ? `${k.name} · ${first.label}` : k.name;
      const acc: AccountInfo = { id, short: k.short, name, color: k.color, configDir: 'Orca', sessions: sessions.get(id) ?? 0, usageStatus: 'disabled' };
      out.push(first ? withUsage(acc, first, now) : acc);
      for (const e of rest) {
        const extra: AccountInfo = { id: `${id}~${e.label}`, short: k.short, name: `${k.name} · ${e.label}`, color: k.color, configDir: e.configDir, sessions: 0, usageStatus: 'disabled' };
        out.push(withUsage(extra, e, now));
      }
    }
    return out;
  }

  accountName(id: string): string | undefined {
    return id.startsWith(ORCA_ACCOUNT_PREFIX) ? agentKind(id.slice(ORCA_ACCOUNT_PREFIX.length).split('~')[0]).name : undefined;
  }

  /** Uma rodada: lê a CLI e aplica no escritório. Exposto para os testes. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const [ps, terms] = await Promise.all([
        this.run(['worktree', 'ps', '--json', '--limit', '500']),
        this.run(['terminal', 'list', '--json', '--limit', '1000']),
      ]);
      this.apply(parseWorktreePs(JSON.parse(ps)), parseLivePanes(JSON.parse(terms)));
      if (!this.info.ok) log.info('   Orca: lendo os agentes dos terminais do Orca.');
      this.info = { ...this.info, ok: true };
      delete this.info.error;
    } catch (err) {
      const msg = errMsg(err);
      if (this.info.ok || this.info.error === undefined) log.warnOnce(`orca:${msg}`, `Orca: não deu para ler os agentes (${msg}).`);
      this.info = { ...this.info, ok: false, error: truncate(msg, 120) };
    } finally {
      this.busy = false;
    }
  }

  apply(agents: OrcaAgent[], live: ReadonlySet<string>): void {
    const office = this.opts.office;
    const now = this.now();
    const present = agents.filter((a) => !this.skip.has(a.agentType) && isPresent(a, live, now, this.idleMaxMs));
    const keep = new Set<string>();
    // Principais antes dos subagentes (o pai precisa existir).
    const ordered = [...present].sort((a, b) => Number(!!a.parentPaneKey) - Number(!!b.parentPaneKey));
    for (const a of ordered) {
      const id = `orca:${a.paneKey}`;
      const parentId = a.parentPaneKey ? `orca:${a.parentPaneKey}` : undefined;
      const { status, waitingFor } = orcaStatus(a);
      const kind = agentKind(a.agentType);
      this.types.add(a.agentType);
      let t = this.tracked.get(id);
      if (!t || !office.has(id)) {
        const startedAt = a.stateStartedAt ?? a.updatedAt ?? now;
        if (parentId && office.has(parentId)) {
          if (!office.addSub({ id, parentId, sessionId: a.paneKey, role: kind.name, title: a.taskTitle ?? a.prompt, background: false, startedAt })) continue;
          t = { agentType: a.agentType, kind: 'sub' };
        } else {
          office.addMain({ id, account: orcaAccountId(a.agentType), sessionId: a.paneKey, cwd: a.cwd, role: kind.name, startedAt, status, waitingFor });
          t = { agentType: a.agentType, kind: 'main' };
        }
        this.tracked.set(id, t);
      }
      keep.add(id);
      if (t.kind === 'main') office.setStatus(id, status, waitingFor);
      else if (status === 'idle') office.completeSub(id);
      else office.reactivateSub(id);
      this.applyActivity(id, t, a, now);
      office.applyTranscript(id, {
        title: a.taskTitle ?? (a.prompt ? truncate(a.prompt, 60) : undefined),
        tasks: [],
        stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
        model: kind.name,
        gitBranch: a.branch,
        lastAt: a.updatedAt,
      });
    }
    for (const [id, t] of [...this.tracked]) {
      if (keep.has(id)) continue;
      if (t.kind === 'main') office.closeMain(id);
      else office.completeSub(id, { notify: false });
      this.tracked.delete(id);
    }
    const sessions = [...keep].filter((id) => this.tracked.get(id)?.kind === 'main').length;
    if (sessions !== this.info.sessions) {
      this.info = { ...this.info, sessions };
      office.markDirty();
    }
  }

  /** Prompt novo, ferramenta nova, resposta final: cada mudança vira uma atividade. */
  private applyActivity(id: string, t: Tracked, a: OrcaAgent, now: number): void {
    const office = this.opts.office;
    const at = Math.min(now, a.updatedAt ?? now);
    if (a.prompt && a.prompt !== t.prompt) {
      const first = t.prompt === undefined;
      t.prompt = a.prompt;
      office.addActivity(id, { id: `${id}#prompt:${hash32(a.prompt)}:${a.stateStartedAt ?? ''}`, at: a.stateStartedAt ?? at, ...describePrompt(a.prompt) }, true, {
        feed: !first,
      });
    }
    const toolKey = a.toolName ? `${a.toolName}|${a.toolInput ?? ''}` : undefined;
    if (toolKey && toolKey !== t.toolKey && (a.state === 'working' || a.state === 'blocked' || a.state === 'monitoring')) {
      t.toolKey = toolKey;
      const d = describeOrcaTool(a.toolName!, a.toolInput);
      office.addActivity(id, { id: `${id}#tool:${hash32(toolKey)}:${at}`, at, tool: a.toolName, ...d }, true);
    }
    if (a.state === 'error' && t.lastMessage !== `error:${a.updatedAt}`) {
      t.lastMessage = `error:${a.updatedAt}`;
      office.addActivity(id, { id: `${id}#error:${a.updatedAt ?? at}`, at, ...SPECIAL.error(undefined, a.lastAssistantMessage), error: true }, true);
    } else if (a.interrupted && a.state !== 'working' && t.lastMessage !== `int:${a.updatedAt}`) {
      t.lastMessage = `int:${a.updatedAt}`;
      office.addActivity(id, { id: `${id}#int:${a.updatedAt ?? at}`, at, ...SPECIAL.interrupted() }, true);
    }
  }
}
