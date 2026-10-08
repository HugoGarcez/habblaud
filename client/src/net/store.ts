// Estado do escritório no navegador: recebe snapshots/feed/avisos do servidor via SSE
// (ou do simulador local quando a URL tem ?mock=1) e notifica os assinantes.
// Fonte alternativa (o timelapse, ui/timelapse.ts): pushReplay() publica snapshots reconstruídos e o
// SSE segue conectado por baixo, com os snapshots ao vivo guardados até o stopReplay().
// Também cuida da reconexão: quando o navegador desiste do stream (EventSource fechado após erro HTTP,
// ex.: servidor reiniciando atrás de um proxy), tenta de novo com espera crescente.
import type { Activity, AgentDetail, AgentInfo, FeedItem, Notice, OfficeSnapshot, RoomInfo } from '../../../shared/types';
import { DemoSimulator } from '../../../shared/demo/simulator';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'mock';

export interface StoreEvents {
  snapshot: OfficeSnapshot;
  feed: FeedItem[];
  notice: Notice;
  connection: ConnectionState;
  /** O servidor está servindo outro build do cliente: esta página está desatualizada. Emitido uma vez. */
  update: { build: string; current: string };
}

/**
 * Build desta página: o nome do bundle principal (ex.: "main-BFqheOCa"), tirado da URL do próprio módulo.
 * No modo dev (código-fonte servido pelo Vite) não há bundle e o resultado é undefined.
 */
export function pageBuild(moduleUrl: string = import.meta.url): string | undefined {
  try {
    return /\/bundle\/(main-[\w-]+)\.js$/.exec(new URL(moduleUrl).pathname)?.[1];
  } catch {
    return undefined;
  }
}

type Listener<K extends keyof StoreEvents> = (value: StoreEvents[K]) => void;

/** O mínimo de EventSource que o store usa (permite injetar um falso nos testes). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface StoreOptions {
  mock?: boolean;
  /** Parâmetros do modo mock (padrão: a query string da página). */
  search?: string;
  /** Fábrica do stream (padrão: `new EventSource(url)`). */
  eventSource?: (url: string) => EventSourceLike;
}

const FEED_LIMIT = 200;
/** EventSource.CLOSED (constante literal: o EventSource não existe no Node dos testes). */
const ES_CLOSED = 2;
/** Espera entre tentativas de reconexão: 2 s, 4 s, 8 s… até 30 s. */
export const RECONNECT_BASE_MS = 2_000;
export const RECONNECT_MAX_MS = 30_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
}

