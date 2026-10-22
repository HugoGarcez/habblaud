// Quadro de tarefas dos projetos do Orca (ver shared/board.ts). Projetos: `orca project list` + `orca repo list`
// (caminho e GitHub do origin). Cards: GitHub ou Linear, conforme a configuração do projeto (store.ts); sem
// configuração, o GitHub quando o origin é do GitHub, senão o Linear quando há um time só.
//
// Tudo com cache curto: a página pede de novo ao abrir o quadro e a cada ~30 s enquanto ele está aberto. Os cards da
// fonte ficam no cache; o estado local do Promp IA (CardWork: planejando, plano, aprovado) e as cotas das IAs entram
// a cada leitura.
//
// Planejar (planner.ts + router.ts): o card vai para Planejando, o planejador roda em segundo plano e o plano cai em
// Aguardando aprovação; a pessoa edita, aprova (o plano vira comentário na issue e o card entra na fila de execução)
// ou descarta. Planejamento que falha volta o card à coluna da fonte, com o erro.
//
// Imagens (attachments.ts): as do card novo ficam no store (BoardCard.attachments); as de um pedido de revisão, no
// plano (CardPlan.revisionAttachments). Descartar o plano apaga as das revisões; as do card ficam (a issue continua).
import { BOARD_COLUMNS, kindFromLabels, stageColumn, type AgentId, type BoardAllView, type BoardAttention, type BoardColumn, type BoardSummary, type BoardCard, type BoardIndex, type BoardProject, type BoardProjectConfig, type BoardView, type CardAttachment, type CardDetails, type CardEdit, type CardPlan, type CardWork, type LinearTeam, type PlanEdit } from '../../shared/board';
import { tr } from '../../shared/i18n';
import type { AccountInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { agentQuotas, AGENT_NAMES, bestClaudeAccount } from './agents';
import { BoardFiles, type DecodedImage } from './attachments';
import { CliError, execCli, orcaResult, retryOnce, type Exec } from './cli';
import { DEFAULT_PLANNER_MODEL, plannerPrompt, runPlanner, type PlanRevision } from './planner';
import { commentIssue, createGithub, issueDetails, updateIssue, createLinear, listGithub, listLinear, listLinearTeams } from './providers';
import { route } from './router';
import { fetchOrcaLimits, type OrcaLimits } from './orca-limits';
import { BoardRunner, DEFAULT_MAX_WORKERS, type MergeMethod } from './runner';
import type { BoardStore } from './store';

/** Planejamentos ao mesmo tempo (cada um é um Claude Code rodando). */
export const MAX_PLANNERS = 2;

export const PROJECTS_TTL_MS = 60_000;
export const TEAMS_TTL_MS = 5 * 60_000;
export const VIEW_TTL_MS = 20_000;
/** De quanto em quanto tempo os cards de todos os projetos são relidos (para o resumo nas salas). */
export const SUMMARY_REFRESH_MS = 2 * 60_000;
export const LIMITS_TTL_MS = 60_000;

export interface BoardServiceOptions {
  store: BoardStore;
  orca: string;
  /** Sem gh, projetos do GitHub mostram o aviso. */
  gh?: string;
  /** git (para ler o origin de cada repositório); padrão: `git` do PATH. */
  git?: string;
  exec?: Exec;
  now?: () => number;
  /** Contas do escritório com o uso de 5 h/semanal (as da barra superior). */
  accounts?: () => readonly AccountInfo[];
  /** IAs com a CLI neste computador. */
  installed?: ReadonlySet<AgentId>;
  /** CLI do Claude Code (o planejador); sem ela, planejar avisa. */
  claude?: string;
  /** Modelo do planejador (HABBLAUD_PLANNER_MODEL). */
  plannerModel?: string;
  /** Avisa que o quadro mudou (a página relê). */
  onChange?: () => void;
  /** Workers ao mesmo tempo no quadro todo (HABBLAUD_BOARD_MAX_WORKERS). */
  maxWorkers?: number;
  /** Como fazer o merge dos PRs (HABBLAUD_BOARD_MERGE: squash, merge ou rebase). */
  mergeMethod?: MergeMethod;
  /** Arquivos das imagens dos cards; padrão: a pasta board-attachments ao lado do board.json. */
  files?: BoardFiles;
}

export type BoardResult<T> = { ok: T } | { error: string; status: 400 | 404 | 409 | 502 };

interface OrcaProject {
  id: string;
  displayName: string;
  sourceRepoIds?: string[];
  providerIdentity?: { provider?: string; owner?: string; repo?: string } | null;
  gitRemoteIdentity?: { canonicalKey?: string } | null;
}

interface OrcaRepo {
  id: string;
  path?: string;
  displayName?: string;
}

interface Cached<T> {
  at: number;
  value: T;
}

/** "dono/repo" de uma URL do GitHub (https ou ssh); undefined para outros servidores. */
export function parseGithubUrl(url: string | undefined): string | undefined {
  const m = url ? /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim()) : null;
  return m?.[1];
}

/**
 * "dono/repo" do GitHub: o `origin` do repositório (`originUrl`, lido do git) vale mais que o do Orca, que pode
 * apontar outro remote (ex.: o upstream de um fork).
 */
