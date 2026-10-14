// Execução dos cards: preparação (terminal coordenador, Run, worktree, Tasks com dependências), workers por Task
// pronta (limite e cota), perguntas e respostas, falha → travado → tentar de novo, finalização (commit, push, PR) e
// cancelamento. Orca, git e gh falsos (um Orca com estado mínimo); dados sintéticos.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentQuota, BoardCard, BoardProject, CardPlan } from '../../shared/board';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { CliError, type Exec } from './cli';
import { BoardRunner, taskSpec, workerSummary, worktreeName } from './runner';
import { BoardStore } from './store';

setQuiet(true);

const NOW = Date.parse('2026-10-14T12:00:00Z');
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const project: BoardProject = { id: 'p', name: 'Loja', path: '/repo', github: 'o/loja', source: 'github' };
const card: BoardCard = { id: 'github:7', source: 'github', ref: '#7', title: 'Corrigir Login', body: '', url: 'u', kind: 'fix', column: 'backlog', labels: [], state: 'open', updatedAt: 0 };
const plan: CardPlan = {
  summary: 'S',
  model: 'sonnet',
  createdAt: NOW,
  notes: [],
  actions: [
    { id: 'a1', title: 'Implementar', instructions: 'faça', type: 'implementation', agent: 'codex', writes: true, deps: [], reason: '' },
    { id: 'a2', title: 'Revisar', instructions: 'revise', type: 'review', agent: 'claude', writes: false, deps: ['a1'], reason: '' },
  ],
};

const ok = (result: unknown) => JSON.stringify({ ok: true, result });

/** Orca falso: guarda Tasks e mensagens; `fail` injeta erros por comando. */
function fakeOrca() {
  const state = {
    tasks: [] as { id: string; status: string; deps: string[]; result?: string }[],
    messages: [] as unknown[],
    calls: [] as string[][],
    fail: new Map<string, () => never>(),
    worktreeCreated: false,
    gitStatus: ' M a.ts',
    replies: [] as string[][],
  };
  const exec: Exec = async (bin, args) => {
    state.calls.push([bin, ...args]);
    const cmd = args.slice(0, 2).join(' ');
    const f = state.fail.get(cmd);
    if (f) {
      state.fail.delete(cmd);
      f();
    }
    const val = (flag: string) => args[args.indexOf(flag) + 1];
    if (bin === 'git') {
      const sub = args[2];
      if (sub === 'status') return state.gitStatus;
      if (sub === 'symbolic-ref') return 'origin/main\n';
      if (sub === 'rev-list') return state.gitStatus ? '1\n' : '0\n';
      return '';
    }
    if (bin === 'gh') {
      if (args[0] === 'pr' && args[1] === 'view') throw new CliError('no pull requests found');
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/o/loja/pull/9\n';
      return '';
    }
    switch (cmd) {
      case 'terminal show':
        return JSON.stringify({ ok: false, error: { code: 'not_found', message: 'x' } });
      case 'terminal create':
        return ok({ terminal: { handle: 'term_c' } });
      case 'orchestration run-create':
        return ok({ run: { id: 'run_1' } });
      case 'worktree list':
        return ok({ worktrees: state.worktreeCreated ? [{ id: 'r::/wt/promp-7', path: '/wt/promp-7', branch: 'refs/heads/me/promp-7', displayName: worktreeName(card) }] : [] });
      case 'worktree create':
        state.worktreeCreated = true;
        return ok({ worktree: { id: 'r::/wt/promp-7', path: '/wt/promp-7', branch: 'refs/heads/me/promp-7' } });
      case 'orchestration task-create': {
        const deps = JSON.parse(val('--deps')) as string[];
        const t = { id: `task_${state.tasks.length + 1}`, status: deps.length ? 'pending' : 'ready', deps };
        state.tasks.push(t);
        return ok({ task: { id: t.id } });
      }
      case 'orchestration task-list':
        return ok({ tasks: state.tasks });
      case 'orchestration worker-start': {
        const t = state.tasks.find((x) => x.id === val('--task'))!;
        t.status = 'dispatched';
        return ok({ dispatch: { id: `d_${t.id}` } });
      }
      case 'orchestration worker-list':
        return ok({ workers: [] });
      case 'orchestration inbox':
        return ok({ messages: state.messages });
      case 'orchestration reply':
        state.replies.push(args);
        return ok({});
      default:
        return ok({});
    }
  };
  /** Conclui uma Task e libera as que dependiam dela. */
  const complete = (id: string, result = 'feito') => {
    const t = state.tasks.find((x) => x.id === id)!;
    Object.assign(t, { status: 'completed', result });
    for (const o of state.tasks) if (o.status === 'pending' && o.deps.every((d) => state.tasks.find((x) => x.id === d)?.status === 'completed')) o.status = 'ready';
  };
  return { state, exec, complete };
}