/** Opções do simulador a partir da query string (?speed=2&sessions=6). `sessions=0` vale: escritório vazio. */
export function mockOptionsFrom(search: string): { speed: number; sessions: number } {
  const params = new URLSearchParams(search);
  const num = (name: string): number | null => {
    const raw = params.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const speed = num('speed');
  const sessions = num('sessions');
  return {
    speed: speed !== null && speed > 0 ? Math.min(speed, 50) : 1,
    sessions: sessions !== null && sessions >= 0 ? Math.min(Math.floor(sessions), 40) : 4,
  };
}

export class OfficeStore {
  snapshot: OfficeSnapshot | null = null;
  /** Feed global, do mais antigo para o mais recente. */
  feed: FeedItem[] = [];
  connection: ConnectionState = 'connecting';
  readonly mock: boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private listeners = new Map<keyof StoreEvents, Set<(value: any) => void>>();
  private agentIndex = new Map<string, AgentInfo>();
  private roomIndex = new Map<string, RoomInfo>();
  private source: EventSourceLike | null = null;
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private readonly search: string;
  private readonly openStream: (url: string) => EventSourceLike;
  /** Reconexão: tentativas seguidas sem sucesso e o timer da próxima. */
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAt: number | null = null;
  /** Desligado de propósito (disconnect()): não reconecta sozinho. */
  private stopped = true;
  /** Timelapse ligado: `snapshot` é o reconstruído; o último ao vivo fica em `live` (com a hora em que chegou). */
  private replay = false;
  private live: { snap: OfficeSnapshot; at: number } | null = null;

  constructor(opts: StoreOptions = {}) {
    this.mock = !!opts.mock;
    this.search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
    this.openStream = opts.eventSource ?? ((url) => new EventSource(url));
    // Rede de volta (Wi-Fi, VPN): não espera o próximo intervalo para religar.
    if (typeof addEventListener === 'function' && !this.mock) {
      addEventListener('online', () => {
        if (!this.stopped && this.connection === 'closed') this.reconnectNow();
      });
    }
  }

  on<K extends keyof StoreEvents>(event: K, cb: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => void set.delete(cb);
  }

  connect(): void {
    this.stopped = false;
    if (this.mock) return this.startMock();
    this.startSSE();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearRetry();
    this.closeSource();
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  /** Reconecta imediatamente (botão "Tentar agora"), sem esperar o próximo intervalo. */
  reconnectNow(): void {
    if (this.mock) return;
    this.clearRetry();
    this.closeSource();
    this.stopped = false;
    this.startSSE();
  }

  /** Quando será a próxima tentativa automática de reconexão (epoch ms), ou null. */
  get nextRetryAt(): number | null {
    return this.retryAt;
  }

  agent(id: string): AgentInfo | undefined {
    return this.agentIndex.get(id);
  }

  room(id: string): RoomInfo | undefined {
    return this.roomIndex.get(id);
  }

  agentsInRoom(roomId: string): AgentInfo[] {
    return (this.snapshot?.agents ?? []).filter((a) => a.roomId === roomId);
  }

  /** Histórico longo de um agente (servidor). No modo mock e no timelapse devolve o `recent`. */
  async agentHistory(id: string): Promise<Activity[]> {
    if (this.mock || this.replay) return this.agent(id)?.recent ?? [];
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
    if (!res.ok) return this.agent(id)?.recent ?? [];
    const detail = (await res.json()) as AgentDetail;
    return detail.history;
  }

  /** Liga/desliga os agentes de demonstração no servidor. */
  async setDemo(enabled: boolean): Promise<boolean> {
    if (this.mock) return true;
    const res = await fetch('/api/demo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return res.ok;
  }

  // ---------------------------------------------------------------- timelapse

  /** Snapshots vêm de uma fonte alternativa (o timelapse), não do SSE. */
  get replaying(): boolean {
    return this.replay;
  }

  /** Último snapshot ao vivo (durante o timelapse, `snapshot` é o reconstruído). */
  get liveSnapshot(): OfficeSnapshot | null {
    return this.replay ? (this.live?.snap ?? null) : this.snapshot;
  }

  /** Publica um snapshot da fonte alternativa; o primeiro liga o modo replay (o ao vivo fica guardado). */
  pushReplay(snap: OfficeSnapshot): void {
    if (!this.replay) {
      this.replay = true;
      this.live = this.snapshot ? { snap: this.snapshot, at: Date.now() } : null;
    }
    this.setSnapshot(snap);
  }

  /** Desliga a fonte alternativa e volta ao último snapshot ao vivo. */
  stopReplay(): void {
    if (!this.replay) return;
    this.replay = false;
    const live = this.live;
    this.live = null;
    if (live) {
      // `serverTime` avançado pelo tempo guardado: a UI acerta o relógio pelo snapshot que acabou de chegar.
      this.setSnapshot({ ...live.snap, serverTime: live.snap.serverTime + (Date.now() - live.at) });
    } else {
      this.snapshot = null;
      this.agentIndex = new Map();
      this.roomIndex = new Map();
    }
  }

  // ---------------------------------------------------------------- internos

  private emit<K extends keyof StoreEvents>(event: K, value: StoreEvents[K]): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(value);
      } catch (err) {
        console.error(`[store] listener de "${event}" falhou`, err);
      }
    });
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return;
    this.connection = state;
    this.emit('connection', state);
  }

  private applySnapshot(snap: OfficeSnapshot): void {
    const cur = this.replay ? this.live?.snap : this.snapshot;
    if (cur && snap.rev < cur.rev && snap.meta.startedAt === cur.meta.startedAt) return;
    if (this.replay) this.live = { snap, at: Date.now() };
    else this.setSnapshot(snap);
    this.checkBuild(snap.meta.build);
  }

  private setSnapshot(snap: OfficeSnapshot): void {
    this.snapshot = snap;
    this.agentIndex = new Map(snap.agents.map((a) => [a.id, a]));
    this.roomIndex = new Map(snap.rooms.map((r) => [r.id, r]));
    this.emit('snapshot', snap);
  }

  private updateAnnounced = false;
  /** Build desta página (ver pageBuild); exposto para testes. */
  pageBuildId: string | undefined = pageBuild();

  /** Avisa (uma vez) quando o servidor passou a servir outro build do cliente. */
  private checkBuild(serverBuild: string | undefined): void {
    if (this.updateAnnounced || this.mock || !serverBuild) return;
    const current = this.pageBuildId;
    if (!current || current === serverBuild) return;
    this.updateAnnounced = true;
    this.emit('update', { build: serverBuild, current });
  }

  private applyFeed(items: FeedItem[]): void {
    if (!items.length) return;
    const known = new Set(this.feed.map((f) => f.id));
    const fresh = items.filter((f) => !known.has(f.id));
    if (!fresh.length) return;
    this.feed = [...this.feed, ...fresh].slice(-FEED_LIMIT);
    this.emit('feed', fresh);
  }

  /** Lê o JSON de um evento SSE; mensagens corrompidas são ignoradas sem derrubar o stream. */
  private parse<T>(ev: Event, what: string): T | null {
    try {
      return JSON.parse((ev as MessageEvent).data) as T;
    } catch (err) {
      console.warn(`[store] ${what} inválido ignorado`, err);
      return null;
    }
  }

  private startSSE(): void {
    this.setConnection('connecting');
    let es: EventSourceLike;
    try {
      es = this.openStream('/api/stream');
    } catch (err) {
      console.error('[store] não foi possível abrir o stream', err);
      this.setConnection('closed');
      this.scheduleRetry();
      return;
    }
    this.source = es;
    // Eventos de um stream já substituído (reconexão) não valem mais.
    const current = () => this.source === es;
    es.addEventListener('open', () => {
      if (!current()) return;
      this.attempts = 0;
      this.clearRetry();
      this.setConnection('open');
    });
    es.addEventListener('error', () => {
      if (!current()) return;
      // CONNECTING: o próprio navegador vai tentar de novo. CLOSED: desistiu; a reconexão fica por nossa conta.
      if (es.readyState === ES_CLOSED) {
        this.setConnection('closed');
        this.scheduleRetry();
      } else {
        this.setConnection('connecting');
      }
    });
    es.addEventListener('snapshot', (ev) => {
      if (!current()) return;
      const snap = this.parse<OfficeSnapshot>(ev, 'snapshot');
      if (snap) this.applySnapshot(snap);
    });
    es.addEventListener('feed', (ev) => {
      if (!current()) return;
      const items = this.parse<FeedItem[]>(ev, 'feed');
      if (items) this.applyFeed(items);
    });
    es.addEventListener('notice', (ev) => {
      if (!current()) return;
      const n = this.parse<Notice>(ev, 'aviso');
      if (n) this.emit('notice', n);
    });
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.mock || this.stopped) return;
    const delay = reconnectDelay(this.attempts);
    this.attempts++;
    this.retryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAt = null;
      if (!this.stopped && this.connection === 'closed') {
        this.closeSource();
        this.startSSE();
      }
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryAt = null;
  }

  private startMock(): void {
    if (this.mockTimer) return;
    this.setConnection('mock');
    const sim = new DemoSimulator(mockOptionsFrom(this.search));
    this.applySnapshot(sim.snapshot());
    this.mockTimer = setInterval(() => {
      const now = Date.now();
      const r = sim.tick(now);
      if (r.changed) this.applySnapshot(sim.snapshot(now));
      this.applyFeed(r.feed);
      r.notices.forEach((n) => this.emit('notice', n));
    }, 250);
  }
}
