// Modelo do escritório: agentes (reais e de demonstração), salas, feed e avisos.
// Os observadores de fontes (sources/watcher.ts) chamam os métodos de mutação; o hub SSE
// chama commit() (com throttle) para obter o snapshot novo, o feed e os avisos pendentes.
import type {
  AccountInfo,
  Activity,
  AgentDetail,
  AgentInfo,
  AgentStats,
  AgentStatus,
  FeedItem,
  Notice,
  NoticeLevel,
  OfficeSnapshot,
  RoomInfo,
  SourceInfo,
  TaskItem,
} from '../../shared/types';
import { SPECIAL } from '../../shared/activity';
import { DemoSimulator } from '../../shared/demo/simulator';
import { hash32 } from '../../shared/hash';
import type { NameStore } from './names';
import { normalizeCwd, roomDisplayNames, SlotAllocator } from './rooms';

export const OFFLINE_GRACE_MS = 20_000;
export const DONE_GRACE_MS = 25_000;
export const SLOT_COOLDOWN_MS = 30_000;
export const NOTICE_DEDUPE_MS = 10_000;
const RECENT_LIMIT = 30;
/**
 * Atividades de cada agente que vão no snapshot (SSE). O snapshot inteiro sai a cada mudança, e o
 * `recent` completo era ~87% dele; a linha do tempo longa vem de GET /api/agents/:id e o feed já
 * transmite cada atividade à parte.
 */
export const SNAPSHOT_RECENT = 8;
const HISTORY_LIMIT = 200;
const FEED_LIMIT = 200;

export interface OfficeDeps {
  names: NameStore;
  version: string;
  startedAt: number;
  /** Contas reais, com o nº de sessões abertas de cada uma. */
  accounts: (sessions: ReadonlyMap<string, number>) => AccountInfo[];
  sources: () => SourceInfo[];
  /** Nome amigável da conta (ex.: "Conta D") para os avisos. */
  accountName: (id: string) => string | undefined;
  now?: () => number;
}

/** O que o transcript sabe sobre o agente (aplicado de uma vez). */
export interface TranscriptSummary {
  title?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  model?: string;
  gitBranch?: string;
  permissionMode?: string;
  /** Primeiro evento conhecido (subagentes: o início real, depois de ler o começo do arquivo). */
  firstAt?: number;
  lastAt?: number;
}

export interface MainInput {
  id: string;
  account: string;
  sessionId: string;
  cwd: string;
  role: string;
  startedAt: number;
  status: AgentStatus;
  waitingFor?: string;
}

export interface SubInput {
  id: string;
  parentId: string;
  sessionId: string;
  role: string;
  title?: string;
  background: boolean;
  startedAt: number;
}

interface AgentRecord {
  info: AgentInfo;
  history: Activity[];
  removeAt?: number;
  /** Início do turno atual (para "Concluiu em X"). */
  turnStart?: number;
  /** Atividade "Concluiu" sintetizada pela mudança de status (substituída pela do transcript, se vier). */
  synthDone?: { id: string; at: number };
  /** Atividade "Precisa de você" sintetizada; ao sair da espera, a atividade anterior volta a ser a atual. */
  synthWait?: { id: string; prev?: Activity };
}

export interface CommitResult {
  snapshot: OfficeSnapshot;
  changed: boolean;
  feed: FeedItem[];
  notices: Notice[];
}

type NoticeKind = 'arrive' | 'room' | 'wait' | 'deliver' | 'done' | 'leave';

/** Pergunta ainda sem resposta (o balão dela já diz que o agente espera você). */
function isOpenQuestion(a: Activity | undefined): boolean {
  return a?.kind === 'ask' && a.text !== SPECIAL.answered().text;
}

function zeroStats(): AgentStats {
  return { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 };
}

function cloneAgent(a: AgentInfo): AgentInfo {
  return { ...a, recent: a.recent.slice(), tasks: a.tasks.map((t) => ({ ...t })), stats: { ...a.stats } };
}

