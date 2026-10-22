// Visão de todos os projetos (cards de cada projeto e dos times do Linear sem projeto, sem repetir), resumo para o
// snapshot (contagens por sala e avisos) e a sala dos worktrees do quadro. CLIs falsas; dados sintéticos.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import type { Exec } from './cli';
import { BoardService } from './service';
import { BoardStore } from './store';

setQuiet(true);

const NOW = Date.parse('2026-10-14T12:00:00Z');
const iso = new Date(NOW).toISOString();
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const ok = (result: unknown) => JSON.stringify({ ok: true, result });

function setup() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const store = new BoardStore(join(tmp.dir, 'board.json'));
  const exec: Exec = async (_bin, args) => {
    const cmd = args.join(' ');
    if (cmd === 'project list --json')
      return ok({
        projects: [
          { id: 'gh', displayName: 'Loja', sourceRepoIds: ['r1'] },
          { id: 'lin', displayName: 'Motion', sourceRepoIds: ['r2'] },
          { id: 'lin2', displayName: 'Motion 2', sourceRepoIds: ['r3'] },
        ],
      });
    if (cmd === 'repo list --json') return ok({ repos: [{ id: 'r1', path: '/p/loja' }, { id: 'r2', path: '/p/motion' }, { id: 'r3', path: '/p/motion2' }] });
    if (cmd === 'linear team list --json') return ok({ teams: [{ key: 'PRO', name: 'Promp' }, { key: 'OPS', name: 'Ops' }] });
    if (args[0] === '-C') return args[1] === '/p/loja' ? 'https://github.com/o/loja.git' : Promise.reject(new Error('sem origin'));
    if (args[0] === 'issue') return JSON.stringify([{ number: 1, title: 'Bug', url: 'u', state: 'OPEN', updatedAt: iso }]);
    if (args[0] === 'linear' && args.includes('PRO')) return ok({ issues: [{ identifier: 'PRO-1', title: 'p', url: 'u', state: { type: 'started', name: 'In Progress' }, updatedAt: iso }] });
    if (args[0] === 'linear' && args.includes('OPS')) return ok({ issues: [{ identifier: 'OPS-1', title: 'o', url: 'u', state: { type: 'backlog' }, updatedAt: iso }] });
    throw new Error(`inesperado: ${cmd}`);
  };
  store.setConfig('lin', { source: 'linear', linearTeam: 'PRO' });
  store.setConfig('lin2', { source: 'linear', linearTeam: 'PRO' });
  const board = new BoardService({ store, orca: 'orca', gh: 'gh', git: 'git', exec, now: () => NOW });
  return { board, store };
}

describe('quadro de todos os projetos', () => {
  it('junta os projetos, não repete card do mesmo time do Linear e inclui time sem projeto', async () => {
    const { board } = setup();
    const all = await board.allView();
    expect(all.cards.map((c) => [c.id, c.projectName ?? null])).toEqual(
      expect.arrayContaining([
        ['github:1', 'Loja'],
        ['linear:PRO-1', 'Motion'],
        ['linear:OPS-1', null],
      ]),
    );
    expect(all.cards).toHaveLength(3);
    expect(all.errors).toEqual([]);
    expect(all.projects.map((p) => p.id)).toEqual(['gh', 'lin', 'lin2']);
  });

  it('resumo: contagem por sala e avisos dos cards que precisam de você', async () => {
    const { board, store } = setup();
    store.setWork('gh', 'github:1', { stage: 'approval', ref: '#1', title: 'Bug', updatedAt: NOW });
    await board.allView();
    const s = board.summary();
    expect(s.rooms['/p/loja']).toEqual({ approval: 1 });
    expect(s.rooms['/p/motion']).toEqual({ running: 1 });
    expect(s.attention).toEqual([{ projectId: 'gh', cardId: 'github:1', ref: '#1', title: 'Bug', reason: 'approval', at: NOW }]);
    store.setWork('gh', 'github:1', {
      stage: 'running',
      updatedAt: NOW,
      run: { actions: {}, questions: [{ id: 'm1', text: '?', at: NOW + 5 }], answered: [], startedAt: NOW, log: [], worktree: { id: 'x', path: '/wt/a', branch: 'b', repoPath: '/p/loja' } },
    });
    expect(board.summary().attention[0]).toMatchObject({ reason: 'question', at: NOW + 5, ref: 'github:1' });
  });

  it('a pasta do worktree de um card cai na sala do repositório', () => {
    const { board, store } = setup();
    store.setWork('gh', 'github:1', {
      stage: 'running',
      updatedAt: NOW,
      run: { actions: {}, questions: [], answered: [], startedAt: NOW, log: [], worktree: { id: 'x', path: '/wt/a', branch: 'b', repoPath: '/p/loja' } },
    });
    expect(board.roomPathFor('/wt/a')).toBe('/p/loja');
    expect(board.roomPathFor('/wt/a/src')).toBe('/p/loja');
    expect(board.roomPathFor('/wt/ab')).toBeUndefined();
  });
});
