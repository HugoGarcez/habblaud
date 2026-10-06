import { describe, expect, it } from 'vitest';
import type { AccountInfo, AgentInfo, RoomInfo } from '../../../shared/types';
import { accountsOf, activityFallback, aggregateTasks, computeCounters, groupRooms, matchesQuery, mergeHistory, roleLabel, shortcutHint, sortByUrgency, waitingAgents } from './model';

function agent(p: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'roomId'>): AgentInfo {
  return {
    kind: 'main',
    name: p.id,
    look: 'f',
    role: p.kind === 'sub' ? 'Explore' : 'Agente principal',
    sessionId: `s-${p.id}`,
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...p,
  };
}

function room(id: string, slot: number, path = `/Users/dev/projetos/${id}`): RoomInfo {
  return { id, name: id, path, slot, seed: slot, createdAt: 0 };
}

const accounts: AccountInfo[] = [
  { id: '.claude', short: 'C', name: 'Conta C', email: 'dev@empresa.example', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' },
  { id: '.claude-conta2', short: 'D', name: 'Conta D', email: 'eu@pessoal.example', color: '#4aa8e8', configDir: '~/.claude-conta2', sessions: 1, usageStatus: 'disabled' },
];

const rooms = [room('loja', 2), room('api', 0), room('site', 1)];
const agents: AgentInfo[] = [
  agent({ id: 'marina', name: 'Marina', roomId: 'api', startedAt: 10, status: 'waiting', statusSince: 50 }),
  agent({ id: 'joao', name: 'João', roomId: 'api', startedAt: 5, account: '.claude-conta2', tasks: [{ id: '1', title: 'a', status: 'completed' }, { id: '2', title: 'b', status: 'in_progress' }] }),
  agent({ id: 'sub1', name: 'Bruno', kind: 'sub', parentId: 'joao', roomId: 'api', startedAt: 20, role: 'Explore', account: '.claude-conta2' }),
  agent({ id: 'sub2', name: 'Clara', kind: 'sub', parentId: 'joao', roomId: 'api', startedAt: 15, role: 'Plan', status: 'done', account: '.claude-conta2' }),
  agent({ id: 'orfao', name: 'Diego', kind: 'sub', parentId: 'sumiu', roomId: 'site', startedAt: 1 }),
  agent({ id: 'saindo', name: 'Elisa', roomId: 'loja', status: 'offline', tasks: [{ id: '1', title: 'x', status: 'pending' }] }),
  agent({ id: 'ana', name: 'Ana', roomId: 'loja', status: 'waiting', statusSince: 20 }),
];
const snap = { rooms, agents, accounts };

describe('computeCounters', () => {
  it('conta salas, agentes presentes, trabalhando, subagentes ativos e esperando', () => {
    expect(computeCounters(snap)).toEqual({ rooms: 3, agents: 6, working: 3, subagents: 2, waiting: 2 });
    expect(computeCounters(null)).toEqual({ rooms: 0, agents: 0, working: 0, subagents: 0, waiting: 0 });
  });
  it('waitingAgents ordena por quem espera há mais tempo', () => {
    expect(waitingAgents(agents).map((a) => a.id)).toEqual(['ana', 'marina']);
  });
});

describe('groupRooms', () => {
  it('ordena salas por slot e aninha subagentes sob o pai', () => {
    const g = groupRooms(snap);
    expect(g.map((r) => r.room.id)).toEqual(['api', 'site', 'loja']);
    const api = g[0];
    expect(api.nodes.map((n) => n.agent.id)).toEqual(['joao', 'marina']);
    expect(api.nodes[0].subs.map((s) => s.id)).toEqual(['sub2', 'sub1']);
    expect(api.nodes[0].subTotal).toBe(2);
    expect(api.accounts).toEqual(['.claude', '.claude-conta2']);
    expect(api.tasks).toEqual({ completed: 1, inProgress: 1, total: 2 });
  });
  it('subagente sem pai na sala vira item de primeiro nível', () => {
    const site = groupRooms(snap).find((r) => r.room.id === 'site')!;
    expect(site.nodes.map((n) => n.agent.id)).toEqual(['orfao']);
  });
  it('filtra por texto sem acentos (nome do subagente mantém o pai como contexto)', () => {
    const g = groupRooms(snap, { query: 'bruno', hiddenAccounts: new Set() });
    expect(g.map((r) => r.room.id)).toEqual(['api']);
    expect(g[0].nodes.map((n) => n.agent.id)).toEqual(['joao']);
    expect(g[0].nodes[0].subs.map((s) => s.id)).toEqual(['sub1']);
    expect(g[0].matches).toBe(1);
  });
  it('se o principal bate, mostra todos os subagentes', () => {
    const g = groupRooms(snap, { query: 'joao', hiddenAccounts: new Set() });
    expect(g[0].nodes[0].subs).toHaveLength(2);
  });
  it('busca por sala/caminho e por conta', () => {
    expect(groupRooms(snap, { query: 'projetos/loja', hiddenAccounts: new Set() }).map((r) => r.room.id)).toEqual(['loja']);
    const byAccount = groupRooms(snap, { query: 'pessoal', hiddenAccounts: new Set() });
    expect(byAccount.flatMap((r) => r.nodes.map((n) => n.agent.id))).toEqual(['joao']);
  });
  it('oculta contas desligadas no filtro', () => {
    const g = groupRooms(snap, { query: '', hiddenAccounts: new Set(['.claude-conta2']) });
    const api = g.find((r) => r.room.id === 'api')!;
    expect(api.nodes.map((n) => n.agent.id)).toEqual(['marina']);
    const onlyD = groupRooms(snap, { query: '', hiddenAccounts: new Set(['.claude']) });
    expect(onlyD.map((r) => r.room.id)).toEqual(['api']);
  });
  it('sem snapshot devolve lista vazia', () => {
    expect(groupRooms(null)).toEqual([]);
  });
});

describe('utilidades', () => {
  it('matchesQuery exige todos os termos', () => {
    const a = agents[0];
    expect(matchesQuery(a, rooms[1], accounts[0], 'marina api')).toBe(true);
    expect(matchesQuery(a, rooms[1], accounts[0], 'marina loja')).toBe(false);
    expect(matchesQuery(a, rooms[1], accounts[0], '   ')).toBe(true);
  });
  it('roleLabel', () => {
    expect(roleLabel({ kind: 'main', role: 'Agente principal' })).toBe('Agente principal');
    expect(roleLabel({ kind: 'sub', role: '' })).toBe('Subagente');
  });
  it('aggregateTasks soma tarefas de vários agentes', () => {
    expect(aggregateTasks(agents)).toEqual({ completed: 1, inProgress: 1, total: 3 });
  });
  it('accountsOf respeita a ordem das contas', () => {
    expect(accountsOf([{ account: '.claude-conta2' }, { account: '.claude' }, { account: 'x' }], accounts)).toEqual(['.claude', '.claude-conta2', 'x']);
  });
  it('sortByUrgency coloca quem precisa de você primeiro', () => {
    expect(sortByUrgency(agents.filter((a) => a.roomId === 'api')).map((a) => a.id)).toEqual(['marina', 'joao', 'sub1', 'sub2']);
  });
  it('shortcutHint', () => {
    expect(shortcutHint(accounts)).toBe('atalhos c ou d');
    expect(shortcutHint([accounts[0]])).toBe('atalho c');
    expect(shortcutHint([{ short: 'C' }, { short: 'D' }, { short: 'E' }])).toBe('atalhos c, d ou e');
    expect(shortcutHint([])).toBe('');
  });
  it('mergeHistory deduplica e ordena por horário', () => {
    const h = [
      { id: 'a', at: 1 },
      { id: 'b', at: 3 },
    ];
    const r = [
      { id: 'b', at: 3 },
      { id: 'c', at: 2 },
    ];
    expect(mergeHistory(h, r).map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(mergeHistory(h, r, 2).map((x) => x.id)).toEqual(['c', 'b']);
  });
});

describe('activityFallback', () => {
  it('sem atividade ainda: texto pelo status, nunca "Chegando…" para quem já está sentado', () => {
    expect(activityFallback({ status: 'idle' })).toBe('Aguardando instruções');
    expect(activityFallback({ status: 'working' })).toBe('Trabalhando…');
    expect(activityFallback({ status: 'waiting', waitingFor: 'aprovar uma permissão' })).toBe('Precisa de você: aprovar uma permissão');
    expect(activityFallback({ status: 'waiting' })).toBe('Precisa de você');
    expect(activityFallback({ status: 'done' })).toBe('Concluiu a tarefa');
    expect(activityFallback({ status: 'offline' })).toBe('Saindo do escritório');
  });
});
