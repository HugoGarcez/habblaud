import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockOptionsFrom, OfficeStore, reconnectDelay, type EventSourceLike } from './store';

/** EventSource falso: o teste dispara open/error e muda o readyState. */
class FakeSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private handlers = new Map<string, ((ev: Event) => void)[]>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  fire(type: string, data?: unknown): void {
    const ev = (data === undefined ? { type } : { type, data: JSON.stringify(data) }) as unknown as Event;
    this.handlers.get(type)?.forEach((fn) => fn(ev));
  }

  open(): void {
    this.readyState = 1;
    this.fire('open');
  }

  /** Erro definitivo (ex.: HTTP 502): o navegador desiste e fecha o stream. */
  fail(): void {
    this.readyState = 2;
    this.fire('error');
  }
}

describe('mockOptionsFrom', () => {
  it('usa os padrões sem parâmetros', () => {
    expect(mockOptionsFrom('')).toEqual({ speed: 1, sessions: 4 });
  });

  it('aceita sessions=0 (escritório vazio)', () => {
    expect(mockOptionsFrom('?mock=1&sessions=0').sessions).toBe(0);
  });

  it('ignora valores inválidos e limita os exagerados', () => {
    expect(mockOptionsFrom('?sessions=abc&speed=-2')).toEqual({ speed: 1, sessions: 4 });
    expect(mockOptionsFrom('?sessions=&speed=')).toEqual({ speed: 1, sessions: 4 });
    expect(mockOptionsFrom('?sessions=6.7&speed=2')).toEqual({ speed: 2, sessions: 6 });
    expect(mockOptionsFrom('?sessions=999&speed=999')).toEqual({ speed: 50, sessions: 40 });
  });
});

describe('reconnectDelay', () => {
  it('dobra a cada tentativa até 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});

describe('OfficeStore: reconexão', () => {
  let sources: FakeSource[];
  let store: OfficeStore;
  const last = () => sources[sources.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    store = new OfficeStore({
      eventSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    });
  });

  afterEach(() => {
    store.disconnect();
    vi.useRealTimers();
  });

  it('religa sozinho com espera crescente quando o navegador desiste do stream', () => {
    const states: string[] = [];
    store.on('connection', (s) => states.push(s));
    store.connect();
    last().fail();
    expect(store.connection).toBe('closed');
    expect(sources).toHaveLength(1);

    vi.advanceTimersByTime(1_999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    expect(sources[0].closed).toBe(true);

    // Segunda falha seguida: espera 4 s.
    last().fail();
    vi.advanceTimersByTime(3_999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);

    // Conectou: zera a espera.
    last().open();
    expect(store.connection).toBe('open');
    last().fail();
    vi.advanceTimersByTime(2_000);
    expect(sources).toHaveLength(4);
    expect(states).toEqual(['closed', 'connecting', 'closed', 'connecting', 'open', 'closed', 'connecting']);
  });

  it('erro transitório (o navegador ainda tenta) não agenda reconexão própria', () => {
    store.connect();
    last().open();
    last().readyState = 0;
    last().fire('error');
    expect(store.connection).toBe('connecting');
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });

  it('"Tentar agora" religa na hora e cancela a tentativa agendada', () => {
    store.connect();
    last().fail();
    expect(store.nextRetryAt).not.toBeNull();
    store.reconnectNow();
    expect(sources).toHaveLength(2);
    expect(store.connection).toBe('connecting');
    expect(store.nextRetryAt).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(2);
  });

  it('disconnect() não reconecta e eventos do stream antigo são ignorados', () => {
    store.connect();
    const old = last();
    store.disconnect();
    old.fail();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
    expect(store.connection).toBe('connecting');
  });

  it('aplica snapshot, feed e avisos; JSON inválido é ignorado', () => {
    const notices: unknown[] = [];
    store.on('notice', (n) => notices.push(n));
    store.connect();
    last().open();
    const snap = { rev: 1, serverTime: 0, rooms: [], agents: [], accounts: [], meta: { demo: false, sources: [], startedAt: 1, version: 't' } };
    last().fire('snapshot', snap);
    expect(store.snapshot?.rev).toBe(1);
    last().fire('feed', [{ id: 'f1', agentId: 'a', roomId: 'r', agentName: 'Ana', roomName: 'x', activity: { id: 'x', at: 0, kind: 'tool', icon: '·', text: 't' } }]);
    expect(store.feed).toHaveLength(1);
    last().fire('notice', { id: 'n', level: 'info', text: 'oi', at: 0 });
    expect(notices).toHaveLength(1);
    expect(() => last().fire('snapshot', undefined)).not.toThrow();
    const bad = { type: 'snapshot', data: '{quebrado' } as unknown as Event;
    expect(() => (last() as unknown as { handlers: Map<string, ((e: Event) => void)[]> }).handlers.get('snapshot')![0](bad)).not.toThrow();
    expect(store.snapshot?.rev).toBe(1);
  });
});
