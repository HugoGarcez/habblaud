import { describe, expect, it } from 'vitest';
import type { BoardCard, BoardProject } from '../../../shared/board';
import { cardKey, groupCards, matchesFilter, projectForPath } from './board-model';

function card(over: Partial<BoardCard>): BoardCard {
  return { id: 'github:1', source: 'github', ref: '#1', title: 'T', body: '', url: 'u', kind: 'issue', column: 'backlog', labels: [], state: 'open', updatedAt: 0, ...over };
}

const projects: BoardProject[] = [
  { id: 'a', name: 'A', path: '/p/a', source: null },
  { id: 'b', name: 'B', path: '/p/b', source: 'github', github: 'o/b' },
  { id: 'c', name: 'C', path: '/p/b/sub', source: 'linear', linearTeam: 'PRO' },
];

describe('quadro (modelo)', () => {
  it('agrupa nas seis colunas, mais recente primeiro', () => {
    const g = groupCards([card({ id: '1', updatedAt: 1 }), card({ id: '2', updatedAt: 5 }), card({ id: '3', column: 'done' })]);
    expect(g.map((x) => x.column)).toEqual(['backlog', 'planning', 'approval', 'running', 'review', 'done']);
    expect(g[0].cards.map((c) => c.id)).toEqual(['2', '1']);
    expect(g[5].cards).toHaveLength(1);
  });

  it('filtro por título, ref e labels, sem acento nem caixa', () => {
    const c = card({ title: 'Correção do Login', ref: 'PRO-7', labels: ['Urgente'] });
    expect(matchesFilter(c, 'correcao')).toBe(true);
    expect(matchesFilter(c, 'pro-7')).toBe(true);
    expect(matchesFilter(c, 'urg')).toBe(true);
    expect(matchesFilter(c, 'outra')).toBe(false);
    expect(matchesFilter(c, '  ')).toBe(true);
  });

  it('chave do card inclui o projeto; filtro acha pelo nome do projeto', () => {
    expect(cardKey(card({ id: 'github:1', projectId: 'a' }))).not.toBe(cardKey(card({ id: 'github:1', projectId: 'b' })));
    expect(matchesFilter(card({ projectName: 'Loja' }), 'loja')).toBe(true);
  });

  it('projeto de uma pasta: exato ou o mais fundo que a contém', () => {
    expect(projectForPath(projects, '/p/b')?.id).toBe('b');
    expect(projectForPath(projects, '/p/b/sub/x')?.id).toBe('c');
    expect(projectForPath(projects, '/p/bb')).toBeUndefined();
    expect(projectForPath(projects, undefined)).toBeUndefined();
  });
});
