// Mensagens pelo escritório: a fila do que a página manda aos agentes.
//
// A página manda em POST /api/messages; o plugin habblaud-mensagens (mod/habblaud-mensagens, uma rodada a cada 2 s
// em cada sessão aberta) busca as da própria sessão em POST /api/mod/inbox, entrega cada uma como se o usuário a
// tivesse digitado e confirma em POST /api/mod/inbox/ack. O registro:
// - marca a PRESENÇA de cada sessão que pergunta pela caixa de entrada (AgentInfo.canMessage, via Office);
// - guarda as mensagens de cada agente na ordem e acompanha a situação delas (queued → sent → delivered/failed);
// - falha as que ninguém buscou, as que a sessão não confirmou e as do agente que saiu;
// - põe a atividade "Mensagem pelo Habblaud" no agente quando a sessão confirma a entrega;
// - simula a entrega para os agentes do demo (nada vai a uma sessão de verdade).
// O texto vai à sessão exatamente como foi digitado (é do próprio usuário) e nunca sai nas respostas da página nem
// no log; só a atividade do feed leva o começo dele, mascarado e cortado.
import { randomBytes } from 'node:crypto';
import { truncate } from '../../shared/activity';
import { describeMessage, MESSAGE_MAX } from '../../shared/messages';
import type { Activity, AgentInfo, InboxMessage, OutboxMessage } from '../../shared/types';
import { errMsg, log } from '../log';

/** Sessão que perguntou pela caixa de entrada há até este tempo: recebe mensagens (canMessage). */
export const PRESENCE_MS = 10_000;
/** Mensagem na fila que a sessão não buscou neste tempo: falha. */
export const QUEUED_TIMEOUT_MS = 60_000;
/** Mensagem buscada que a sessão não confirmou neste tempo: falha. */
export const SENT_TIMEOUT_MS = 30_000;
/** Mensagem resolvida (entregue ou não) fica este tempo para GET /api/messages/:id e depois some. */
export const KEEP_MS = 10 * 60_000;
/** Entrega fictícia de uma mensagem a um agente do demo. */
export const DEMO_DELIVERY_MS = 1_000;
export const MAX_TEXT = MESSAGE_MAX;
/** Mensagens ainda não resolvidas por agente (a próxima recebe 429). */
export const MAX_OPEN = 5;
/** Mensagens entregues ao plugin por rodada. */
export const INBOX_BATCH = 5;

export const ERR_NOT_FETCHED = 'a sessão não buscou a mensagem: o plugin habblaud-mensagens está instalado e a sessão aberta?';
export const ERR_NOT_CONFIRMED = 'a sessão não confirmou a entrega';
export const ERR_GONE = 'o agente saiu do escritório';
export const ERR_REFUSED = 'a sessão não aceitou a mensagem';

const ERROR_MAX = 300;
const ID_MAX = 300;
const ACK_MAX = 50;

/** O que o registro usa do Office (interface mínima: facilita os testes). */
export interface OfficeLike {
  get(id: string): AgentInfo | undefined;
  list(): AgentInfo[];
  markDirty(): void;
  addActivity(id: string, activity: Activity, current: boolean): void;
}

export interface MessageRegistryOptions {
  office: OfficeLike;
  /** Agente do demo (Office.demoAgent): esses só existem no snapshot. */
  demoAgent?: (id: string) => AgentInfo | undefined;
  /** Entrega fictícia a um agente do demo (Office.deliverDemoMessage); false = ele já saiu. */
  demoDeliver?: (agentId: string, text: string) => boolean;
  now?: () => number;
  /** Intervalo do relógio interno (start). */
  tickMs?: number;
  presenceMs?: number;
  queuedTimeoutMs?: number;
  sentTimeoutMs?: number;
  keepMs?: number;
  demoDeliveryMs?: number;
}

export type SendResult = { message: OutboxMessage } | { error: 'not-found' | 'too-many' } | { error: 'unavailable'; reason: string };

/** Erro de validação do corpo (vira 400). */
export class InvalidRequest extends Error {}

