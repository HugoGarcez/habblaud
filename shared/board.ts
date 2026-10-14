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
  /** Pedidos de revisão já atendidos pelo planejador, do mais antigo ao mais novo. */
  revisions?: string[];
}

/**
 * Onde o Promp IA está com o card (estado local, em board.json): planejando, plano esperando aprovação, aprovado e
 * na fila, executando, travado (ação que falhou), em revisão (PR aberto), concluído (PR aceito), ou planejamento que
 * falhou (volta à coluna da fonte com o erro). Ausente = a coluna da fonte.
 */
export type CardStage = 'planning' | 'approval' | 'queued' | 'running' | 'blocked' | 'review' | 'done' | 'failed';
export const CARD_STAGES: readonly CardStage[] = ['planning', 'approval', 'queued', 'running', 'blocked', 'review', 'done', 'failed'];

/** Situação de uma ação do plano na execução. */
export type ActionState = 'waiting' | 'starting' | 'running' | 'done' | 'failed' | 'canceled';

export interface ActionRun {
  state: ActionState;
  /** Task do Orca. */
  taskId?: string;
  /** Dispatch do worker (worker-start). */
  dispatchId?: string;
  /** Id de pedido do worker-start (recupera a resposta perdida com --retry-request). */
  startRequest?: string;
  /** Pedido do task-create. */
  createRequest?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Resumo do worker (worker_done) ou o resultado da task. */
  result?: string;
  error?: string;
  /** Esperando cota de uma IA (texto para a página). */
  waitingFor?: string;
}

/** Pergunta de um worker (orchestration ask), esperando resposta pelo card. */
export interface CardQuestion {
  id: string;
  text: string;
  options?: string[];
  from?: string;
  at: number;
}

export interface CardRun {
  runId?: string;
  runRequest?: string;
  /** Worktree do card (Orca), ligado à issue; `repoPath` = pasta do repositório (a sala do escritório). */
  worktree?: { id: string; path: string; branch: string; repoPath?: string };
  /** Nome pedido ao Orca para o worktree (acha o worktree se a resposta se perder). */
  worktreeName?: string;
  actions: Record<string, ActionRun>;
  questions: CardQuestion[];
  /** Perguntas já respondidas (não voltam). */
  answered: string[];
  pr?: { url: string; number?: number };
  startedAt: number;
  finishedAt?: number;
  /** Últimos acontecimentos, para a página. */
  log: { at: number; text: string }[];
}

export interface CardWork {
  stage: CardStage;
  /** Planejando uma revisão: o plano anterior continua em `plan` e volta se a revisão falhar. */
  revising?: string;
  /** Como a fonte mostra o card ("#12", "PRO-3") e o título: para avisos sem buscar a fonte. */
  ref?: string;
  title?: string;
  plan?: CardPlan;
  /** Último erro (planejamento que falhou, ação que falhou...). */
  error?: string;
  /** Execução (a partir da aprovação). */
  run?: CardRun;
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
  /** Projeto do Orca do card (na visão de todos os projetos); ausente = time do Linear sem projeto ligado. */
  projectId?: string;
  projectName?: string;
}

/** GET /api/board/all: os cards de todos os projetos e de todos os times do Linear. */
export interface BoardAllView {
  projects: BoardProject[];
  cards: BoardCard[];
  agents: AgentQuota[];
  fetchedAt: number;
  /** Projetos (ou times) cuja fonte não respondeu. */
  errors: { name: string; error: string }[];
}

/** Por que um card precisa de você (avisos e a sala). */
export type AttentionReason = 'question' | 'approval' | 'blocked' | 'review';

export interface BoardAttention {
  projectId: string;
  cardId: string;
  ref: string;
  title: string;
  reason: AttentionReason;
  /** Quando ficou assim (muda = aviso novo). */
  at: number;
}

/** Resumo do quadro no snapshot: post-its no quadro de cada sala e avisos. */
export interface BoardSummary {
  /** Pasta do repositório (= caminho da sala) → quantos cards em cada coluna. */
  rooms: Record<string, Partial<Record<BoardColumn, number>>>;
  attention: BoardAttention[];
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

/** PUT /api/board/projects/:id/cards/:card: card editado (vai para a issue na fonte). */
export type CardEdit = NewCard;

/** GET /api/board/projects/:id/cards/:card/details: texto completo da issue (para editar). */
export interface CardDetails {
  kind: CardKind;
  title: string;
  body: string;
}

export const REVISION_MAX = 4_000;

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
    case 'running':
    case 'blocked':
      return 'running';
    case 'review':
      return 'review';
    case 'done':
      return 'done';
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