export class Office {
  private agents = new Map<string, AgentRecord>();
  private rooms = new Map<string, { path: string; createdAt: number }>();
  private slots = new SlotAllocator(SLOT_COOLDOWN_MS);
  private roomNames = new Map<string, string>();
  private feed: FeedItem[] = [];
  private pendingFeed: FeedItem[] = [];
  private pendingNotices: Notice[] = [];
  private noticeAt = new Map<string, number>();
  private listeners = new Set<() => void>();
  private rev = 0;
  private dirty = true;
  private last: OfficeSnapshot | null = null;
  private demo: DemoSimulator | null = null;
  private demoSnap: OfficeSnapshot | null = null;
  private booting = false;
  private bootFeed: FeedItem[] = [];
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: OfficeDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Avisado (síncrono) sempre que algo muda; o hub decide quando fazer commit(). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  markDirty(): void {
    this.dirty = true;
    this.listeners.forEach((cb) => cb());
  }

  // ---------------------------------------------------------------- boot

  /** Durante o boot: sem avisos; o feed é montado em ordem cronológica no final. */
  beginBoot(): void {
    this.booting = true;
    this.bootFeed = [];
  }

  endBoot(): void {
    this.booting = false;
    const sorted = this.bootFeed.sort((a, b) => a.activity.at - b.activity.at).slice(-FEED_LIMIT);
    this.bootFeed = [];
    this.feed = [...this.feed, ...sorted].slice(-FEED_LIMIT);
    // Quem já estava esperando por você quando o servidor subiu ganha o balão "Precisa de você"
    // (durante o boot nada é sintetizado; sem aviso, porque não é novidade).
    for (const rec of this.agents.values()) {
      const info = rec.info;
      if (info.status !== 'waiting' || rec.synthWait || isOpenQuestion(info.activity)) continue;
      const prev = info.activity;
      const act: Activity = { id: `${info.id}#wait:${++this.seq}`, at: info.statusSince, ...SPECIAL.waiting(info.waitingFor) };
      this.addActivity(info.id, act, true, { feed: false });
      rec.synthWait = prev ? { id: act.id, prev } : { id: act.id };
    }
    this.markDirty();
  }

  // ---------------------------------------------------------------- consultas

  has(id: string): boolean {
    return this.agents.has(id);
  }

  get(id: string): AgentInfo | undefined {
    return this.agents.get(id)?.info;
  }

  /** Agentes reais presentes (inclusive em período de graça). */
  list(): AgentInfo[] {
    return [...this.agents.values()].map((r) => r.info);
  }

  roomName(roomId: string): string {
    return this.roomNames.get(roomId) ?? roomId.split('/').filter(Boolean).pop() ?? roomId;
  }

  detail(id: string): AgentDetail | undefined {
    const rec = this.agents.get(id);
    if (rec) return { agent: cloneAgent(rec.info), history: rec.history.slice() };
    const demo = this.demoSnap?.agents.find((a) => a.id === id);
    return demo ? { agent: cloneAgent(demo), history: demo.recent.slice() } : undefined;
  }

  recentFeed(n: number): FeedItem[] {
    return this.feed.slice(-n);
  }

  isDemo(): boolean {
    return this.demo !== null;
  }

  // ---------------------------------------------------------------- agentes principais

  addMain(p: MainInput): void {
    const now = this.now();
    const existing = this.agents.get(p.id);
    if (existing) {
      // Sessão que voltou durante o período de graça.
      delete existing.removeAt;
      this.setStatus(p.id, p.status, p.waitingFor);
      return;
    }
    const roomId = normalizeCwd(p.cwd);
    this.ensureRoom(roomId, now);
    const person = this.deps.names.assign(p.sessionId, this.usedNames());
    const info: AgentInfo = {
      id: p.id,
      kind: 'main',
      roomId,
      name: person.name,
      look: person.look,
      role: p.role,
      sessionId: p.sessionId,
      account: p.account,
      status: p.status,
      recent: [],
      tasks: [],
      startedAt: p.startedAt,
      lastEventAt: p.startedAt,
      statusSince: now,
      stats: zeroStats(),
      seed: hash32(p.id),
    };
    if (p.status === 'waiting') info.waitingFor = p.waitingFor ?? 'responder no terminal';
    const rec: AgentRecord = { info, history: [] };
    if (p.status === 'working') rec.turnStart = now;
    this.agents.set(p.id, rec);
    const acc = this.deps.accountName(p.account);
    this.notice('arrive', p.id, 'info', `👋 ${info.name} chegou em ${this.roomName(roomId)}${acc ? ` (${acc})` : ''}`, roomId);
    this.markDirty();
  }