interface Entry {
  msg: OutboxMessage;
  /** O texto como foi digitado; esvazia quando a mensagem se resolve. */
  text: string;
  /** Atividade do feed quando a entrega se confirma (o começo do texto, mascarado e cortado). */
  activity: ReturnType<typeof describeMessage>;
  /** Sessão que buscou a mensagem (sent): só ela confirma a entrega. */
  session?: string;
  sentAt?: number;
  /** Mensagem a um agente do demo: nunca sai pela caixa de entrada. */
  demo?: boolean;
  /** Falhou por falta de confirmação: uma confirmação atrasada ainda corrige a situação. */
  late?: boolean;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Agente que ainda está no escritório (não saiu nem concluiu). */
function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

const isFinal = (e: Entry) => e.msg.status === 'delivered' || e.msg.status === 'failed';

/** Por que o agente não recebe mensagens agora (undefined = recebe). `reachable`: a sessão tem o plugin conectado. */
function unavailableReason(a: AgentInfo, reachable: boolean): string | undefined {
  if (a.kind !== 'main') return 'subagentes não recebem mensagens: mande para o agente principal';
  if (!present(a)) return 'o agente já saiu do escritório';
  if (!reachable) return 'a sessão não está com o plugin habblaud-mensagens conectado (npm run mod:install)';
  return undefined;
}

/** Corpo de POST /api/messages: `{agentId, text}`. O texto não é alterado (nem aparado). */
export function parseSend(raw: unknown): { agentId: string; text: string } {
  const r = rec(raw);
  const agentId = shortStr(r?.agentId, ID_MAX);
  if (!r || !agentId || typeof r.text !== 'string') throw new InvalidRequest('esperado {agentId, text}');
  if (!r.text.trim()) throw new InvalidRequest('a mensagem está vazia');
  if (r.text.length > MAX_TEXT) throw new InvalidRequest('a mensagem passa de 20.000 caracteres');
  return { agentId, text: r.text };
}

export class MessageRegistry {
  private messages = new Map<string, Entry>();
  /** Última vez que a sessão de cada agente principal perguntou pela caixa de entrada. */
  private seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly now: () => number;
  private readonly presenceMs: number;
  private readonly queuedTimeoutMs: number;
  private readonly sentTimeoutMs: number;
  private readonly keepMs: number;
  private readonly demoDeliveryMs: number;

  constructor(private readonly opts: MessageRegistryOptions) {
    this.now = opts.now ?? Date.now;
    this.presenceMs = opts.presenceMs ?? PRESENCE_MS;
    this.queuedTimeoutMs = opts.queuedTimeoutMs ?? QUEUED_TIMEOUT_MS;
    this.sentTimeoutMs = opts.sentTimeoutMs ?? SENT_TIMEOUT_MS;
    this.keepMs = opts.keepMs ?? KEEP_MS;
    this.demoDeliveryMs = opts.demoDeliveryMs ?? DEMO_DELIVERY_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warnOnce(`messages-tick:${errMsg(err)}`, `Mensagens: falha no relógio (${errMsg(err)}).`);
      }
    }, this.opts.tickMs ?? 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Mensagens guardadas (inclusive as já resolvidas, até sumirem). */
  get size(): number {
    return this.messages.size;
  }

  /** Agentes principais presentes cuja sessão perguntou pela caixa de entrada há pouco: é o que o Office põe no snapshot. */
  reachable(): Set<string> {
    const out = new Set<string>();
    for (const id of this.seen.keys()) if (this.canMessage(id)) out.add(id);
    return out;
  }

  canMessage(agentId: string): boolean {
    const at = this.seen.get(agentId);
    if (at === undefined || this.now() - at >= this.presenceMs) return false;
    const a = this.opts.office.get(agentId);
    return present(a) && a.kind === 'main';
  }

  /**
   * Mensagem vinda da página. `{error}`: agente desconhecido (not-found), que não recebe mensagens (unavailable, com
   * o motivo: subagente, saiu/concluiu ou sessão sem o plugin) ou com mensagens demais esperando (too-many).
   * Corpo inválido: lança InvalidRequest.
   */
  send(raw: unknown): SendResult {
    const { agentId, text } = parseSend(raw);
    const real = this.opts.office.get(agentId);
    const demo = real ? undefined : this.opts.demoAgent?.(agentId);
    const agent = real ?? demo;
    if (!agent) return { error: 'not-found' };
    const reason = unavailableReason(agent, real ? this.canMessage(agentId) : demo!.canMessage === true);
    if (reason) return { error: 'unavailable', reason };
    let open = 0;
    for (const e of this.messages.values()) if (e.msg.agentId === agentId && !isFinal(e)) open++;
    if (open >= MAX_OPEN) return { error: 'too-many' };

    const now = this.now();
    const id = `m-${now.toString(36)}-${++this.seq}-${randomBytes(9).toString('base64url')}`;
    const entry: Entry = { msg: { id, agentId, status: 'queued', createdAt: now, updatedAt: now }, text, activity: describeMessage(text) };
    if (demo) entry.demo = true;
    this.messages.set(id, entry);
    return { message: { ...entry.msg } };
  }

  /** Situação de uma mensagem (sem o texto), ou undefined. */
  get(id: string): OutboxMessage | undefined {
    const e = this.messages.get(id);
    return e ? { ...e.msg } : undefined;
  }

