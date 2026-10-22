// Editar card (issue na fonte: título, descrição e troca da label de tipo) e revisão do plano pelo planejador (plano
// anterior + pedido no prompt; falha mantém o plano anterior; cancelar volta a ele). CLIs falsas; dados sintéticos.
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardPlan } from '../../shared/board';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import type { Exec } from './cli';
import { plannerPrompt } from './planner';
import { updateIssue } from './providers';
import { BoardService } from './service';
import { BoardStore } from './store';

setQuiet(true);

const NOW = Date.parse('2026-10-14T12:00:00Z');
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
const ok = (result: unknown) => JSON.stringify({ ok: true, result });

describe('editar a issue', () => {
  it('GitHub: título, corpo e troca bug → enhancement (as outras labels ficam)', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_b, args) => (calls.push(args), '');
    await updateIssue(exec, { gh: 'gh', orca: 'orca' }, { source: 'github', repo: 'o/r', ref: '#4' }, { kind: 'feature', title: 'Novo', body: 'B' }, { title: 'Velho', body: 'b', labels: ['bug', 'ui'] });
    expect(calls[0]).toEqual(['issue', 'edit', '4', '--repo', 'o/r', '--title', 'Novo', '--body', 'B', '--add-label', 'enhancement', '--remove-label', 'bug']);
  });

  it('Linear: save-issue com o conjunto de labels completo (tipo trocado)', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_b, args) => (calls.push(args), ok({}));
    await updateIssue(exec, { orca: 'orca' }, { source: 'linear', ref: 'PRO-3' }, { kind: 'fix', title: 'T', body: 'D' }, { title: 'x', body: 'y', labels: ['Feature', 'Infra'] });
    const a = calls[0];
    expect(a.slice(0, 7)).toEqual(['linear', 'save-issue', 'PRO-3', '--title', 'T', '--description', 'D']);
    expect(a.filter((_, i) => a[i - 1] === '--label')).toEqual(['Infra', 'Bug']);
  });
});

const plan: CardPlan = {
  summary: 'S',
  model: 'sonnet',
  createdAt: NOW,
  notes: [],
  actions: [{ id: 'a1', title: 'Fazer', instructions: 'i', type: 'implementation', agent: 'codex', writes: true, deps: [], reason: 'r' }],
};

describe('revisão do plano', () => {
  it('prompt leva o plano atual e o pedido', () => {
    const p = plannerPrompt({ id: 'p', name: 'P', source: 'github' }, { id: 'github:1', source: 'github', ref: '#1', title: 'T', body: '', url: 'u', kind: 'fix', column: 'backlog', labels: [], state: 'open', updatedAt: 0 }, [], {
      previous: { ...plan, revisions: ['antes'] },
      feedback: 'use o Claude',
    });
    expect(p).toContain('REVISÃO');
    expect(p).toContain('"title":"Fazer"');
    expect(p).toContain('- antes');
    expect(p).toContain('Pedido da pessoa agora: use o Claude');
  });

  function setup(planner: (args: string[]) => Promise<string>) {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const store = new BoardStore(join(tmp.dir, 'b.json'));
    const calls: string[][] = [];
    const exec: Exec = async (bin, args) => {
      calls.push([bin, ...args]);
      const cmd = args.join(' ');
      if (cmd === 'project list --json') return ok({ projects: [{ id: 'p', displayName: 'p', sourceRepoIds: ['r'] }] });
      if (cmd === 'repo list --json') return ok({ repos: [{ id: 'r', path: '/p' }] });
      if (cmd === 'linear team list --json') return JSON.stringify({ ok: false, error: { message: 'x' } });
      if (args[0] === '-C') return 'https://github.com/o/r.git';
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 1, title: 'Bug', url: 'u', state: 'OPEN', updatedAt: new Date(NOW).toISOString() }]);
      if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ title: 'Bug', body: 'corpo inteiro', labels: [{ name: 'bug' }] });
      if (args[0] === 'issue' && args[1] === 'edit') return '';
      if (bin === 'claude') return planner(args);
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
      installed: new Set(['claude', 'codex']),
      accounts: () => [],
    });
    store.setWork('p', 'github:1', { stage: 'approval', plan, ref: '#1', title: 'Bug', updatedAt: NOW });
    return { board, store, calls };
  }
  const settle = () => new Promise((r) => setTimeout(r, 15));

  it('revisa: plano novo com o pedido no histórico; o planejador lê a issue inteira', async () => {
    let prompt = '';
    const { board, store } = setup(async (args) => {
      prompt = args[args.indexOf('-p') + 1];
      return JSON.stringify({ structured_output: { summary: 'S2', actions: [{ ...plan.actions[0], agent: 'claude' }] } });
    });
    const r = await board.plan('p', 'github:1', 'use o Claude');
    expect('ok' in r && r.ok.work).toMatchObject({ stage: 'planning', revising: 'use o Claude', plan: { summary: 'S' } });
    await settle();
    expect(store.work('p', 'github:1')).toMatchObject({ stage: 'approval', plan: { summary: 'S2', revisions: ['use o Claude'], actions: [{ agent: 'claude' }] } });
    expect(prompt).toContain('corpo inteiro');
    expect(prompt).toContain('Pedido da pessoa agora: use o Claude');
  });

  it('revisão que falha mantém o plano anterior com o aviso; cancelar a revisão volta ao plano', async () => {
    const { board, store } = setup(async () => JSON.stringify({ is_error: true, result: 'sem cota' }));
    await board.plan('p', 'github:1', 'mude');
    await settle();
    expect(store.work('p', 'github:1')).toMatchObject({ stage: 'approval', plan: { summary: 'S' }, error: expect.stringMatching(/revisão falhou.*sem cota/) });

    let release!: (v: string) => void;
    const b = setup(() => new Promise((res) => (release = res)));
    await b.board.plan('p', 'github:1', 'mude');
    await b.board.discard('p', 'github:1');
    expect(b.store.work('p', 'github:1')).toMatchObject({ stage: 'approval', plan: { summary: 'S' } });
    // O planejador começa depois de reler as cotas do Orca.
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release(JSON.stringify({ structured_output: { summary: 'tarde', actions: plan.actions } }));
    await settle();
    expect(b.store.work('p', 'github:1')?.plan?.summary).toBe('S');
  });

  it('sem plano esperando aprovação, não revisa; editar card com plano avisa para revisar', async () => {
    const { board, store, calls } = setup(async () => '');
    store.setWork('p', 'github:1', { stage: 'queued', plan, updatedAt: NOW });
    expect(await board.plan('p', 'github:1', 'x')).toMatchObject({ status: 409 });
    expect(await board.edit('p', 'github:1', { kind: 'fix', title: 'T', body: 'B' })).toMatchObject({ status: 409 });
    store.setWork('p', 'github:1', { stage: 'approval', plan, updatedAt: NOW });
    const r = await board.edit('p', 'github:1', { kind: 'fix', title: 'Título novo', body: 'B' });
    expect('ok' in r && r.ok).toMatchObject({ title: 'Título novo', projectId: 'p' });
    expect(store.work('p', 'github:1')?.error).toMatch(/editado depois do plano/);
    expect(calls.some((c) => c[1] === 'issue' && c[2] === 'edit')).toBe(true);
    expect(await board.details('p', 'github:1')).toEqual({ ok: { kind: 'fix', title: 'Bug', body: 'corpo inteiro' } });
  });
});