function setup(opts: { quotas?: Partial<Record<string, boolean>>; maxWorkers?: number } = {}) {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const store = new BoardStore(join(tmp.dir, 'board.json'));
  const orca = fakeOrca();
  const agents = (): AgentQuota[] =>
    (['claude', 'codex', 'antigravity', 'opencode'] as const).map((a) => ({ agent: a, name: a, installed: true, available: opts.quotas?.[a] ?? true, strengths: '', reason: opts.quotas?.[a] === false ? 'sem cota agora' : undefined }));
  const runner = new BoardRunner({ store, exec: orca.exec, orca: 'orca', gh: 'gh', git: 'git', now: () => NOW, lookup: async () => ({ project, card }), agents, maxWorkers: opts.maxWorkers });
  store.setWork('p', card.id, { stage: 'queued', plan, updatedAt: NOW });
  return { store, runner, ...orca };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const work = (s: BoardStore) => s.work('p', card.id)!;

describe('runner', () => {
  it('resumo do worker: body do worker_done com os arquivos; texto puro fica como veio', () => {
    expect(workerSummary(JSON.stringify({ subject: 'README criado', body: 'Criei o README.', filesModified: ['README.md'] }))).toBe('Criei o README. (README.md)');
    expect(workerSummary(JSON.stringify({ subject: 'Só o assunto' }))).toBe('Só o assunto');
    expect(workerSummary('feito')).toBe('feito');
    expect(workerSummary(null)).toBeUndefined();
  });

  it('nome do worktree e instruções da Task', () => {
    expect(worktreeName({ ref: '#7', title: 'Corrigir o Login: ação já!' })).toBe('promp-7-corrigir-o-login-acao-ja');
    expect(worktreeName({ ref: 'PRO-3', title: 'x'.repeat(80) })).toHaveLength(48);
    const spec = taskSpec(project, card, plan.actions[0], 0, 2, { path: '/wt', branch: 'b' });
    expect(spec).toContain('Ação 1 de 2: Implementar');
    expect(spec).toContain('NÃO faça commit');
  });

  it('do aprovado ao PR: coordenador, Run, worktree, Tasks em ordem, workers e finalização', async () => {
    const { store, runner, state, complete } = setup();
    await runner.tick();
    expect(work(store).stage).toBe('running');
    expect(store.coordinator('p')).toBe('term_c');
    const run = work(store).run!;
    expect(run.runId).toBe('run_1');
    expect(run.worktree).toEqual({ id: 'r::/wt/promp-7', path: '/wt/promp-7', branch: 'refs/heads/me/promp-7', repoPath: '/repo' });
    const creates = state.calls.filter((c) => c[2] === 'task-create');
    expect(creates).toHaveLength(2);
    expect(creates[1][creates[1].indexOf('--deps') + 1]).toBe('["task_1"]');
    expect(creates[0]).toEqual(expect.arrayContaining(['--from', 'term_c', '--run', 'run_1', '--retry-request']));
    const wt = state.calls.find((c) => c[1] === 'worktree' && c[2] === 'create')!;
    expect(wt).toEqual(expect.arrayContaining(['--issue', '7', '--repo', 'path:/repo', '--setup', 'skip']));

    await runner.tick();
    await settle();
    const starts = state.calls.filter((c) => c[2] === 'worker-start');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual(expect.arrayContaining(['--task', 'task_1', '--agent', 'codex', '--worktree', 'path:/wt/promp-7']));
    expect(work(store).run!.actions.a1).toMatchObject({ state: 'running', dispatchId: 'd_task_1' });

    complete('task_1', 'mudei o login');
    await runner.tick();
    await settle();
    expect(work(store).run!.actions.a1).toMatchObject({ state: 'done', result: 'mudei o login' });
    expect(state.calls.filter((c) => c[2] === 'worker-start').pop()).toEqual(expect.arrayContaining(['--task', 'task_2', '--agent', 'claude']));

    complete('task_2');
    await runner.tick();
    await settle();
    await settle();
    const w = work(store);
    expect(w.stage).toBe('review');
    expect(w.run!.pr).toEqual({ url: 'https://github.com/o/loja/pull/9', number: 9 });
    const commit = state.calls.find((c) => c[0] === 'git' && c[3] === 'commit')!;
    expect(commit[5]).toMatch(/^Corrigir Login\n\nCloses #7/);
    expect(state.calls.some((c) => c[0] === 'git' && c[3] === 'push')).toBe(true);
    const pr = state.calls.find((c) => c[0] === 'gh' && c[2] === 'create')!;
    expect(pr).toEqual(expect.arrayContaining(['--head', 'me/promp-7', '--base', 'main', '--title', 'Corrigir Login']));
    expect(state.calls.filter((c) => c[2] === 'worker-release')).toHaveLength(2);
  });

  it('worktree criado apesar do erro da CLI: acha pela lista', async () => {
    const { store, runner, state } = setup();
    state.fail.set('worktree create', () => {
      state.worktreeCreated = true;
      throw new CliError('The Orca runtime closed the connection', 'runtime_unavailable');
    });
    await runner.tick();
    expect(work(store).run!.worktree?.path).toBe('/wt/promp-7');
  });

  it('run-create com resposta perdida: repete com o mesmo --retry-request', async () => {
    const { store, runner, state } = setup();
    state.fail.set('orchestration run-create', () => {
      throw new CliError('closed', 'runtime_unavailable');
    });
    await runner.tick();
    const reqs = state.calls.filter((c) => c[2] === 'run-create').map((c) => c[c.indexOf('--retry-request') + 1]);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toBe(reqs[1]);
    expect(work(store).stage).toBe('running');
  });

  it('preparação que falha trava o card; tentar de novo recomeça', async () => {
    const { store, runner, state } = setup();
    state.fail.set('terminal create', () => {
      throw new CliError('sem Orca', 'runtime_down');
    });
    await runner.tick();
    expect(work(store)).toMatchObject({ stage: 'blocked', error: expect.stringMatching(/sem Orca/) });
    expect(await runner.retry('p', card.id)).toBeUndefined();
    await settle();
    expect(work(store).stage).toBe('running');
  });

  it('IA sem cota espera; limite de workers vale para o quadro', async () => {
    const { store, runner, state } = setup({ quotas: { codex: false } });
    await runner.tick();
    await runner.tick();
    expect(state.calls.some((c) => c[2] === 'worker-start')).toBe(false);
    expect(work(store).run!.actions.a1.waitingFor).toMatch(/esperando codex \(sem cota agora\)/i);

    const b = setup({ maxWorkers: 0 });
    await b.runner.tick();
    await b.runner.tick();
    expect(work(b.store).run!.actions.a1.waitingFor).toMatch(/esperando vaga/);
  });

  it('pergunta de worker aparece; resposta vai por reply e não volta', async () => {
    const { store, runner, state } = setup();
    await runner.tick();
    state.messages.push({ id: 'msg_1', type: 'question', subject: 'Qual banco?', body: 'Postgres ou SQLite?', to_handle: 'run:run_1', payload: { options: ['Postgres', 'SQLite'] } });
    state.messages.push({ id: 'msg_x', type: 'question', subject: 'outro run', to_handle: 'run:run_9' });
    await runner.tick();
    expect(work(store).run!.questions).toEqual([expect.objectContaining({ id: 'msg_1', text: 'Qual banco?\nPostgres ou SQLite?', options: ['Postgres', 'SQLite'] })]);
    expect(await runner.answer('p', card.id, 'msg_1', 'SQLite')).toBeUndefined();
    expect(state.replies[0]).toEqual(expect.arrayContaining(['--id', 'msg_1', '--body', 'SQLite', '--from', 'term_c']));
    await runner.tick();
    expect(work(store).run!.questions).toEqual([]);
    expect(await runner.answer('p', card.id, 'msg_1', 'de novo')).toMatch(/desconhecida/);
  });

  it('Task que falha trava; tentar de novo usa --retry-of', async () => {
    const { store, runner, state } = setup();
    await runner.tick();
    await runner.tick();
    await settle();
    state.tasks[0].status = 'failed';
    state.tasks[0].result = 'testes quebraram';
    await runner.tick();
    expect(work(store)).toMatchObject({ stage: 'blocked', error: expect.stringMatching(/Implementar.*testes quebraram/) });
    state.tasks[0].status = 'ready';
    await runner.retry('p', card.id);
    await settle();
    const last = state.calls.filter((c) => c[2] === 'worker-start').pop()!;
    expect(last).toEqual(expect.arrayContaining(['--retry-of', 'd_task_1', '--task', 'task_1']));
    expect(work(store).stage).toBe('running');
  });

  it('sem mudanças nos arquivos: vai para revisão sem PR', async () => {
    const { store, runner, state, complete } = setup();
    state.gitStatus = '';
    await runner.tick();
    await runner.tick();
    await settle();
    complete('task_1');
    await runner.tick();
    await settle();
    complete('task_2');
    await runner.tick();
    await settle();
    await settle();
    expect(work(store).stage).toBe('review');
    expect(work(store).run!.pr).toBeUndefined();
    expect(state.calls.some((c) => c[0] === 'gh')).toBe(false);
  });

  it('cancelar para os workers, marca as Tasks e tira o card do quadro', async () => {
    const { store, runner, state } = setup();
    await runner.tick();
    await runner.tick();
    await settle();
    await runner.cancel('p', card.id);
    expect(state.calls.some((c) => c[2] === 'worker-stop' && c.includes('d_task_1'))).toBe(true);
    expect(state.calls.filter((c) => c[2] === 'task-update').length).toBe(2);
    expect(store.work('p', card.id)).toBeUndefined();
  });
});
