// Modelo de apresentação da UI: agrupamento salas -> agentes -> subagentes, filtros, contadores e rótulos.
// Funções puras (sem DOM), testadas em ui/model.test.ts.
import type { AccountInfo, AgentInfo, AgentStatus, OfficeSnapshot, RoomInfo, TaskItem } from '../../../shared/types';
import { normalizeSearch } from './format';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Trabalhando',
  waiting: 'Precisa de você',
  idle: 'Ocioso',
  done: 'Concluído',
  offline: 'Saindo',
};

/** Ordem de urgência (menor = mais urgente), usada para destacar quem precisa de atenção. */
const STATUS_URGENCY: Record<AgentStatus, number> = { waiting: 0, working: 1, idle: 2, done: 3, offline: 4 };

export function statusLabel(status: AgentStatus): string {
  return STATUS_LABEL[status];
}

/** Texto da linha de atividade quando o agente ainda não tem nenhuma (ex.: sessão recém-aberta, sem pedido). */
export function activityFallback(agent: Pick<AgentInfo, 'status' | 'waitingFor'>): string {
  switch (agent.status) {
    case 'working':
      return 'Trabalhando…';
    case 'waiting':
      return agent.waitingFor ? `Precisa de você: ${agent.waitingFor}` : 'Precisa de você';
    case 'done':
      return 'Concluiu a tarefa';
    case 'offline':
      return 'Saindo do escritório';
    default:
      return 'Aguardando instruções';
  }
}

/** Selo de papel: "Agente principal" ou o tipo do subagente ("Explore", "Plan"...). */
export function roleLabel(agent: Pick<AgentInfo, 'kind' | 'role'>): string {
  if (agent.kind === 'main') return agent.role || 'Agente principal';
  return agent.role || 'Subagente';
}

/** Agente ainda "presente" (não está indo embora). */
export function isPresent(agent: Pick<AgentInfo, 'status'>): boolean {
  return agent.status !== 'offline';
}

export interface Counters {
  rooms: number;
  /** Agentes presentes (principais + subagentes, exceto os que estão saindo). */
  agents: number;
  working: number;
  /** Subagentes ativos (não concluídos nem saindo). */
  subagents: number;
  waiting: number;
}

export function computeCounters(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null): Counters {
  const c: Counters = { rooms: 0, agents: 0, working: 0, subagents: 0, waiting: 0 };
  if (!snap) return c;
  c.rooms = snap.rooms.length;
  for (const a of snap.agents) {
    if (!isPresent(a)) continue;
    c.agents++;
    if (a.status === 'working') c.working++;
    if (a.status === 'waiting') c.waiting++;
    if (a.kind === 'sub' && a.status !== 'done') c.subagents++;
  }
  return c;
}

/** Agentes esperando o usuário, do que espera há mais tempo para o mais recente. */
export function waitingAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.status === 'waiting').sort((a, b) => a.statusSince - b.statusSince);
}

export interface TaskProgress {
  completed: number;
  inProgress: number;
  total: number;
}

export function taskProgress(tasks: readonly Pick<TaskItem, 'status'>[]): TaskProgress {
  const p: TaskProgress = { completed: 0, inProgress: 0, total: tasks.length };
  for (const t of tasks) {
    if (t.status === 'completed') p.completed++;
    else if (t.status === 'in_progress') p.inProgress++;
  }
  return p;
}

/** Soma as tarefas de vários agentes (progresso agregado de uma sala). */
export function aggregateTasks(agents: readonly Pick<AgentInfo, 'tasks'>[]): TaskProgress {
  return taskProgress(agents.flatMap((a) => a.tasks));
}

// ---------------------------------------------------------------- agrupamento e filtros

export interface AgentFilter {
  /** Texto livre: nome, papel, título, sala, caminho ou conta. */
  query: string;
  /** Contas ocultas (AccountInfo.id). */
  hiddenAccounts: ReadonlySet<string>;
}

export interface AgentNode {
  agent: AgentInfo;
  /** Subagentes visíveis (após filtros), ordenados por chegada. */
  subs: AgentInfo[];
  /** Total de subagentes presentes no snapshot (independe do filtro). */
  subTotal: number;
}

export interface RoomGroup {
  room: RoomInfo;
  /** Contas presentes na sala (ids, na ordem de `accounts` do snapshot). */
  accounts: string[];
  nodes: AgentNode[];
  /** Todos os agentes da sala (sem filtro). */
  agents: AgentInfo[];
  tasks: TaskProgress;
  /** Quantos agentes da sala passam no filtro. */
  matches: number;
}

function accountText(account: AccountInfo | undefined): string {
  if (!account) return '';
  return [account.short, account.name, account.email ?? '', account.id].join(' ');
}

