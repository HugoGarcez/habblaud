// Planejamento: cotas por IA (contas do escritório), roteador (IA sem cota, dependências, escrita em sequência),
// planejador (`claude -p` falso: argumentos, conta, saída) e o fluxo do serviço (Planejando → Aguardando aprovação →
// na fila; falha; edição; descarte; reinício). CLIs falsas; dados sintéticos.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentQuota } from '../../shared/board';
import type { AccountInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { agentOfAccount, agentQuotas, bestClaudeAccount } from './agents';
import type { Exec } from './cli';
import { plannerPrompt, runPlanner } from './planner';
import { route } from './router';
import { BoardService, planMarkdown } from './service';
import { BoardStore } from './store';

setQuiet(true);

const NOW = Date.parse('2026-10-14T12:00:00Z');

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function acc(id: string, five?: number, week?: number, extra: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    short: 'X',
    name: id,
    color: '#fff',
    configDir: `/c/${id}`,
    sessions: 0,
    usageStatus: 'ok',
    usage: { source: 'statusline', fetchedAt: NOW, ...(five !== undefined ? { fiveHour: { utilization: five } } : {}), ...(week !== undefined ? { sevenDay: { utilization: week } } : {}) },
    ...extra,
  };
}

const ALL = new Set(['claude', 'codex', 'antigravity', 'opencode'] as const);

function quota(agent: AgentQuota['agent'], available = true): AgentQuota {
  return { agent, name: agent, installed: true, available, strengths: '', ...(available ? {} : { reason: 'sem cota agora' }) };
}

describe('cotas das IAs', () => {
  it('conta → IA', () => {
    expect(agentOfAccount({ id: '.claude' })).toBe('claude');
    expect(agentOfAccount({ id: '.codex', provider: 'codex' })).toBe('codex');
    expect(agentOfAccount({ id: 'orca:antigravity~Claude/GPT' })).toBe('antigravity');
    expect(agentOfAccount({ id: 'orca:opencode' })).toBe('opencode');
    expect(agentOfAccount({ id: 'orca:gemini' })).toBeUndefined();
  });

  it('a conta com mais folga decide; 5 h ≥ 90% ou semana ≥ 95% ou sem cota bloqueia; sem CLI = indisponível', () => {
    const qs = agentQuotas(
      [
        acc('.claude', 95, 10),
        acc('.claude-b', 20, 30),
        acc('.codex', 10, 96, { provider: 'codex' }),
        acc('orca:antigravity', undefined, 31, { usage: { source: 'antigravity', fetchedAt: NOW, noQuota: true } }),
      ],
      new Set(['claude', 'codex', 'antigravity']),
    );
    const by = Object.fromEntries(qs.map((q) => [q.agent, q]));
    expect(by.claude).toMatchObject({ available: true, fiveHour: 20, sevenDay: 30 });
    expect(by.codex).toMatchObject({ available: false, reason: 'cota quase no fim' });
    expect(by.antigravity).toMatchObject({ available: false, reason: 'sem cota agora' });
    expect(by.opencode).toMatchObject({ available: false, installed: false });
    expect(bestClaudeAccount([acc('.claude', 95, 10), acc('.claude-b', 20, 30)])?.id).toBe('.claude-b');
    expect(bestClaudeAccount([acc('.claude', 95, 10)])).toBeUndefined();
  });
});

describe('roteador', () => {
  const a = (over: Record<string, unknown>) => ({ id: 'a1', title: 'T', instructions: 'faça', type: 'implementation', agent: 'codex', writes: true, deps: [], reason: 'r', ...over });

  it('troca IA indisponível pela preferência do tipo e anota', () => {
    const r = route([a({ agent: 'codex' })], [quota('codex', false), quota('claude'), quota('antigravity'), quota('opencode')]);
    expect(r.actions[0].agent).toBe('claude');
    expect(r.notes[0]).toMatch(/vai com Claude/);
    const none = route([a({})], [quota('codex', false), quota('claude', false), quota('antigravity', false), quota('opencode', false)]);
    expect(none.actions[0].agent).toBe('codex');
    expect(none.notes[0]).toMatch(/nenhuma IA disponível/);
  });

  it('ids únicos, deps só para trás, escrita em sequência, sem título/instruções sai, máximo 8', () => {
    const q = [quota('codex'), quota('claude'), quota('antigravity'), quota('opencode')];
    const r = route(
      [
        a({ id: 'a1', type: 'analysis', agent: 'antigravity', writes: false }),
        a({ id: 'a2', deps: ['a1', 'a9'] }),
        a({ id: 'a2', title: 'Testes', type: 'tests', deps: [] }),
        a({ id: 'a4', title: '', instructions: '' }),
        a({ id: 'a5', type: 'review', agent: 'claude', writes: false, deps: ['a2'] }),
      ],
      q,
    );
    expect(r.actions.map((x) => [x.id, x.deps])).toEqual([
      ['a1', []],
      ['a2', ['a1']],
      ['a2-3', ['a2']],
      ['a5', ['a2']],
    ]);
    expect(route(Array.from({ length: 10 }, (_, i) => a({ id: `x${i}` })), q).actions).toHaveLength(8);
  });

  it('campos inválidos ganham padrão', () => {
    const r = route([{ title: 'T', instructions: 'i', type: 'xx', agent: 'yy' }], [quota('codex')]);
    expect(r.actions[0]).toMatchObject({ id: 'a1', type: 'implementation', agent: 'codex', writes: true, deps: [] });
  });
});

