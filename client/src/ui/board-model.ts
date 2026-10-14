// Lógica pura do quadro de tarefas (ui/board.ts): nomes das colunas e tipos, agrupamento dos cards e a escolha do
// projeto aberto.
import { BOARD_COLUMNS, type BoardCard, type BoardColumn, type BoardProject, type CardKind } from '../../../shared/board';
import { tr } from '../../../shared/i18n';

export function columnLabel(c: BoardColumn): string {
  switch (c) {
    case 'backlog':
      return tr('Backlog');
    case 'planning':
      return tr('Planejando');
    case 'approval':
      return tr('Aguardando aprovação');
    case 'running':
      return tr('Em execução');
    case 'review':
      return tr('Revisão');
    case 'done':
      return tr('Concluído');
  }
}

export function kindLabel(k: CardKind): string {
  switch (k) {
    case 'fix':
      return tr('Correção');
    case 'feature':
      return tr('Funcionalidade');
    case 'issue':
      return tr('Issue');
  }
}

/** Cards por coluna, na ordem das colunas; dentro de cada uma, o mais recente primeiro. */
export function groupCards(cards: readonly BoardCard[]): { column: BoardColumn; cards: BoardCard[] }[] {
  const by = new Map<BoardColumn, BoardCard[]>(BOARD_COLUMNS.map((c) => [c, []]));
  for (const card of cards) by.get(card.column)?.push(card);
  return BOARD_COLUMNS.map((column) => ({ column, cards: (by.get(column) ?? []).sort((a, b) => b.updatedAt - a.updatedAt) }));
}

/** Filtro do campo de busca: título, ref e labels, sem diferença de maiúsculas e acentos. */
export function matchesFilter(card: BoardCard, filter: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = norm(filter.trim());
  if (!q) return true;
  return [card.title, card.ref, ...card.labels].some((s) => norm(s).includes(q));
}

/**
 * Projeto a abrir: o pedido (ex.: o da sala clicada), senão o último aberto, senão o primeiro com fonte configurada,
 * senão o primeiro.
 */
export function pickProject(projects: readonly BoardProject[], wanted?: string | null, last?: string | null): BoardProject | undefined {
  return (
    projects.find((p) => p.id === wanted) ?? projects.find((p) => p.id === last) ?? projects.find((p) => p.source !== null) ?? projects[0]
  );
}

/** Projeto de uma pasta (a da sala): o de mesmo caminho ou o que contém a pasta (worktree dentro do repositório). */
export function projectForPath(projects: readonly BoardProject[], path: string | undefined): BoardProject | undefined {
  if (!path) return undefined;
  const exact = projects.find((p) => p.path === path);
  if (exact) return exact;
  return projects
    .filter((p) => p.path && path.startsWith(`${p.path}/`))
    .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0];
}
