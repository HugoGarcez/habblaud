// Quadro de tarefas: cards do GitHub e do Linear (colunas, tipos, Concluído só recente), projetos do Orca (GitHub do
// origin, fonte padrão, configuração gravada) e os erros que viram aviso na página. CLIs falsas (Exec); dados
// sintéticos.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { kindFromLabels } from '../../shared/board';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { CliError, orcaResult, type Exec } from './cli';
import { parseConfig, parseNewCard } from './http';
import { createGithub, createLinear, DONE_KEEP_MS, githubCard, linearCard, linearColumn, listGithub, listLinear, parseIssueUrl } from './providers';
import { BoardService, githubRepoOf, parseGithubUrl } from './service';
import { BoardStore } from './store';

setQuiet(true);

const NOW = Date.parse('2026-10-14T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function ok(result: unknown): string {
  return JSON.stringify({ id: 'x', ok: true, result });
}

describe('cards do GitHub', () => {
  it('aberta = Backlog (ou a coluna da label promp:*), fechada = Concluído; tipo pelas labels', () => {
    const base = { number: 7, title: 'T', body: 'corpo', url: 'u', updatedAt: iso(0) };
    expect(githubCard({ ...base, state: 'OPEN', labels: [{ name: 'bug' }] })).toMatchObject({ id: 'github:7', ref: '#7', column: 'backlog', kind: 'fix', state: 'open' });
    expect(githubCard({ ...base, state: 'OPEN', labels: [{ name: 'enhancement' }, { name: 'promp:execucao' }] })).toMatchObject({ column: 'running', kind: 'feature', labels: ['enhancement'] });
    expect(githubCard({ ...base, state: 'CLOSED', labels: [{ name: 'promp:revisao' }] })).toMatchObject({ column: 'done', state: 'closed' });
  });

  it('lista abertas e fechadas recentes; resposta ilegível vira CliError', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push(args);
      return JSON.stringify([
        { number: 1, title: 'a', url: 'u1', state: 'OPEN', updatedAt: iso(0) },
        { number: 2, title: 'b', url: 'u2', state: 'CLOSED', closedAt: iso(DONE_KEEP_MS / 2) },
        { number: 3, title: 'c', url: 'u3', state: 'CLOSED', closedAt: iso(DONE_KEEP_MS * 2) },
      ]);
    };
    const cards = await listGithub(exec, 'gh', 'dono/repo', NOW);
    expect(cards.map((c) => c.ref)).toEqual(['#1', '#2']);
    expect(calls[0].slice(0, 4)).toEqual(['issue', 'list', '--repo', 'dono/repo']);
    await expect(listGithub(async () => 'nada', 'gh', 'x/y', NOW)).rejects.toBeInstanceOf(CliError);
  });
});

describe('cards do Linear', () => {
  it('coluna pelo tipo do estado; revisão pelo nome; cancelado e duplicado ficam de fora', () => {
    expect(linearColumn({ type: 'backlog' })).toBe('backlog');
    expect(linearColumn({ type: 'unstarted', name: 'Todo' })).toBe('backlog');
    expect(linearColumn({ type: 'started', name: 'In Progress' })).toBe('running');
    expect(linearColumn({ type: 'started', name: 'In Review' })).toBe('review');
    expect(linearColumn({ type: 'completed' })).toBe('done');
    expect(linearColumn({ type: 'canceled' })).toBeUndefined();
    expect(linearCard({ identifier: 'PRO-1', title: 't', url: 'u', state: { type: 'duplicate' } })).toBeUndefined();
    expect(linearCard({ identifier: 'PRO-2', title: 't', url: 'u', state: { type: 'started', name: 'In Progress' }, labels: [{ name: 'Bug' }] })).toMatchObject({
      id: 'linear:PRO-2',
      ref: 'PRO-2',
      kind: 'fix',
      column: 'running',
      state: 'In Progress',
    });
  });

  it('lista pelo orca linear; concluídas antigas saem; erro do Orca vira CliError com o código', async () => {
    const exec: Exec = async () =>
      ok({
        issues: [
          { identifier: 'PRO-1', title: 'a', url: 'u', state: { type: 'unstarted' }, updatedAt: iso(0) },
          { identifier: 'PRO-2', title: 'b', url: 'u', state: { type: 'completed' }, completedAt: iso(DONE_KEEP_MS * 2) },
        ],
      });
    expect((await listLinear(exec, 'orca', 'PRO', NOW)).map((c) => c.ref)).toEqual(['PRO-1']);
    const err = await listLinear(async () => JSON.stringify({ ok: false, error: { code: 'not_connected', message: 'sem Linear' } }), 'orca', 'PRO').catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: 'not_connected', message: 'sem Linear' });
    expect(() => orcaResult('{')).toThrow(CliError);
  });
});