  /**
   * Rodada do plugin: marca a presença da sessão e entrega as próximas mensagens do agente dela (marcando-as
   * `sent`). Sessão sem agente principal conhecido: nenhuma mensagem. Corpo inválido: lança InvalidRequest.
   */
  inbox(raw: unknown): InboxMessage[] {
    const r = rec(raw);
    const session = shortStr(r?.session, ID_MAX);
    if (!r || !session) throw new InvalidRequest('esperado {session, account?}');
    const account = shortStr(r.account, ID_MAX);
    const agent = this.opts.office.list().find((a) => a.kind === 'main' && a.sessionId === session && (!account || a.account === account) && present(a));
    if (!agent) return [];

    const now = this.now();
    const was = this.canMessage(agent.id);
    this.seen.set(agent.id, now);
    // Só a mudança de presença mexe no snapshot (a rodada se repete a cada 2 s).
    if (!was) this.opts.office.markDirty();

    const out: InboxMessage[] = [];
    for (const e of this.messages.values()) {
      if (out.length >= INBOX_BATCH) break;
      if (e.demo || e.msg.agentId !== agent.id || e.msg.status !== 'queued') continue;
      this.setStatus(e, 'sent', now);
      e.session = session;
      e.sentAt = now;
      out.push({ id: e.msg.id, text: e.text });
    }
    return out;
  }

  /**
   * Confirmação do plugin: `sent` → `delivered` (ok) ou `failed` (com o motivo). Só vale da sessão que buscou a
   * mensagem; ids desconhecidos ou em outra situação são ignorados. Uma confirmação atrasada (a mensagem já tinha
   * falhado por falta dela) ainda corrige a situação: o plugin é quem sabe se o texto entrou.
   */
  ack(raw: unknown): void {
    const r = rec(raw);
    const session = shortStr(r?.session, ID_MAX);
    if (!r || !session || !Array.isArray(r.results)) throw new InvalidRequest('esperado {session, results: [{id, ok, error?}]}');
    const now = this.now();
    for (const item of r.results.slice(0, ACK_MAX)) {
      const x = rec(item);
      const id = shortStr(x?.id, ID_MAX);
      if (!x || !id || typeof x.ok !== 'boolean') continue;
      const e = this.messages.get(id);
      if (!e || e.demo || e.session !== session) continue;
      if (e.msg.status !== 'sent' && !(e.msg.status === 'failed' && e.late)) continue;
      if (x.ok) this.finish(e, 'delivered', now);
      else this.fail(e, now, typeof x.error === 'string' && x.error.trim() ? truncate(x.error, ERROR_MAX) : ERR_REFUSED);
    }
  }

  /** Relógio: prazos, agente que saiu, entrega fictícia do demo, presença que venceu e limpeza das resolvidas. */
  tick(): void {
    const now = this.now();
    for (const [id, e] of this.messages) {
      if (isFinal(e)) {
        if (now - e.msg.updatedAt >= this.keepMs) this.messages.delete(id);
        continue;
      }
      if (e.demo) {
        if (!present(this.opts.demoAgent?.(e.msg.agentId))) this.fail(e, now, ERR_GONE);
        else if (now - e.msg.createdAt >= this.demoDeliveryMs) {
          if (this.opts.demoDeliver?.(e.msg.agentId, e.text)) this.finish(e, 'delivered', now);
          else this.fail(e, now, ERR_GONE);
        }
        continue;
      }
      if (!present(this.opts.office.get(e.msg.agentId))) this.fail(e, now, ERR_GONE);
      else if (e.msg.status === 'queued' && now - e.msg.createdAt >= this.queuedTimeoutMs) this.fail(e, now, ERR_NOT_FETCHED);
      else if (e.msg.status === 'sent' && now - (e.sentAt ?? now) >= this.sentTimeoutMs) {
        this.fail(e, now, ERR_NOT_CONFIRMED);
        e.late = true;
      }
    }
    // Presença que venceu (ou de quem saiu): o snapshot volta a dizer que não dá para mandar mensagem.
    for (const [agentId, at] of this.seen) {
      if (now - at < this.presenceMs && present(this.opts.office.get(agentId))) continue;
      this.seen.delete(agentId);
      this.opts.office.markDirty();
    }
  }

  // ---------------------------------------------------------------- internos

  private setStatus(e: Entry, status: OutboxMessage['status'], now: number): void {
    e.msg.status = status;
    e.msg.updatedAt = now;
  }

  /** Resolve a mensagem: o texto não é mais necessário. */
  private finish(e: Entry, status: 'delivered' | 'failed', now: number): void {
    this.setStatus(e, status, now);
    delete e.late;
    if (status === 'delivered') {
      delete e.msg.error;
      // A do demo vai para o agente fictício (Office.deliverDemoMessage).
      if (!e.demo) this.opts.office.addActivity(e.msg.agentId, { id: `${e.msg.agentId}#msg:${e.msg.id}`, at: now, ...e.activity }, false);
    }
    e.text = '';
  }

  private fail(e: Entry, now: number, error: string): void {
    e.msg.error = error;
    this.finish(e, 'failed', now);
  }
}
