// Quadro de tarefas (kanban) dos projetos do Orca: contrato entre o servidor (server/board/) e a página
// (client/src/ui/board.ts). Cada projeto do Orca tem um quadro; os cards vêm das issues do GitHub ou do Linear,
// conforme a fonte escolhida para o projeto.
//
// Colunas: Backlog → Planejando → Aguardando aprovação → Em execução → Revisão → Concluído. Nesta fase a coluna sai
// só do estado da issue na fonte (aberta/fechada, estado do Linear, labels `promp:*` no GitHub); o planejador e a
// execução (fases seguintes) passam a mover os cards.

export type BoardSource = 'github' | 'linear';

export type BoardColumn = 'backlog' | 'planning' | 'approval' | 'running' | 'review' | 'done';

export const BOARD_COLUMNS: readonly BoardColumn[] = ['backlog', 'planning', 'approval', 'running', 'review', 'done'];

/** Tipo do card: issue comum, funcionalidade ou correção. */
export type CardKind = 'issue' | 'feature' | 'fix';

export interface BoardProject {
  /** Id do projeto no Orca ("github:dono/repo" ou "repo:<uuid>"). */
  id: string;
  name: string;
  /** Pasta do repositório principal (a sala do escritório com o mesmo caminho é a do projeto). */
  path?: string;
  /** Repositório do GitHub do `origin` ("dono/repo"), quando há. */
  github?: string;
  /** Fonte dos cards; null = ainda não escolhida (sem GitHub e sem time do Linear). */
  source: BoardSource | null;
  /** Time do Linear (key, ex.: "PRO") quando a fonte é o Linear. */
  linearTeam?: string;
}

export interface BoardCard {
  /** "<fonte>:<ref>" (ex.: "github:12", "linear:PRO-3"). */
  id: string;
  source: BoardSource;
  /** Como a fonte mostra: "#12" ou "PRO-3". */
  ref: string;
  title: string;
  /** Começo da descrição (texto da fonte, cortado). */
  body: string;
  url: string;
  kind: CardKind;
  column: BoardColumn;
  labels: string[];
  /** Estado na fonte ("open", "closed", "In Progress"...). */
  state: string;
  updatedAt: number;
}

export interface BoardView {
  project: BoardProject;
  cards: BoardCard[];
  fetchedAt: number;
  /** A fonte não respondeu (ou não está configurada): o motivo, para a página mostrar. */
  error?: string;
}

export interface LinearTeam {
  key: string;
  name: string;
}

/** GET /api/board */
export interface BoardIndex {
  projects: BoardProject[];
  linearTeams: LinearTeam[];
  /** O Linear está conectado no Orca. */
  linear: boolean;
}

/** PUT /api/board/:projeto/config */
export interface BoardProjectConfig {
  source: BoardSource | null;
  linearTeam?: string;
}

/** Labels do GitHub que fixam a coluna de uma issue aberta (o Promp IA as põe nas fases seguintes). */
export const GITHUB_COLUMN_LABELS: Readonly<Record<string, BoardColumn>> = {
  'promp:planejando': 'planning',
  'promp:aprovacao': 'approval',
  'promp:execucao': 'running',
  'promp:revisao': 'review',
};

/** Tipo pelo nome das labels (GitHub: bug/enhancement; Linear: Bug/Feature/Improvement). */
export function kindFromLabels(labels: readonly string[]): CardKind {
  const l = labels.map((x) => x.toLowerCase());
  if (l.some((x) => x === 'bug' || x === 'fix' || x === 'correção' || x === 'correcao')) return 'fix';
  if (l.some((x) => x === 'enhancement' || x === 'feature' || x === 'improvement' || x === 'funcionalidade')) return 'feature';
  return 'issue';
}