describe('tipos e GitHub do origin', () => {
  it('kindFromLabels', () => {
    expect(kindFromLabels(['Bug'])).toBe('fix');
    expect(kindFromLabels(['Feature'])).toBe('feature');
    expect(kindFromLabels(['docs'])).toBe('issue');
  });

  it('origin do git vale mais que o remote que o Orca escolheu', () => {
    expect(parseGithubUrl('https://github.com/HugoGarcez/habblaud.git')).toBe('HugoGarcez/habblaud');
    expect(parseGithubUrl('git@github.com:dono/repo.git')).toBe('dono/repo');
    expect(parseGithubUrl('https://gitlab.com/dono/repo')).toBeUndefined();
    const p = { id: 'p', displayName: 'p', gitRemoteIdentity: { canonicalKey: 'github.com/up/repo' } };
    expect(githubRepoOf(p, 'https://github.com/fork/repo')).toBe('fork/repo');
    expect(githubRepoOf(p)).toBe('up/repo');
    expect(githubRepoOf({ id: 'q', displayName: 'q', providerIdentity: { provider: 'github', owner: 'o', repo: 'r' } })).toBe('o/r');
  });
});

describe('BoardService', () => {
  function service(opts: { teams?: unknown; ghFails?: string } = {}) {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const file = join(tmp.dir, 'board.json');
    const store = new BoardStore(file);
    const calls: string[][] = [];
    const exec: Exec = async (bin, args) => {
      calls.push([bin, ...args]);
      const cmd = args.join(' ');
      if (cmd === 'project list --json')
        return ok({
          projects: [
            { id: 'github:up/app', displayName: 'app', sourceRepoIds: ['r1'], gitRemoteIdentity: { canonicalKey: 'github.com/up/app' } },
            { id: 'repo:r2', displayName: 'local', sourceRepoIds: ['r2'] },
          ],
        });
      if (cmd === 'repo list --json') return ok({ repos: [{ id: 'r1', path: '/p/app' }, { id: 'r2', path: '/p/local' }] });
      if (cmd === 'linear team list --json') return opts.teams === undefined ? ok({ teams: [{ key: 'PRO', name: 'Promp' }] }) : (opts.teams as string);
      if (args[0] === '-C') return args[1] === '/p/app' ? 'https://github.com/fork/app.git\n' : Promise.reject(new CliError('sem origin'));
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/fork/app/issues/5\n';
      if (args[0] === 'issue') return opts.ghFails ? Promise.reject(new CliError(opts.ghFails)) : JSON.stringify([{ number: 1, title: 'a', url: 'u', state: 'OPEN', updatedAt: iso(0) }]);
      if (args[0] === 'linear') return ok({ issues: [{ identifier: 'PRO-9', title: 'z', url: 'u', state: { type: 'started', name: 'In Progress' }, updatedAt: iso(0) }] });
      throw new Error(`inesperado: ${cmd}`);
    };
    const board = new BoardService({ store, orca: 'orca', gh: 'gh', git: 'git', exec, now: () => NOW });
    return { board, store, file, calls };
  }

  it('projetos: GitHub do origin, fonte padrão (GitHub; sem GitHub e com um time só, o Linear)', async () => {
    const { board } = service();
    const i = await board.index();
    expect(i.linear).toBe(true);
    expect(i.projects).toEqual([
      { id: 'github:up/app', name: 'app', path: '/p/app', github: 'fork/app', source: 'github' },
      { id: 'repo:r2', name: 'local', path: '/p/local', source: 'linear', linearTeam: 'PRO' },
    ]);
  });

  it('sem Linear conectado: linear false e projeto sem GitHub fica sem fonte', async () => {
    const { board } = service({ teams: JSON.stringify({ ok: false, error: { message: 'x' } }) });
    const i = await board.index();
    expect(i.linear).toBe(false);
    expect(i.projects[1].source).toBeNull();
    expect((await board.view('repo:r2'))?.error).toMatch(/GitHub ou Linear/);
  });

  it('view com cache; refresh busca de novo; configuração gravada troca a fonte', async () => {
    const { board, calls, file } = service();
    expect((await board.view('github:up/app'))?.cards.map((c) => c.ref)).toEqual(['#1']);
    await board.view('github:up/app');
    expect(calls.filter((c) => c[1] === 'issue')).toHaveLength(1);
    await board.view('github:up/app', true);
    expect(calls.filter((c) => c[1] === 'issue')).toHaveLength(2);
    expect(await board.setConfig('github:up/app', { source: 'linear', linearTeam: 'PRO' })).toMatchObject({ source: 'linear', linearTeam: 'PRO' });
    expect((await board.view('github:up/app'))?.cards.map((c) => c.ref)).toEqual(['PRO-9']);
    expect(JSON.parse(readFileSync(file, 'utf8')).projects['github:up/app']).toEqual({ source: 'linear', linearTeam: 'PRO' });
    expect(await board.view('nao-existe')).toBeUndefined();
    expect(await board.setConfig('nao-existe', { source: null })).toBeUndefined();
  });

  it('issues desligadas no GitHub viram aviso legível (sem cards)', async () => {
    const { board } = service({ ghFails: "the 'fork/app' repository has disabled issues" });
    const v = await board.view('github:up/app');
    expect(v?.cards).toEqual([]);
    expect(v?.error).toMatch(/issues estão desligadas/);
  });

  it('create: issue na fonte com rodapé e o card entra no cache; projeto desconhecido = undefined', async () => {
    const { board, calls } = service();
    await board.view('github:up/app');
    const r = await board.create('github:up/app', { kind: 'issue', title: 'Nova', body: 'texto' });
    expect(r && 'card' in r ? r.card.ref : r).toBe('#5');
    const create = calls.find((c) => c[2] === 'create')!;
    expect(create[create.indexOf('--repo') + 1]).toBe('fork/app');
    expect(create[create.indexOf('--body') + 1]).toBe('texto\n\n---\n_Criado pelo Promp IA._');
    expect((await board.view('github:up/app'))?.cards.map((c) => c.ref)).toEqual(['#5', '#1']);
    expect(await board.create('nao-existe', { kind: 'issue', title: 'x', body: '' })).toBeUndefined();
  });

  it('create sem fonte configurada: erro legível', async () => {
    const { board } = service({ teams: JSON.stringify({ ok: false, error: { message: 'x' } }) });
    expect(await board.create('repo:r2', { kind: 'issue', title: 'x', body: '' })).toEqual({ error: expect.stringMatching(/GitHub ou Linear/) });
  });

  it('store relê o arquivo e ignora entradas inválidas', () => {
    const { store, file } = service();
    store.setConfig('a', { source: 'github' });
    const again = new BoardStore(file);
    again.load();
    expect(again.config('a')).toEqual({ source: 'github' });
    expect(again.config('b')).toBeUndefined();
  });
});