/** Verdadeiro se o agente bate com a busca textual (sem acentos, sem diferenciar maiúsculas). */
export function matchesQuery(agent: AgentInfo, room: RoomInfo | undefined, account: AccountInfo | undefined, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = normalizeSearch(
    [agent.name, roleLabel(agent), agent.title ?? '', room?.name ?? '', room?.path ?? '', accountText(account), agent.activity?.text ?? ''].join(' \u0001 '),
  );
  return q.split(/\s+/).every((term) => hay.includes(term));
}

const byArrival = (a: AgentInfo, b: AgentInfo) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

/**
 * Agrupa o snapshot em salas (ordenadas por slot) -> agentes principais -> subagentes.
 * Subagentes cujo pai não está na mesma sala viram itens de primeiro nível.
 * Com filtro: um principal aparece se ele ou algum subagente bater; se o principal bate, todos os subs aparecem.
 * Salas sem nenhum agente visível são omitidas (exceto sem filtro ativo).
 */
export function groupRooms(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'> | null, filter?: AgentFilter): RoomGroup[] {
  if (!snap) return [];
  const accounts = new Map(snap.accounts.map((a) => [a.id, a]));
  const accountOrder = new Map(snap.accounts.map((a, i) => [a.id, i]));
  const query = filter?.query.trim() ?? '';
  const hidden = filter?.hiddenAccounts ?? new Set<string>();
  const filtering = query.length > 0 || hidden.size > 0;

  const byRoom = new Map<string, AgentInfo[]>();
  for (const a of snap.agents) {
    let list = byRoom.get(a.roomId);
    if (!list) byRoom.set(a.roomId, (list = []));
    list.push(a);
  }

  const groups: RoomGroup[] = [];
  for (const room of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
    const agents = (byRoom.get(room.id) ?? []).slice().sort(byArrival);
    const visible = (a: AgentInfo) => !hidden.has(a.account) && matchesQuery(a, room, accounts.get(a.account), query);
    const ids = new Set(agents.map((a) => a.id));
    const subsOf = new Map<string, AgentInfo[]>();
    const top: AgentInfo[] = [];
    for (const a of agents) {
      if (a.kind === 'sub' && a.parentId && ids.has(a.parentId)) {
        let list = subsOf.get(a.parentId);
        if (!list) subsOf.set(a.parentId, (list = []));
        list.push(a);
      } else {
        top.push(a);
      }
    }

    const nodes: AgentNode[] = [];
    let matches = 0;
    for (const a of top) {
      const subs = subsOf.get(a.id) ?? [];
      const selfVisible = visible(a);
      const visibleSubs = selfVisible ? subs.filter((s) => !hidden.has(s.account)) : subs.filter(visible);
      if (!selfVisible && visibleSubs.length === 0) continue;
      matches += (selfVisible ? 1 : 0) + visibleSubs.length;
      nodes.push({ agent: a, subs: visibleSubs, subTotal: subs.length });
    }
    if (filtering && nodes.length === 0) continue;

    const present = [...new Set(agents.map((a) => a.account))].sort((x, y) => (accountOrder.get(x) ?? 99) - (accountOrder.get(y) ?? 99));
    groups.push({ room, accounts: present, nodes, agents, tasks: aggregateTasks(agents), matches });
  }
  return groups;
}

/** Contas distintas presentes em uma lista de agentes, na ordem das contas do snapshot. */
export function accountsOf(agents: readonly Pick<AgentInfo, 'account'>[], accounts: readonly Pick<AccountInfo, 'id'>[]): string[] {
  const present = new Set(agents.map((a) => a.account));
  const ordered = accounts.map((a) => a.id).filter((id) => present.has(id));
  for (const id of present) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/** Ordena por urgência e depois por chegada (para listas de subagentes na gaveta). */
export function sortByUrgency(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.slice().sort((a, b) => STATUS_URGENCY[a.status] - STATUS_URGENCY[b.status] || byArrival(a, b));
}

/** Atalhos de shell para o texto do estado vazio: ["c", "d"] -> "atalhos c ou d". */
export function shortcutHint(accounts: readonly Pick<AccountInfo, 'short'>[]): string {
  const keys = accounts.map((a) => a.short.toLowerCase()).filter((s) => /^[a-z0-9]{1,3}$/.test(s));
  if (keys.length === 0) return '';
  if (keys.length === 1) return `atalho ${keys[0]}`;
  return `atalhos ${keys.slice(0, -1).join(', ')} ou ${keys[keys.length - 1]}`;
}

/** Mescla histórico longo (servidor) com as atividades recentes, sem duplicar, do mais antigo ao mais recente. */
export function mergeHistory<T extends { id: string; at: number }>(history: readonly T[], recent: readonly T[], limit = 200): T[] {
  const seen = new Map<string, T>();
  for (const a of history) seen.set(a.id, a);
  for (const a of recent) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => a.at - b.at).slice(-limit);
}
