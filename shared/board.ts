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

/** IAs que o Orca sabe pôr para trabalhar (`orca orchestration worker-start --agent`). */
export type AgentId = 'claude' | 'codex' | 'antigravity' | 'opencode';
export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'antigravity', 'opencode'];

/** Tipo de uma ação do plano. */
export type ActionType = 'analysis' | 'implementation' | 'tests' | 'review' | 'docs';
export const ACTION_TYPES: readonly ActionType[] = ['analysis', 'implementation', 'tests', 'review', 'docs'];

export interface PlanAction {
  /** Id curto e único no plano ("a1", "a2"...). */
  id: string;
  title: string;
  /** Instruções completas para o agente (ele não vê o resto do plano). */
  instructions: string;
  type: ActionType;
  agent: AgentId;
  /** Muda arquivos (ações que escrevem rodam uma de cada vez, na ordem). */
  writes: boolean;
  /** Ids das ações que precisam terminar antes. */
  deps: string[];
  /** Por que esta IA. */
  reason: string;
}

export interface CardPlan {
  summary: string;
  actions: PlanAction[];
  createdAt: number;
  /** Modelo do planejador. */
  model: string;
  /** Ajustes que o roteador fez (IA trocada por falta de cota, dependência acrescentada...). */
  notes: string[];
}

/**
 * Onde o Promp IA está com o card (estado local, em board.json): planejando, plano esperando aprovação, aprovado e
 * na fila de execução, ou planejamento que falhou (volta ao Backlog com o erro). Ausente = a coluna da fonte.
 */
export type CardStage = 'planning' | 'approval' | 'queued' | 'failed';
export const CARD_STAGES: readonly CardStage[] = ['planning', 'approval', 'queued', 'failed'];

export interface CardWork {
  stage: CardStage;
  plan?: CardPlan;
  /** Último erro (planejamento que falhou...). */
  error?: string;
  updatedAt: number;
}

/** Situação de cada IA para o planejador e para a página. */
export interface AgentQuota {
  agent: AgentId;
  name: string;
  /** A CLI está neste computador. */
  installed: boolean;
  /** Pode receber trabalho agora (instalada e com cota). */
  available: boolean;
  /** Maior uso entre as contas da IA, em %: o da conta com mais folga. */
  fiveHour?: number;
  sevenDay?: number;
  /** Números antigos. */
  stale?: boolean;
  /** Por que não está disponível. */
  reason?: string;
  /** No que ela é boa (vai para o planejador). */
  strengths: string;
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
  /** O que o Promp IA está fazendo com o card (planejamento, aprovação...). */
  work?: CardWork;
}

export interface BoardView {
  project: BoardProject;
  cards: BoardCard[];
  fetchedAt: number;
  /** As IAs e as cotas (para escolher a IA de cada ação). */
  agents: AgentQuota[];
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

/** POST /api/board/projects/:id/cards: card novo (vira issue na fonte do projeto). */
export interface NewCard {
  kind: CardKind;
  title: string;
  body: string;
}

export const CARD_TITLE_MAX = 200;
export const CARD_BODY_MAX = 20_000;

/** Coluna do card: a do estado local do Promp IA, quando há, senão a da fonte. */
export function stageColumn(stage: CardStage, source: BoardColumn): BoardColumn {
  switch (stage) {
    case 'planning':
      return 'planning';
    case 'approval':
      return 'approval';
    case 'queued':
      return 'running';
    case 'failed':
      return source;
  }
}

/** PUT /api/board/projects/:id/cards/:card/plan: plano editado na página. */
export interface PlanEdit {
  summary?: string;
  actions: PlanAction[];
}

/** POST /api/board/projects/:id/config */
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