describe('parseConfig', () => {
  it('aceita github, linear com time e null; recusa o resto', () => {
    expect(parseConfig({ source: 'github' })).toEqual({ source: 'github' });
    expect(parseConfig({ source: null })).toEqual({ source: null });
    expect(parseConfig({ source: 'linear', linearTeam: 'PRO' })).toEqual({ source: 'linear', linearTeam: 'PRO' });
    expect(() => parseConfig({ source: 'linear' })).toThrow();
    expect(() => parseConfig({ source: 'jira' })).toThrow();
    expect(() => parseConfig({ source: 'linear', linearTeam: 'a b' })).toThrow();
  });
});

describe('criar cards', () => {
  const card = { kind: 'fix' as const, title: 'Login quebra', body: 'passos' };

  it('GitHub: gh issue create com a label do tipo; label inexistente cria sem ela', async () => {
    const calls: string[][] = [];
    let missing = true;
    const exec: Exec = async (_bin, args) => {
      calls.push(args);
      if (args.includes('--label') && missing) {
        missing = false;
        throw new CliError("could not add label: 'bug' not found");
      }
      return 'Creating issue\nhttps://github.com/o/r/issues/42\n';
    };
    const c = await createGithub(exec, 'gh', 'o/r', card, NOW);
    expect(c).toMatchObject({ id: 'github:42', ref: '#42', url: 'https://github.com/o/r/issues/42', kind: 'fix', column: 'backlog', state: 'open' });
    expect(calls[0]).toEqual(['issue', 'create', '--repo', 'o/r', '--title', 'Login quebra', '--body', 'passos', '--label', 'bug']);
    expect(calls[1]).not.toContain('--label');
    expect(() => parseIssueUrl('nada')).toThrow(CliError);
  });

  it('GitHub: outro erro não tenta de novo', async () => {
    let n = 0;
    const exec: Exec = async () => {
      n++;
      throw new CliError('HTTP 403');
    };
    await expect(createGithub(exec, 'gh', 'o/r', card)).rejects.toThrow('HTTP 403');
    expect(n).toBe(1);
  });

  it('Linear: orca linear create com time, label e write-id; lê result.issue ou result', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_bin, args) => {
      calls.push(args);
      return ok({ issue: { identifier: 'PRO-12', title: 'Login quebra', url: 'https://linear.app/x/PRO-12', state: { type: 'backlog', name: 'Backlog' } } });
    };
    expect(await createLinear(exec, 'orca', 'PRO', { ...card, kind: 'feature' }, NOW)).toMatchObject({ id: 'linear:PRO-12', column: 'backlog', kind: 'feature', labels: ['Feature'] });
    expect(calls[0]).toContain('--write-id');
    expect(calls[0].slice(calls[0].indexOf('--label'), calls[0].indexOf('--label') + 2)).toEqual(['--label', 'Feature']);
    const flat: Exec = async () => ok({ identifier: 'PRO-13', url: 'u', title: 't' });
    expect((await createLinear(flat, 'orca', 'PRO', { ...card, kind: 'issue' })).ref).toBe('PRO-13');
    await expect(createLinear(async () => ok({}), 'orca', 'PRO', card)).rejects.toBeInstanceOf(CliError);
  });

  it('parseNewCard: tipo, título (espaços juntados) e limites', () => {
    expect(parseNewCard({ kind: 'feature', title: '  a\n b ', body: ' x ' })).toEqual({ kind: 'feature', title: 'a b', body: 'x' });
    expect(parseNewCard({ kind: 'issue', title: 't' })).toEqual({ kind: 'issue', title: 't', body: '' });
    expect(() => parseNewCard({ kind: 'bug', title: 't' })).toThrow();
    expect(() => parseNewCard({ kind: 'fix', title: ' ' })).toThrow();
    expect(() => parseNewCard({ kind: 'fix', title: 'x'.repeat(201) })).toThrow();
    expect(() => parseNewCard({ kind: 'fix', title: 't', body: 'x'.repeat(20_001) })).toThrow();
  });
});