  /** Mesmo processo, sessão nova (/clear, /resume): o personagem continua, tarefas e números zeram. */
  switchSession(id: string, sessionId: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.sessionId === sessionId) return;
    const info = rec.info;
    this.deps.names.remember(sessionId, { name: info.name, look: info.look });
    info.sessionId = sessionId;
    info.tasks = [];
    info.stats = zeroStats();
    delete info.title;
    this.addActivity(id, { id: `${id}#clear:${++this.seq}`, at: this.now(), ...SPECIAL.cleared() }, true);
    this.markDirty();
  }

  setStatus(id: string, status: AgentStatus, waitingFor?: string): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    const prev = info.status;
    const reason = status === 'waiting' ? (waitingFor ?? 'responder no terminal') : undefined;
    if (prev === status && info.waitingFor === reason) return;
    const now = this.now();
    if (prev !== status) {
      info.status = status;
      info.statusSince = now;
    }
    if (reason) info.waitingFor = reason;
    else delete info.waitingFor;
    const room = this.roomName(info.roomId);

    if (status === 'working' && (prev === 'idle' || rec.turnStart === undefined)) rec.turnStart = now;
    if (status === 'waiting' && prev !== 'waiting') {
      if (!this.booting && !isOpenQuestion(info.activity)) {
        const prevActivity = info.activity;
        const act: Activity = { id: `${id}#wait:${++this.seq}`, at: now, ...SPECIAL.waiting(reason) };
        this.addActivity(id, act, true);
        rec.synthWait = prevActivity ? { id: act.id, prev: prevActivity } : { id: act.id };
      }
      this.notice('wait', id, 'alert', `✋ ${info.name} precisa de você em ${room}: ${reason}`, info.roomId);
    }
    if (prev === 'waiting' && status !== 'waiting' && rec.synthWait) {
      // Saiu da espera sem nada novo no transcript: volta a mostrar o que estava fazendo.
      if (info.activity?.id === rec.synthWait.id && rec.synthWait.prev) info.activity = rec.synthWait.prev;
      delete rec.synthWait;
    }
    if (prev === 'working' && status === 'idle') {
      const cur = info.activity;
      const interrupted = cur?.kind === 'wait' && cur.text === SPECIAL.interrupted().text;
      if (!this.booting && cur?.kind !== 'done' && !interrupted) {
        const act: Activity = { id: `${id}#done:${++this.seq}`, at: now, ...SPECIAL.turnDone(rec.turnStart ? now - rec.turnStart : undefined) };
        if (rec.turnStart) act.durationMs = now - rec.turnStart;
        this.addActivity(id, act, true);
        rec.synthDone = { id: act.id, at: now };
      }
      this.notice('done', id, 'success', `✅ ${info.name} concluiu em ${room}`, info.roomId);
    }
    this.markDirty();
  }

  /**
   * Ocupado, mas o transcript não diz nada novo há um tempo (a última atividade é o fim do turno
   * anterior — ex.: esperando subagentes em segundo plano): mostra algo coerente com "trabalhando".
   */
  fillWorkingActivity(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.status !== 'working') return;
    const cur = rec.info.activity;
    const now = this.now();
    if (cur && (cur.kind !== 'done' || now - cur.at < 15_000)) return;
    const busySubs = [...this.agents.values()].some((r) => r.info.parentId === id && r.info.status === 'working');
    const desc = busySubs ? SPECIAL.supervising() : SPECIAL.think();
    this.addActivity(id, { id: `${id}#busy:${++this.seq}`, at: now, ...desc }, true, { filler: true });
  }

  closeMain(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.status === 'offline') return;
    const now = this.now();
    const info = rec.info;
    info.status = 'offline';
    info.statusSince = now;
    delete info.waitingFor;
    rec.removeAt = now + OFFLINE_GRACE_MS;
    // Subagentes ainda presentes saem junto.
    for (const sub of this.descendants(id)) {
      if (sub.info.status !== 'done') {
        sub.info.status = 'done';
        sub.info.statusSince = now;
      }
      sub.removeAt = Math.min(sub.removeAt ?? Infinity, rec.removeAt);
    }
    this.notice('leave', id, 'info', `🚪 ${info.name} encerrou a sessão`, info.roomId);
    this.markDirty();
  }

  // ---------------------------------------------------------------- subagentes

  addSub(p: SubInput): boolean {
    const parent = this.agents.get(p.parentId);
    if (!parent) return false;
    const now = this.now();
    const existing = this.agents.get(p.id);
    if (existing) {
      this.reactivateSub(p.id);
      return true;
    }
    const person = this.deps.names.assign(p.id, this.usedNames());
    const info: AgentInfo = {
      id: p.id,
      kind: 'sub',
      parentId: p.parentId,
      roomId: parent.info.roomId,
      name: person.name,
      look: person.look,
      role: p.role,
      sessionId: p.sessionId,
      account: parent.info.account,
      status: 'working',
      recent: [],
      tasks: [],
      startedAt: p.startedAt,
      lastEventAt: p.startedAt,
      statusSince: now,
      stats: zeroStats(),
      seed: hash32(p.id),
    };
    if (p.title) info.title = p.title;
    if (p.background) info.background = true;
    this.agents.set(p.id, { info, history: [], turnStart: now });
    this.markDirty();
    return true;
  }

  completeSub(id: string, opts: { notify?: boolean } = {}): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.kind !== 'sub' || rec.info.status === 'done' || rec.info.status === 'offline') return;
    const now = this.now();
    const info = rec.info;
    info.status = 'done';
    info.statusSince = now;
    rec.removeAt = now + DONE_GRACE_MS;
    if (!this.booting && info.activity?.kind !== 'done') {
      const act: Activity = { id: `${id}#done:${++this.seq}`, at: now, ...SPECIAL.turnDone(now - info.startedAt), durationMs: now - info.startedAt };
      this.addActivity(id, act, true);
    }
    if (opts.notify !== false) {
      const parent = info.parentId ? this.agents.get(info.parentId)?.info : undefined;
      const what = info.title ? `“${info.title}”` : 'o trabalho';
      this.notice('deliver', id, 'success', `📦 ${info.name} entregou ${what} para ${parent?.name ?? 'o agente principal'}`, info.roomId);
    }
    this.markDirty();
  }

  /** Subagente concluído voltou a escrever (ex.: recebeu nova mensagem): volta ao trabalho. */
  reactivateSub(id: string): void {
    const rec = this.agents.get(id);
    if (!rec || rec.info.kind !== 'sub' || rec.info.status !== 'done') return;
    const parent = rec.info.parentId ? this.agents.get(rec.info.parentId) : undefined;
    if (!parent || parent.info.status === 'offline') return;
    rec.info.status = 'working';
    rec.info.statusSince = this.now();
    delete rec.removeAt;
    this.markDirty();
  }

  isSubDone(id: string): boolean {
    const s = this.agents.get(id)?.info.status;
    return s === 'done' || s === 'offline';
  }

  // ---------------------------------------------------------------- dados do transcript

  applyTranscript(id: string, t: TranscriptSummary): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    let changed = false;
    const set = <K extends keyof AgentInfo>(k: K, v: AgentInfo[K] | undefined) => {
      if (JSON.stringify(info[k]) === JSON.stringify(v)) return;
      if (v === undefined) delete info[k];
      else info[k] = v;
      changed = true;
    };
    if (info.kind === 'main') set('title', t.title);
    set('tasks', t.tasks.map((x) => ({ ...x })));
    set('stats', { ...t.stats });
    set('model', t.model);
    set('gitBranch', t.gitBranch);
    set('permissionMode', t.permissionMode);
    if (info.kind === 'sub' && t.firstAt !== undefined && t.firstAt < info.startedAt) {
      info.startedAt = t.firstAt;
      changed = true;
    }
    if (t.lastAt !== undefined && t.lastAt > info.lastEventAt) {
      info.lastEventAt = t.lastAt;
      changed = true;
    }
    if (changed) this.markDirty();
  }

  /**
   * Registra uma atividade. `feed: false` = só histórico (ex.: releitura do fim de um transcript
   * antigo ao abrir uma sessão retomada — não é novidade para o feed ao vivo).
   */
  addActivity(id: string, activity: Activity, current: boolean, opts: { feed?: boolean; filler?: boolean } = {}): void {
    const rec = this.agents.get(id);
    if (!rec) return;
    const info = rec.info;
    // "Concluiu" vindo do transcript substitui o que sintetizamos pela mudança de status.
    if (activity.kind === 'done' && rec.synthDone && activity.at - rec.synthDone.at < 60_000) {
      const synthId = rec.synthDone.id;
      const replaced: Activity = { ...activity, id: synthId };
      const swap = (list: Activity[]) => list.map((a) => (a.id === synthId ? replaced : a));
      info.recent = swap(info.recent);
      rec.history = swap(rec.history);
      if (info.activity?.id === synthId) info.activity = replaced;
      delete rec.synthDone;
      this.markDirty();
      return;
    }
    // Releitura de um transcript regravado: não duplica o que já está no histórico.
    if (info.recent.some((a) => a.id === activity.id)) return;
    if (activity.kind !== 'done') delete rec.synthDone;
    info.recent = [...info.recent, activity].slice(-RECENT_LIMIT);
    rec.history.push(activity);
    if (rec.history.length > HISTORY_LIMIT) rec.history.splice(0, rec.history.length - HISTORY_LIMIT);
    if (current || !info.activity) info.activity = activity;
    if (activity.at > info.lastEventAt) info.lastEventAt = activity.at;
    // Uma instrução nova começa um turno (base do "Concluiu em X").
    if (activity.kind === 'prompt') rec.turnStart = activity.at;
    // `filler` (só preenche o balão do personagem) nunca vai para o feed.
    if (!opts.filler) {
      const item: FeedItem = {
        id: activity.id,
        agentId: id,
        roomId: info.roomId,
        agentName: info.name,
        roomName: this.roomName(info.roomId),
        account: info.account,
        activity,
      };
      if (this.booting) this.bootFeed.push(item);
      else if (opts.feed !== false) this.pushFeed([item]);
    }
    this.markDirty();
  }

  /**
   * Atividades anteriores à janela lida no boot (do começo do transcript, lido em segundo plano):
   * entram só no histórico longo (GET /api/agents/:id), sem feed, sem mudar a atividade atual.
   */
  mergeHistory(id: string, older: readonly Activity[]): void {
    const rec = this.agents.get(id);
    if (!rec || !older.length) return;
    const seen = new Set(rec.history.map((a) => a.id));
    const add = older.filter((a) => !seen.has(a.id));
    if (!add.length) return;
    rec.history = [...add, ...rec.history].sort((a, b) => a.at - b.at).slice(-HISTORY_LIMIT);
  }

  // ---------------------------------------------------------------- demonstração

  setDemo(enabled: boolean): void {
    if (enabled === this.isDemo()) return;
    const now = this.now();
    if (enabled) {
      this.demo = new DemoSimulator({ idPrefix: 'demo:' }, now);
      this.demoSnap = this.demo.snapshot(now);
    } else {
      this.demo = null;
      this.demoSnap = null;
    }
    this.recomputeRoomNames();
    this.markDirty();
  }

  // ---------------------------------------------------------------- relógio

  /** Avança o demo e remove quem já cumpriu o período de graça. Chamar a cada ~250 ms. */
  tick(): void {
    const now = this.now();
    if (this.demo) {
      const r = this.demo.tick(now);
      if (r.changed) {
        this.demoSnap = this.demo.snapshot(now);
        this.recomputeRoomNames();
        this.dirty = true;
      }
      if (r.feed.length) this.pushFeed(r.feed);
      this.pendingNotices.push(...r.notices);
      if (r.changed || r.feed.length || r.notices.length) this.markDirty();
    }
    let removed = false;
    for (const [id, rec] of this.agents) {
      if (rec.removeAt !== undefined && now >= rec.removeAt) {
        this.agents.delete(id);
        removed = true;
      }
    }
    if (removed) {
      const occupied = new Set([...this.agents.values()].map((r) => r.info.roomId));
      for (const id of [...this.rooms.keys()]) if (!occupied.has(id)) this.rooms.delete(id);
      this.recomputeRoomNames();
      this.markDirty();
    }
  }

  /** Fecha uma revisão: devolve o snapshot (novo, se algo mudou), o feed e os avisos pendentes. */
  commit(): CommitResult {
    const feed = this.pendingFeed;
    const notices = this.pendingNotices;
    this.pendingFeed = [];
    this.pendingNotices = [];
    if (!this.dirty && this.last) return { snapshot: this.last, changed: false, feed, notices };
    this.rev++;
    this.dirty = false;
    this.last = this.build();
    return { snapshot: this.last, changed: true, feed, notices };
  }

  // ---------------------------------------------------------------- internos

  private build(): OfficeSnapshot {
    const now = this.now();
    const entries = new Map(this.rooms);
    for (const r of this.demoSnap?.rooms ?? []) entries.set(r.id, { path: r.path, createdAt: r.createdAt });
    this.slots.sync(entries.keys(), now);
    const rooms: RoomInfo[] = [...entries]
      .map(([id, r]) => ({
        id,
        name: this.roomName(id),
        path: r.path,
        slot: this.slots.slotOf(id) ?? 0,
        seed: hash32(id),
        createdAt: r.createdAt,
      }))
      .sort((a, b) => a.slot - b.slot);
    const real = [...this.agents.values()].map((r) => cloneAgent(r.info));
    const trim = (a: AgentInfo): AgentInfo => (a.recent.length > SNAPSHOT_RECENT ? { ...a, recent: a.recent.slice(-SNAPSHOT_RECENT) } : a);
    const sessions = new Map<string, number>();
    for (const a of real) if (a.kind === 'main' && a.status !== 'offline') sessions.set(a.account, (sessions.get(a.account) ?? 0) + 1);
    return {
      rev: this.rev,
      serverTime: now,
      rooms,
      agents: [...real, ...(this.demoSnap?.agents ?? [])].map(trim),
      accounts: [...this.deps.accounts(sessions), ...(this.demoSnap?.accounts ?? [])],
      meta: {
        demo: this.isDemo(),
        sources: this.deps.sources(),
        startedAt: this.deps.startedAt,
        version: this.deps.version,
      },
    };
  }

  private usedNames(): Set<string> {
    const used = new Set([...this.agents.values()].map((r) => r.info.name));
    for (const a of this.demoSnap?.agents ?? []) used.add(a.name);
    return used;
  }

  private descendants(id: string): AgentRecord[] {
    const out: AgentRecord[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const rec of this.agents.values()) {
        if (rec.info.parentId === cur) {
          out.push(rec);
          queue.push(rec.info.id);
        }
      }
    }
    return out;
  }

  private ensureRoom(roomId: string, now: number): void {
    if (this.rooms.has(roomId)) return;
    this.rooms.set(roomId, { path: roomId, createdAt: now });
    this.recomputeRoomNames();
    this.notice('room', roomId, 'info', `🏗️ Nova sala: ${this.roomName(roomId)}`, roomId);
  }

  private recomputeRoomNames(): void {
    const paths = new Map([...this.rooms].map(([id, r]) => [id, r.path]));
    for (const r of this.demoSnap?.rooms ?? []) paths.set(r.id, r.path);
    this.roomNames = roomDisplayNames(paths);
  }

  private pushFeed(items: FeedItem[]): void {
    this.pendingFeed.push(...items);
    this.feed.push(...items);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
  }

  private notice(kind: NoticeKind, key: string, level: NoticeLevel, text: string, roomId?: string): void {
    if (this.booting) return;
    const now = this.now();
    const k = `${key}|${kind}`;
    const last = this.noticeAt.get(k);
    if (last !== undefined && now - last < NOTICE_DEDUPE_MS) return;
    this.noticeAt.set(k, now);
    if (this.noticeAt.size > 2_000) {
      for (const [nk, t] of this.noticeAt) if (now - t > NOTICE_DEDUPE_MS) this.noticeAt.delete(nk);
    }
    const n: Notice = { id: `n-${now.toString(36)}-${++this.seq}`, level, text, at: now };
    if (kind !== 'room') n.agentId = key;
    if (roomId) n.roomId = roomId;
    this.pendingNotices.push(n);
  }
}