export function githubRepoOf(p: OrcaProject, originUrl?: string): string | undefined {
  const origin = parseGithubUrl(originUrl);
  if (origin) return origin;
  const key = p.gitRemoteIdentity?.canonicalKey;
  const m = key ? /^github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i.exec(key) : null;
  if (m) return m[1];
  const id = p.providerIdentity;
  if (id?.provider === 'github' && id.owner && id.repo) return `${id.owner}/${id.repo}`;
  return undefined;
}

export class BoardService {
  private readonly exec: Exec;
  private readonly now: () => number;
  private projectsCache?: Cached<Omit<BoardProject, 'source' | 'linearTeam'>[]>;
  private teamsCache?: Cached<LinearTeam[] | null>;
  private views = new Map<string, Cached<Omit<BoardView, 'agents'>>>();
  private projectsLoading?: Promise<Omit<BoardProject, 'source' | 'linearTeam'>[]>;
  private teamsLoading?: Promise<LinearTeam[] | null>;
  private planning = new Set<string>();
  /** Cotas medidas pelo Orca (`orca account list`); relidas a cada LIMITS_TTL_MS quando alguém precisa. */
  private orcaLimits?: Cached<OrcaLimits>;
  private limitsLoading?: Promise<void>;
  readonly runner: BoardRunner;
  readonly files: BoardFiles;

  constructor(private readonly opts: BoardServiceOptions) {
    this.exec = opts.exec ?? execCli;
    this.now = opts.now ?? Date.now;
    this.files = opts.files ?? new BoardFiles(opts.store.attachmentsDir);
    this.runner = new BoardRunner({
      store: opts.store,
      exec: this.exec,
      orca: opts.orca,
      gh: opts.gh,
      git: opts.git,
      now: this.now,
      lookup: (p, c) => this.lookup(p, c),
      agents: () => this.agents(),
      refreshAgents: () => this.refreshAgents(),
      maxWorkers: opts.maxWorkers ?? DEFAULT_MAX_WORKERS,
      mergeMethod: opts.mergeMethod,
      saveAfterMerge: (p, command) => this.saveAfterMerge(p, command),
      onChange: opts.onChange,
      files: this.files,
    });
    // Planejamento que estava rodando quando o servidor parou: não volta sozinho.
    for (const { projectId, cardId, work } of opts.store.allWorks()) {
      const update = work.run?.merged?.update;
      if (update?.state === 'running') {
        // O comando de depois do merge pode ser justamente o que reinicia o Promp IA.
        const merged = { ...work.run!.merged!, update: { ...update, state: 'failed' as const, output: tr('O Promp IA reiniciou enquanto o comando rodava (se o comando reinicia o próprio Promp IA, isso é o esperado).'), at: this.now() } };
        opts.store.setWork(projectId, cardId, { ...work, run: { ...work.run!, merged } });
      }
      if (work.stage !== 'planning') continue;
      if (work.revising && work.plan) opts.store.setWork(projectId, cardId, { ...work, stage: 'approval', revising: undefined, error: tr('A revisão foi interrompida (o Promp IA reiniciou); o plano anterior continua.'), updatedAt: this.now() });
      else opts.store.setWork(projectId, cardId, { stage: 'failed', error: tr('O planejamento foi interrompido (o Promp IA reiniciou). Planeje de novo.'), updatedAt: this.now() });
    }
  }

  agents() {
    return agentQuotas(this.opts.accounts?.() ?? [], this.opts.installed ?? new Set(), this.orcaLimits?.value);
  }

  /**
   * Relê as cotas no Orca se as guardadas passaram de LIMITS_TTL_MS (antes de planejar, de criar as tarefas e de
   * começar workers). Falha = ficam as anteriores (e as contas do escritório).
   */
  refreshAgents(): Promise<void> {
    if (this.orcaLimits && this.now() - this.orcaLimits.at < LIMITS_TTL_MS) return Promise.resolve();
    this.limitsLoading ??= fetchOrcaLimits(this.exec, this.opts.orca)
      .then((value) => {
        this.orcaLimits = { at: this.now(), value };
      })
      .catch((err) => log.warnOnce(`board-limits:${errMsg(err)}`, `Quadro: cotas do Orca indisponíveis (${errMsg(err)}); valem as do escritório.`))
      .finally(() => (this.limitsLoading = undefined));
    return this.limitsLoading;
  }

  async index(): Promise<BoardIndex> {
    const [raw, teams] = await Promise.all([this.rawProjects(), this.linearTeams()]);
    return { projects: raw.map((p) => this.withConfig(p, teams ?? [])), linearTeams: teams ?? [], linear: teams !== null };
  }

  async view(projectId: string, refresh = false): Promise<BoardView | undefined> {
    const raw = await this.sourceView(projectId, refresh);
    if (!raw) return undefined;
    const works = this.opts.store.works(projectId);
    return { ...raw, cards: raw.cards.map((c) => ({ ...this.decorate(projectId, c, works[c.id]), projectId, projectName: raw.project.name })), agents: this.agents() };
  }