describe('planejador', () => {
  const project = { id: 'p', name: 'Loja', path: '/p/loja', github: 'o/loja', source: 'github' as const };
  const card = { id: 'github:1', source: 'github' as const, ref: '#1', title: 'Login quebra', body: 'detalhes', url: 'u', kind: 'fix' as const, column: 'backlog' as const, labels: [], state: 'open', updatedAt: 0 };

  it('prompt com o card e a tabela de IAs', () => {
    const p = plannerPrompt(project, card, [quota('codex'), quota('claude', false)]);
    expect(p).toContain('Card #1 (correção de bug): Login quebra');
    expect(p).toContain('| codex |');
    expect(p).toContain('não (sem cota agora)');
  });

  it('roda claude -p só leitura, na pasta e na conta; lê structured_output ou result', async () => {
    let seen: { args: string[]; cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
    const exec: Exec = async (_bin, args, opts) => {
      seen = { args, cwd: opts?.cwd, env: opts?.env };
      return JSON.stringify({ is_error: false, structured_output: { summary: 'S', actions: [{ id: 'a1' }] } });
    };
    const r = await runPlanner({ claude: 'claude', cwd: '/p/loja', configDir: '/c/.claude-b', model: 'sonnet', exec, env: {} }, 'oi');
    expect(r).toEqual({ summary: 'S', actions: [{ id: 'a1' }] });
    expect(seen?.cwd).toBe('/p/loja');
    expect(seen?.env?.CLAUDE_CONFIG_DIR).toBe('/c/.claude-b');
    expect(seen?.args).toEqual(expect.arrayContaining(['-p', 'oi', '--json-schema', '--allowedTools', 'Read,Grep,Glob', '--setting-sources', 'project', '--strict-mcp-config']));
    const viaResult: Exec = async () => JSON.stringify({ result: JSON.stringify({ summary: 'R', actions: [] }) });
    expect((await runPlanner({ claude: 'c', cwd: '/', model: 'm', exec: viaResult }, 'x')).summary).toBe('R');
    await expect(runPlanner({ claude: 'c', cwd: '/', model: 'm', exec: async () => JSON.stringify({ is_error: true, result: 'Not logged in' }) }, 'x')).rejects.toThrow('Not logged in');
    await expect(runPlanner({ claude: 'c', cwd: '/', model: 'm', exec: async () => 'lixo' }, 'x')).rejects.toThrow();
  });
});

describe('fluxo do serviço', () => {
  function setup(plannerOut: () => Promise<string>) {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const file = join(tmp.dir, 'board.json');
    const store = new BoardStore(file);
    const calls: string[][] = [];
    const exec: Exec = async (bin, args) => {
      calls.push([bin, ...args]);
      const cmd = args.join(' ');
      if (cmd === 'project list --json') return JSON.stringify({ ok: true, result: { projects: [{ id: 'p', displayName: 'p', sourceRepoIds: ['r'] }] } });
      if (cmd === 'repo list --json') return JSON.stringify({ ok: true, result: { repos: [{ id: 'r', path: '/p' }] } });
      if (cmd === 'linear team list --json') return JSON.stringify({ ok: false, error: { message: 'x' } });
      if (args[0] === '-C') return 'https://github.com/o/r.git';
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 1, title: 'Bug', url: 'u', state: 'OPEN', updatedAt: new Date(NOW).toISOString() }]);
      if (args[0] === 'issue' && args[1] === 'comment') return '';
      if (bin === 'claude') return plannerOut();
      throw new Error(`inesperado: ${cmd}`);
    };
    const board = new BoardService({
      store,
      orca: 'orca',
      gh: 'gh',
      git: 'git',
      exec,
      now: () => NOW,
      claude: 'claude',
      installed: ALL,
      accounts: () => [acc('.claude', 10, 10), acc('.codex', 10, 10, { provider: 'codex' })],
    });
    return { board, store, file, calls };
  }

  const planJson = JSON.stringify({
    structured_output: {
      summary: 'Corrigir o login',
      actions: [
        { id: 'a1', title: 'Corrigir', instructions: 'mude x', type: 'implementation', agent: 'codex', writes: true, deps: [], reason: 'direto' },
        { id: 'a2', title: 'Revisar', instructions: 'revise', type: 'review', agent: 'claude', writes: false, deps: ['a1'], reason: 'outra IA' },
      ],
    },
  });

  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('planejar → aguardando aprovação → editar → aprovar (comenta na issue)', async () => {
    const { board, calls } = setup(async () => planJson);
    const started = await board.plan('p', 'github:1');
    expect('ok' in started && started.ok.column).toBe('planning');
    expect(await board.plan('p', 'github:1')).toMatchObject({ status: 409 });
    await settle();
    let v = await board.view('p');
    expect(v?.cards[0]).toMatchObject({ column: 'approval', work: { stage: 'approval', plan: { summary: 'Corrigir o login', model: 'sonnet' } } });
    expect(v?.agents.find((q) => q.agent === 'codex')?.available).toBe(true);

    const plan = v!.cards[0].work!.plan!;
    const edited = await board.editPlan('p', 'github:1', { actions: [{ ...plan.actions[0], agent: 'claude' }] });
    expect('ok' in edited && edited.ok.work?.plan?.actions.map((a) => a.agent)).toEqual(['claude']);

    const approved = await board.approve('p', 'github:1');
    expect('ok' in approved && approved.ok.column).toBe('running');
    await settle();
    const comment = calls.find((c) => c[1] === 'issue' && c[2] === 'comment')!;
    expect(comment.slice(3, 6)).toEqual(['1', '--repo', 'o/r']);
    expect(comment[comment.indexOf('--body') + 1]).toMatch(/Plano do Promp IA[\s\S]*1\. \*\*Corrigir\*\* · Claude/);
    expect(await board.editPlan('p', 'github:1', { actions: [] })).toMatchObject({ status: 409 });
    v = await board.view('p');
    expect(v?.cards[0].work?.stage).toBe('queued');
  });

  it('planejamento que falha volta à coluna da fonte com o erro; descartar limpa', async () => {
    const { board } = setup(async () => JSON.stringify({ is_error: true, result: 'Credit balance too low' }));
    await board.plan('p', 'github:1');
    await settle();
    const card = (await board.view('p'))!.cards[0];
    expect(card).toMatchObject({ column: 'backlog', work: { stage: 'failed', error: expect.stringMatching(/Credit balance too low/) } });
    expect(await board.approve('p', 'github:1')).toMatchObject({ status: 409 });
    await board.discard('p', 'github:1');
    expect((await board.view('p'))!.cards[0].work).toBeUndefined();
  });

  it('descartar durante o planejamento: o plano que chega depois é ignorado', async () => {
    let release!: (v: string) => void;
    const { board } = setup(() => new Promise((r) => (release = r)));
    await board.plan('p', 'github:1');
    await board.discard('p', 'github:1');
    release(planJson);
    await settle();
    expect((await board.view('p'))!.cards[0].work).toBeUndefined();
  });

  it('reinício: planejamento interrompido vira falha', () => {
    const { store, file } = setup(async () => planJson);
    store.setWork('p', 'github:1', { stage: 'planning', updatedAt: NOW });
    const again = new BoardStore(file);
    again.load();
    new BoardService({ store: again, orca: 'orca', exec: async () => '', now: () => NOW });
    expect(again.work('p', 'github:1')).toMatchObject({ stage: 'failed', error: expect.stringMatching(/interrompido/) });
  });

  it('card desconhecido = 404', async () => {
    const { board } = setup(async () => planJson);
    expect(await board.plan('p', 'github:99')).toMatchObject({ status: 404 });
  });

  it('planMarkdown lista as ações com IA e dependências', () => {
    const md = planMarkdown({
      summary: 'S',
      model: 'sonnet',
      createdAt: NOW,
      notes: ['nota'],
      actions: [
        { id: 'a1', title: 'A', instructions: 'i', type: 'analysis', agent: 'antigravity', writes: false, deps: [], reason: 'r' },
        { id: 'a2', title: 'B', instructions: 'i', type: 'implementation', agent: 'codex', writes: true, deps: ['a1'], reason: '' },
      ],
    });
    expect(md).toContain('1. **A** · Antigravity (Gemini)');
    expect(md).toContain('2. **B** · Codex · depois de 1');
    expect(md).toContain('> nota');
  });
});