  /**
   * Todos os cards: os de cada projeto com fonte e os dos times do Linear que nenhum projeto usa (sem projeto: só
   * dá para ver e abrir). Um card do Linear que aparece em mais de um projeto (mesmo time) fica só no primeiro.
   */
  async allView(refresh = false): Promise<BoardAllView> {
    const index = await this.index();
    const projects = index.projects.filter((p) => p.source);
    const errors: BoardAllView['errors'] = [];
    const cards: BoardCard[] = [];
    const seen = new Set<string>();
    const views = await Promise.all(projects.map((p) => this.view(p.id, refresh).catch(() => undefined)));
    views.forEach((v, i) => {
      if (!v) return;
      if (v.error) errors.push({ name: projects[i].name, error: v.error });
      for (const c of v.cards) {
        const key = c.source === 'linear' ? c.id : `${projects[i].id}|${c.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cards.push(c);
      }
    });
    const usedTeams = new Set(projects.filter((p) => p.source === 'linear').map((p) => p.linearTeam));
    for (const team of index.linearTeams.filter((t) => !usedTeams.has(t.key))) {
      try {
        const loose = await this.teamCards(team.key, refresh);
        for (const c of loose) if (!seen.has(c.id)) cards.push(c);
      } catch (err) {
        errors.push({ name: `Linear ${team.key}`, error: describeError(err, 'linear') });
      }
    }
    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    return { projects: index.projects, cards, agents: this.agents(), fetchedAt: this.now(), errors };
  }

  private teamCache = new Map<string, Cached<BoardCard[]>>();

  private async teamCards(team: string, refresh: boolean): Promise<BoardCard[]> {
    const c = this.teamCache.get(team);
    if (!refresh && c && this.now() - c.at < VIEW_TTL_MS) return c.value;
    const value = await retryOnce(() => listLinear(this.exec, this.opts.orca, team, this.now()));
    this.teamCache.set(team, { at: this.now(), value });
    return value;
  }

  /** Resumo para o snapshot: contagem por coluna em cada sala (pasta do repositório) e os cards que precisam de você. */
  summary(): BoardSummary {
    const rooms: BoardSummary['rooms'] = {};
    const paths = new Map((this.projectsCache?.value ?? []).map((p) => [p.id, p.path]));
    for (const [projectId, cached] of this.views) {
      const path = paths.get(projectId);
      if (!path) continue;
      const works = this.opts.store.works(projectId);
      const counts: Partial<Record<BoardColumn, number>> = {};
      for (const c of cached.value.cards) {
        const col = this.decorate(projectId, c, works[c.id]).column;
        counts[col] = (counts[col] ?? 0) + 1;
      }
      rooms[path] = Object.fromEntries(BOARD_COLUMNS.filter((k) => counts[k]).map((k) => [k, counts[k]]));
    }
    const attention: BoardAttention[] = [];
    for (const { projectId, cardId, work } of this.opts.store.allWorks()) {
      const base = { projectId, cardId, ref: work.ref ?? cardId, title: work.title ?? '' };
      const q = work.run?.questions.at(-1);
      if (q) attention.push({ ...base, reason: 'question', at: q.at });
      else if (work.stage === 'approval') attention.push({ ...base, reason: 'approval', at: work.updatedAt });
      else if (work.stage === 'blocked') attention.push({ ...base, reason: 'blocked', at: work.updatedAt });
      else if (work.stage === 'review') attention.push({ ...base, reason: 'review', at: work.run?.finishedAt ?? work.updatedAt });
    }
    attention.sort((a, b) => b.at - a.at);
    return { rooms, attention };
  }

  /** Sala de uma pasta: o worktree de um card do quadro conta como a sala do repositório dele. */
  roomPathFor(cwd: string): string | undefined {
    for (const { work } of this.opts.store.allWorks()) {
      const wt = work.run?.worktree;
      if (wt?.repoPath && (cwd === wt.path || cwd.startsWith(`${wt.path}/`))) return wt.repoPath;
    }
    return undefined;
  }

  private decorate(projectId: string, card: BoardCard, work: CardWork | undefined): BoardCard {
    const attachments = this.opts.store.attachments(projectId, card.id);
    const withImages = attachments.length ? { ...card, attachments: [...attachments] } : card;
    if (!work) return withImages;
    return { ...withImages, column: stageColumn(work.stage, card.column), work };
  }

  /** O anexo `attachmentId` do card (do card novo, de uma revisão do plano ou da revisão em andamento) e o arquivo. */
  attachment(projectId: string, cardId: string, attachmentId: string): { attachment: CardAttachment; data: Buffer } | undefined {
    const work = this.opts.store.work(projectId, cardId);
    const all = [...this.opts.store.attachments(projectId, cardId), ...(work?.plan?.revisionAttachments?.flat() ?? []), ...(work?.revisingAttachments ?? [])];
    const attachment = all.find((a) => a.id === attachmentId);
    const data = attachment && this.files.read(attachment);
    return attachment && data ? { attachment, data } : undefined;
  }

  /** Apaga os arquivos das imagens das revisões de um trabalho que saiu do card. */
  private dropRevisionFiles(work: CardWork | undefined): void {
    this.files.remove(work?.plan?.revisionAttachments?.flat());
    this.files.remove(work?.revisingAttachments);
  }

  private summaryTimer: NodeJS.Timeout | null = null;

  /** Liga a execução (as rodadas do runner) e a releitura periódica dos cards de todos os projetos (resumo nas salas). */
  start(): void {
    this.runner.start();
    const refresh = () =>
      void Promise.all([this.allView(), this.refreshAgents()])
        .then(() => this.opts.onChange?.())
        .catch(() => undefined);
    refresh();
    this.summaryTimer = setInterval(refresh, SUMMARY_REFRESH_MS);
    this.summaryTimer.unref?.();
  }

  stop(): void {
    this.runner.stop();
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = null;
  }

  /** Projeto e card atuais (da fonte, com cache). */
  lookup(projectId: string, cardId: string): Promise<{ project: BoardProject; card: BoardCard } | undefined> {
    return this.findCard(projectId, cardId);
  }

  private async findCard(projectId: string, cardId: string): Promise<{ project: BoardProject; card: BoardCard } | undefined> {
    const raw = await this.sourceView(projectId, false);
    const card = raw?.cards.find((c) => c.id === cardId);
    return raw && card ? { project: raw.project, card } : undefined;
  }

  private setWork(projectId: string, cardId: string, work: CardWork | undefined): void {
    const prev = this.opts.store.work(projectId, cardId);
    if (work && prev) work = { ...work, ref: work.ref ?? prev.ref, title: work.title ?? prev.title };
    this.opts.store.setWork(projectId, cardId, work);
    this.opts.onChange?.();
  }

  /** Começa o planejamento (em segundo plano). Devolve o card já em Planejando. */
  /**
   * Planeja (ou, com `feedback`, revisa o plano que espera aprovação: o planejador recebe o plano atual e o pedido).
   * Durante a revisão o plano anterior fica guardado e volta se ela falhar.
   */
  async plan(projectId: string, cardId: string, feedback?: string, images: readonly DecodedImage[] = []): Promise<BoardResult<BoardCard>> {
    if (images.length && !feedback) return { error: tr('As imagens acompanham um pedido de revisão: escreva o que mudar.'), status: 400 };
    const found = await this.findCard(projectId, cardId);
    if (!found) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    const { project, card } = found;
    const current = this.opts.store.work(projectId, cardId);
    if (current?.stage === 'planning' || this.planning.has(`${projectId}|${cardId}`)) return { error: tr('Este card já está sendo planejado.'), status: 409 };
    if (current && current.stage !== 'approval' && current.stage !== 'failed') return { error: tr('O plano deste card já foi aprovado.'), status: 409 };
    if (feedback && (current?.stage !== 'approval' || !current.plan)) return { error: tr('Só dá para pedir revisão de um plano que espera aprovação.'), status: 409 };
    if (card.column === 'done') return { error: tr('Este card já está concluído.'), status: 409 };
    if (!this.opts.claude) return { error: tr('O planejador precisa do Claude Code (claude) neste computador.'), status: 409 };
    if (!project.path) return { error: tr('O Orca não informou a pasta deste projeto.'), status: 409 };
    const account = bestClaudeAccount(this.opts.accounts?.() ?? []);
    if (!account && (this.opts.accounts?.() ?? []).some((a) => !a.provider && !a.id.startsWith('orca:'))) {
      return { error: tr('Nenhuma conta do Claude com cota para planejar agora.'), status: 409 };
    }
    if (this.planning.size >= MAX_PLANNERS) return { error: tr('Já há {0} planejamentos em andamento; espere um terminar.', [MAX_PLANNERS]), status: 409 };
    let revisingAttachments: CardAttachment[] = [];
    try {
      revisingAttachments = this.files.save(images);
    } catch (err) {
      log.warn(`Quadro: não deu para gravar as imagens de ${card.ref}: ${errMsg(err)}`);
      return { error: tr('Não deu para gravar as imagens: {0}', [errMsg(err)]), status: 502 };
    }
    // Planejar do zero joga fora o plano anterior (e as imagens das revisões dele).
    if (!feedback) this.dropRevisionFiles(current);
    const work: CardWork = feedback
      ? { stage: 'planning', ref: card.ref, title: card.title, plan: current!.plan, revising: feedback, ...(revisingAttachments.length ? { revisingAttachments } : {}), updatedAt: this.now() }
      : { stage: 'planning', ref: card.ref, title: card.title, updatedAt: this.now() };
    this.setWork(projectId, cardId, work);
    const key = `${projectId}|${cardId}`;
    this.planning.add(key);
    void this.runPlan(project, card, account?.configDir, feedback ? { previous: current!.plan!, feedback, attachments: revisingAttachments } : undefined).finally(() => {
      this.planning.delete(key);
      this.opts.onChange?.();
    });
    return { ok: this.decorate(projectId, card, work) };
  }

  private async runPlan(project: BoardProject, card: BoardCard, configDir: string | undefined, revision?: PlanRevision): Promise<void> {
    const model = this.opts.plannerModel || DEFAULT_PLANNER_MODEL;
    try {
      await this.refreshAgents();
      const quotas = this.agents();
      // O card guarda só o começo da descrição: o planejador lê a issue inteira (se a fonte responder).
      const full = await issueDetails(this.exec, { gh: this.opts.gh, orca: this.opts.orca }, { source: card.source, repo: project.github, ref: card.ref }).catch(() => undefined);
      const forPlanner = full ? { ...card, title: full.title || card.title, body: full.body } : card;
      const images = this.planImages(project.id, card.id, revision);
      const raw = await runPlanner(
        { claude: this.opts.claude!, cwd: project.path!, configDir, model, exec: this.exec, ...(images.card.length || images.revision.length ? { addDirs: [this.files.dir] } : {}) },
        plannerPrompt(project, forPlanner, quotas, revision, images),
      );
      const { actions, notes } = route(raw.actions, this.agents());
      if (!actions.length) throw new CliError(tr('o planejador não devolveu nenhuma ação válida'));
      const revisions = revision ? [...(revision.previous.revisions ?? []), revision.feedback] : undefined;
      // Uma lista por revisão (planos antigos não tinham: [] para cada uma).
      const revisionAttachments = revision
        ? [...(revision.previous.revisions ?? []).map((_, i) => revision.previous.revisionAttachments?.[i] ?? []), revision.attachments ?? []]
        : undefined;
      const plan: CardPlan = {
        summary: raw.summary,
        actions,
        notes,
        createdAt: this.now(),
        model,
        ...(revisions ? { revisions } : {}),
        ...(revisionAttachments?.some((l) => l.length) ? { revisionAttachments } : {}),
      };
      // A pessoa pode ter descartado enquanto rodava (o descarte já apagou as imagens da revisão).
      if (this.opts.store.work(project.id, card.id)?.stage !== 'planning') return;
      this.setWork(project.id, card.id, { stage: 'approval', plan, updatedAt: this.now() });
    } catch (err) {
      const raw = err instanceof CliError ? err.message : errMsg(err);
      // O Orca loga o Claude só nos terminais dele; o planejador roda fora deles, com o login da pasta do Claude Code.
      const msg = /authenticat|oauth|not logged|log ?in|\/login/i.test(raw)
        ? tr('o Claude Code não está logado fora do Orca ({0}). Rode "claude auth login" num terminal e planeje de novo.', [raw])
        : raw;
      log.warn(`Quadro: planejamento de ${card.ref} (${project.name}) falhou: ${raw}`);
      if (this.opts.store.work(project.id, card.id)?.stage !== 'planning') return;
      // A revisão que falhou não fica no plano: as imagens dela também não.
      this.files.remove(revision?.attachments);
      if (revision) this.setWork(project.id, card.id, { stage: 'approval', plan: revision.previous, error: tr('A revisão falhou ({0}); o plano anterior continua.', [msg]), updatedAt: this.now() });
      else this.setWork(project.id, card.id, { stage: 'failed', error: tr('O planejamento falhou: {0}', [msg]), updatedAt: this.now() });
    }
  }

  /** Caminhos das imagens para o planejador: as do card e as do pedido de revisão atual. */
  private planImages(projectId: string, cardId: string, revision?: PlanRevision): { card: string[]; revision: string[] } {
    const paths = (list: readonly CardAttachment[] | undefined) => (list ?? []).map((a) => this.files.path(a)).filter((p): p is string => !!p);
    return { card: paths(this.opts.store.attachments(projectId, cardId)), revision: paths(revision?.attachments) };
  }

  /** Texto completo do card na fonte (para editar). */
  async details(projectId: string, cardId: string): Promise<BoardResult<CardDetails>> {
    const found = await this.findCard(projectId, cardId);
    if (!found) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    const { project, card } = found;
    try {
      const d = await issueDetails(this.exec, { gh: this.opts.gh, orca: this.opts.orca }, { source: card.source, repo: project.github, ref: card.ref });
      const fromLabels = kindFromLabels(d.labels);
      return { ok: { kind: fromLabels !== 'issue' ? fromLabels : card.kind, title: d.title, body: d.body } };
    } catch (err) {
      return { error: describeError(err, card.source), status: 502 };
    }
  }

  /**
   * Edita o card: título, descrição e tipo vão para a issue na fonte. Card em execução não muda (as instruções dos
   * agentes já foram dadas); com plano esperando aprovação, o plano continua e a página sugere planejar de novo.
   */
  async edit(projectId: string, cardId: string, edit: CardEdit): Promise<BoardResult<BoardCard>> {
    const found = await this.findCard(projectId, cardId);
    if (!found) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    const { project, card } = found;
    const work = this.opts.store.work(projectId, cardId);
    if (work && ['planning', 'queued', 'running', 'blocked'].includes(work.stage)) return { error: tr('Não dá para editar um card que está sendo planejado ou executado.'), status: 409 };
    const target = { source: card.source, repo: project.github, ref: card.ref };
    const bins = { gh: this.opts.gh, orca: this.opts.orca };
    try {
      const current = await issueDetails(this.exec, bins, target);
      await updateIssue(this.exec, bins, target, edit, current);
    } catch (err) {
      return { error: describeError(err, card.source), status: 502 };
    }
    const updated: BoardCard = { ...card, title: edit.title, body: edit.body.length > 600 ? `${edit.body.slice(0, 599)}…` : edit.body, kind: edit.kind, updatedAt: this.now() };
    const cached = this.views.get(projectId);
    if (cached) cached.value = { ...cached.value, cards: cached.value.cards.map((c) => (c.id === cardId ? updated : c)) };
    if (work) this.setWork(projectId, cardId, { ...work, title: edit.title, ...(work.stage === 'approval' ? { error: tr('O card foi editado depois do plano: peça uma revisão ou planeje de novo se mudou o que precisa ser feito.') } : {}) });
    else this.opts.onChange?.();
    return { ok: { ...this.decorate(projectId, updated, this.opts.store.work(projectId, cardId)), projectId, projectName: project.name } };
  }

  /** Plano editado na página (troca de IA, ações removidas ou reescritas): o roteador confere de novo. */
  async editPlan(projectId: string, cardId: string, edit: PlanEdit): Promise<BoardResult<BoardCard>> {
    const found = await this.findCard(projectId, cardId);
    const work = this.opts.store.work(projectId, cardId);
    if (!found || !work) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    if (work.stage !== 'approval' || !work.plan) return { error: tr('Só dá para editar um plano que espera aprovação.'), status: 409 };
    const { actions, notes } = route(edit.actions, this.agents());
    if (!actions.length) return { error: tr('O plano precisa de pelo menos uma ação com título e instruções.'), status: 400 };
    const plan: CardPlan = { ...work.plan, summary: typeof edit.summary === 'string' ? edit.summary.trim().slice(0, 1_000) : work.plan.summary, actions, notes };
    const next: CardWork = { stage: 'approval', plan, updatedAt: this.now() };
    this.setWork(projectId, cardId, next);
    return { ok: this.decorate(projectId, found.card, next) };
  }

  /** Aprova: o card entra na fila de execução e o plano vira comentário na issue (se falhar, só no log). */
  async approve(projectId: string, cardId: string): Promise<BoardResult<BoardCard>> {
    const found = await this.findCard(projectId, cardId);
    const work = this.opts.store.work(projectId, cardId);
    if (!found || !work) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    if (work.stage !== 'approval' || !work.plan?.actions.length) return { error: tr('Este card não tem plano esperando aprovação.'), status: 409 };
    const quotas = new Map(this.agents().map((q) => [q.agent, q]));
    const stuck = work.plan.actions.filter((a) => !quotas.get(a.agent)?.installed);
    if (stuck.length) return { error: tr('"{0}" usa {1}, que não está instalada neste computador: troque a IA.', [stuck[0].title, AGENT_NAMES[stuck[0].agent]]), status: 409 };
    const next: CardWork = { stage: 'queued', plan: work.plan, updatedAt: this.now() };
    this.setWork(projectId, cardId, next);
    void this.runner.tick();
    const { project, card } = found;
    commentIssue(this.exec, { gh: this.opts.gh, orca: this.opts.orca }, { source: card.source, repo: project.github, ref: card.ref }, planMarkdown(work.plan)).catch((err) =>
      log.warn(`Quadro: não deu para comentar o plano em ${card.ref}: ${err instanceof CliError ? err.message : errMsg(err)}`),
    );
    return { ok: this.decorate(projectId, card, next) };
  }

  /**
   * Descarta o plano (ou o erro) ou cancela a execução (os workers param; o worktree fica): o card volta à coluna
   * da fonte.
   */
  async discard(projectId: string, cardId: string): Promise<BoardResult<BoardCard>> {
    const found = await this.findCard(projectId, cardId);
    if (!found) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    const work = this.opts.store.work(projectId, cardId);
    if (work?.run) await this.runner.cancel(projectId, cardId);
    // Cancelar uma revisão volta ao plano anterior (o resultado que chegar depois é ignorado).
    else if (work?.stage === 'planning' && work.revising && work.plan) {
      this.files.remove(work.revisingAttachments);
      this.setWork(projectId, cardId, { ...work, stage: 'approval', revising: undefined, revisingAttachments: undefined, error: undefined, updatedAt: this.now() });
    } else this.setWork(projectId, cardId, undefined);
    const after = this.opts.store.work(projectId, cardId);
    if (!after) this.dropRevisionFiles(work);
    if (after) return { ok: this.decorate(projectId, found.card, after) };
    return { ok: this.decorate(projectId, found.card, undefined) };
  }

  /** Resposta a uma pergunta de um worker. */
  async answer(projectId: string, cardId: string, questionId: string, text: string): Promise<BoardResult<BoardCard>> {
    const err = await this.runner.answer(projectId, cardId, questionId, text);
    if (err) return { error: err, status: 409 };
    return this.current(projectId, cardId);
  }

  /** Aprova o PR do card: merge e atualização do projeto. */
  async merge(projectId: string, cardId: string, afterMerge?: string): Promise<BoardResult<BoardCard>> {
    const err = await this.runner.merge(projectId, cardId, afterMerge);
    if (err) return { error: err, status: 409 };
    return this.current(projectId, cardId);
  }

  private saveAfterMerge(projectId: string, command: string): void {
    const project = this.projectsCache?.value.find((p) => p.id === projectId);
    const cur = this.opts.store.config(projectId) ?? (project ? this.withConfig(project, this.teamsCache?.value ?? []) : undefined);
    if (!cur) return;
    this.opts.store.setConfig(projectId, { source: cur.source, ...(cur.linearTeam ? { linearTeam: cur.linearTeam } : {}), ...(command ? { afterMerge: command } : {}) });
  }

  /** Tenta de novo um card travado. */
  async retry(projectId: string, cardId: string): Promise<BoardResult<BoardCard>> {
    const err = await this.runner.retry(projectId, cardId);
    if (err) return { error: err, status: 409 };
    return this.current(projectId, cardId);
  }

  private async current(projectId: string, cardId: string): Promise<BoardResult<BoardCard>> {
    const found = await this.findCard(projectId, cardId);
    if (!found) return { error: tr('card desconhecido (a lista pode estar desatualizada: atualize o quadro)'), status: 404 };
    return { ok: this.decorate(projectId, found.card, this.opts.store.work(projectId, cardId)) };
  }

  private async sourceView(projectId: string, refresh: boolean): Promise<Omit<BoardView, 'agents'> | undefined> {
    const cached = this.views.get(projectId);
    if (!refresh && cached && this.now() - cached.at < VIEW_TTL_MS) return cached.value;
    const index = await this.index();
    const project = index.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const view: Omit<BoardView, 'agents'> = { project, cards: [], fetchedAt: this.now() };
    try {
      if (project.source === 'github') {
        if (!project.github) view.error = tr('Este projeto não tem um repositório do GitHub (origin): escolha o Linear.');
        else if (!this.opts.gh) view.error = tr('A CLI do GitHub (gh) não foi encontrada neste computador.');
        else view.cards = await listGithub(this.exec, this.opts.gh, project.github, this.now());
      } else if (project.source === 'linear') {
        if (!project.linearTeam) view.error = tr('Escolha o time do Linear deste projeto.');
        else view.cards = await retryOnce(() => listLinear(this.exec, this.opts.orca, project.linearTeam!, this.now()));
      } else {
        view.error = tr('Escolha de onde vêm as tarefas deste projeto: GitHub ou Linear.');
      }
    } catch (err) {
      view.error = describeError(err, project.source);
    }
    view.cards.sort((a, b) => b.updatedAt - a.updatedAt);
    this.views.set(projectId, { at: this.now(), value: view });
    return view;
  }

  /**
   * Card novo: vira issue na fonte do projeto (com a label do tipo, quando existe lá) e entra no Backlog. Erro de
   * configuração ou da fonte volta como `{error}` (a página mostra); projeto desconhecido, undefined.
   */
  async create(projectId: string, card: CardEdit, images: readonly DecodedImage[] = []): Promise<{ card: BoardCard } | { error: string } | undefined> {
    const project = (await this.index()).projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const body = `${card.body.trim()}\n\n---\n${tr('_Criado pelo Promp IA._')}`.trim();
    // As imagens são gravadas antes da issue (erro aqui não deixa issue sem as imagens) e apagadas se a fonte falhar.
    let attachments: CardAttachment[];
    try {
      attachments = this.files.save(images);
    } catch (err) {
      log.warn(`Quadro: não deu para gravar as imagens do card novo: ${errMsg(err)}`);
      return { error: tr('Não deu para gravar as imagens: {0}', [errMsg(err)]) };
    }
    try {
      let created: BoardCard;
      if (project.source === 'github' && project.github && this.opts.gh) created = await createGithub(this.exec, this.opts.gh, project.github, { ...card, body }, this.now());
      else if (project.source === 'linear' && project.linearTeam) created = await createLinear(this.exec, this.opts.orca, project.linearTeam, { ...card, body }, this.now());
      else {
        this.files.remove(attachments);
        return { error: tr('Escolha de onde vêm as tarefas deste projeto: GitHub ou Linear.') };
      }
      const cached = this.views.get(projectId);
      if (cached) cached.value = { ...cached.value, cards: [created, ...cached.value.cards.filter((c) => c.id !== created.id)] };
      if (attachments.length) this.opts.store.setAttachments(projectId, created.id, attachments);
      this.opts.onChange?.();
      return { card: this.decorate(projectId, created, undefined) };
    } catch (err) {
      this.files.remove(attachments);
      return { error: describeError(err, project.source) };
    }
  }

  async setConfig(projectId: string, config: BoardProjectConfig): Promise<BoardProject | undefined> {
    const raw = (await this.rawProjects()).find((p) => p.id === projectId);
    if (!raw) return undefined;
    // O comando de depois do merge não vem do seletor de fonte: fica o que estava.
    const afterMerge = config.afterMerge ?? this.opts.store.config(projectId)?.afterMerge;
    this.opts.store.setConfig(projectId, { source: config.source, ...(config.linearTeam ? { linearTeam: config.linearTeam } : {}), ...(afterMerge ? { afterMerge } : {}) });
    this.views.delete(projectId);
    return this.withConfig(raw, (await this.linearTeams()) ?? []);
  }

  private withConfig(p: Omit<BoardProject, 'source' | 'linearTeam' | 'afterMerge'>, teams: LinearTeam[]): BoardProject {
    const saved = this.opts.store.config(p.id);
    if (saved) return { ...p, source: saved.source, ...(saved.linearTeam ? { linearTeam: saved.linearTeam } : {}), ...(saved.afterMerge ? { afterMerge: saved.afterMerge } : {}) };
    if (p.github) return { ...p, source: 'github' };
    if (teams.length === 1) return { ...p, source: 'linear', linearTeam: teams[0].key };
    return { ...p, source: null };
  }

  /**
   * Projetos do Orca. Com cache vencido, devolve o cache na hora e renova em segundo plano (a CLI do Orca pode levar
   * dezenas de segundos com a máquina carregada; os projetos quase nunca mudam).
   */
  private rawProjects(): Promise<Omit<BoardProject, 'source' | 'linearTeam'>[]> {
    const c = this.projectsCache;
    if (c && this.now() - c.at < PROJECTS_TTL_MS) return Promise.resolve(c.value);
    this.projectsLoading ??= this.fetchProjects().finally(() => (this.projectsLoading = undefined));
    if (c) {
      this.projectsLoading.catch(() => undefined);
      return Promise.resolve(c.value);
    }
    return this.projectsLoading;
  }

  private async fetchProjects(): Promise<Omit<BoardProject, 'source' | 'linearTeam'>[]> {
    let projects: OrcaProject[];
    let repos: OrcaRepo[];
    try {
      [projects, repos] = await Promise.all([
        retryOnce(async () => orcaResult<{ projects: OrcaProject[] }>(await this.exec(this.opts.orca, ['project', 'list', '--json'])).projects ?? []),
        retryOnce(async () => {
          const r = orcaResult<{ repos?: OrcaRepo[] } | OrcaRepo[]>(await this.exec(this.opts.orca, ['repo', 'list', '--json']));
          return Array.isArray(r) ? r : (r.repos ?? []);
        }),
      ]);
    } catch (err) {
      // O Orca falhou agora: a última lista boa serve (os projetos quase nunca mudam).
      if (this.projectsCache) return this.projectsCache.value;
      throw err;
    }
    const repoById = new Map(repos.map((r) => [r.id, r]));
    const value = (
      await Promise.all(
        projects.map(async (p) => {
          const repo = (p.sourceRepoIds ?? []).map((id) => repoById.get(id)).find(Boolean);
          const origin = repo?.path ? await this.originUrl(repo.path) : undefined;
          const github = githubRepoOf(p, origin);
          return { id: p.id, name: p.displayName, ...(repo?.path ? { path: repo.path } : {}), ...(github ? { github } : {}) };
        }),
      )
    ).sort((a, b) => a.name.localeCompare(b.name));
    this.projectsCache = { at: this.now(), value };
    return value;
  }

  private async originUrl(path: string): Promise<string | undefined> {
    try {
      return (await this.exec(this.opts.git ?? 'git', ['-C', path, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Times do Linear; null = Linear não conectado no Orca (ou fora do ar). Mesmo esquema dos projetos: cache vencido
   * sai na hora e renova em segundo plano.
   */
  private linearTeams(): Promise<LinearTeam[] | null> {
    const c = this.teamsCache;
    if (c && this.now() - c.at < TEAMS_TTL_MS) return Promise.resolve(c.value);
    this.teamsLoading ??= this.fetchTeams().finally(() => (this.teamsLoading = undefined));
    return c ? Promise.resolve(c.value) : this.teamsLoading;
  }

  private async fetchTeams(): Promise<LinearTeam[] | null> {
    let value: LinearTeam[] | null;
    try {
      value = await retryOnce(() => listLinearTeams(this.exec, this.opts.orca));
    } catch {
      value = null;
    }
    this.teamsCache = { at: this.now(), value };
    return value;
  }
}

function describeError(err: unknown, source: BoardProject['source']): string {
  const msg = err instanceof CliError ? err.message : errMsg(err);
  if (source === 'github' && /disabled issues/i.test(msg)) return tr('As issues estão desligadas neste repositório do GitHub: ligue nas configurações do repositório ou escolha o Linear.');
  if (source === 'github' && /auth|login/i.test(msg)) return tr('O gh não está logado: rode gh auth login no computador.');
  return source === 'github' ? tr('O GitHub não respondeu: {0}', [msg]) : tr('O Linear não respondeu: {0}', [msg]);
}

/** O plano aprovado, em Markdown, para o comentário na issue. */
export function planMarkdown(plan: CardPlan): string {
  const byId = new Map(plan.actions.map((a, i) => [a.id, i + 1]));
  const lines = [`### ${tr('Plano do Promp IA')}`, '', plan.summary, ''];
  plan.actions.forEach((a, i) => {
    const deps = a.deps.map((d) => byId.get(d)).filter(Boolean);
    lines.push(`${i + 1}. **${a.title}** · ${AGENT_NAMES[a.agent]}${deps.length ? ` · ${tr('depois de {0}', [deps.join(', ')])}` : ''}`);
    if (a.reason) lines.push(`   ${a.reason}`);
  });
  if (plan.notes.length) lines.push('', ...plan.notes.map((n) => `> ${n}`));
  lines.push('', tr('_Aprovado no Promp IA._'));
  return lines.join('\n');
}
