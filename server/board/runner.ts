// Execução dos cards aprovados pelos agentes do Orca (orquestração do Orca: Run, Tasks e workers).
//
// Por card aprovado (estágio "queued"):
//   1. terminal coordenador do projeto (um por projeto, "Promp IA · coordenador"): as mutações da orquestração
//      exigem `--from <handle>` de um terminal vivo do Orca (o servidor não roda dentro de um);
//   2. `orchestration run-create` (um Run por card) e `worktree create` (cópia do repositório só do card, ligada à
//      issue, sem setup);
//   3. uma Task por ação do plano (`task-create`, com as dependências; as instruções levam os caminhos das imagens
//      anexadas ao card e aos pedidos de revisão do plano);
//   4. estágio "running": a cada rodada, `task-list` diz o que está pronto; cada Task pronta ganha um worker
//      (`worker-start --task … --agent <IA> --worktree path:<worktree>`), respeitando o limite de workers ao mesmo
//      tempo e a cota da IA; perguntas dos workers (`orchestration inbox`, tipo question/escalation) aparecem no card e
//      a resposta vai por `orchestration reply`;
//   5. todas as Tasks concluídas: commit, push e PR (`gh pr create`, "Closes #N"; no Linear, o PR é anexado à issue),
//      os workers são liberados e o card vai para Revisão. PR aceito = Concluído;
//   6. "Aprovar e fazer merge" (página): `gh pr merge`, apaga o branch e o worktree do card, atualiza o repositório
//      local (fast-forward, só se ele está no branch base e sem mudanças) e roda o comando de depois do merge do
//      projeto (ex.: build e reinício), se houver.
// Task que falha deixa o card travado ("blocked"): tentar de novo (`worker-start --retry-of`) ou cancelar.
//
// A CLI do Orca às vezes responde erro mesmo tendo feito a ação ("runtime_unavailable"): toda mutação da orquestração
// leva um `--retry-request` gravado antes (repetir devolve o resultado da primeira vez), e o worktree é procurado
// pelo nome antes de criar de novo. O estado fica em board.json: depois de reiniciar, a rodada continua de onde parou.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { ActionRun, BoardCard, BoardProject, CardAttachment, CardPlan, CardRun, CardWork, PlanAction } from '../../shared/board';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { AGENT_NAMES } from './agents';
import { imagesNote, type BoardFiles } from './attachments';
import type { AgentQuota } from '../../shared/board';
import { CliError, orcaResult, runShell, type Exec, type Shell } from './cli';
import { pickAgent, substitute, swapNote } from './router';
import type { BoardStore } from './store';

export const TICK_MS = 8_000;
export const REVIEW_CHECK_MS = 5 * 60_000;
export const DEFAULT_MAX_WORKERS = 3;
export const WORKER_START_TIMEOUT_MS = 5 * 60_000;
export const AFTER_MERGE_TIMEOUT_MS = 20 * 60_000;
export type MergeMethod = 'squash' | 'merge' | 'rebase';
const LOG_MAX = 40;
const COORDINATOR_TITLE = 'Promp IA · coordenador';

export interface RunnerDeps {
  store: BoardStore;
  exec: Exec;
  orca: string;
  gh?: string;
  git?: string;
  now?: () => number;
  /** Projeto e card atuais (da fonte). */
  lookup(projectId: string, cardId: string): Promise<{ project: BoardProject; card: BoardCard } | undefined>;
  agents(): AgentQuota[];
  /** Relê as cotas no Orca (se as guardadas estão velhas) antes de escolher as IAs. */
  refreshAgents?(): Promise<void>;
  maxWorkers?: number;
  /** Como o quadro faz o merge do PR (HABBLAUD_BOARD_MERGE; padrão squash). */
  mergeMethod?: MergeMethod;
  /** Grava o comando de depois do merge no projeto. */
  saveAfterMerge?(projectId: string, command: string): void;
  /** Arquivos das imagens dos cards (os caminhos vão nas instruções dos agentes). */
  files?: BoardFiles;
  shell?: Shell;
  onChange?: () => void;
}

/** Nome do worktree: "promp-<ref>-<título>" em minúsculas, sem acentos, até 48 caracteres. */
export function worktreeName(card: Pick<BoardCard, 'ref' | 'title'>): string {
  const slug = `${card.ref}-${card.title}`
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `promp-${slug}`.slice(0, 48).replace(/-+$/, '');
}

/** Caminhos absolutos das imagens do card: as anexadas ao criar e as dos pedidos de revisão do plano. */
export interface SpecImages {
  card: readonly string[];
  revisions: readonly string[];
}

/** Instruções da Task: a ação, o contexto do card e as regras do trabalho no worktree compartilhado. */
export function taskSpec(
  project: BoardProject,
  card: BoardCard,
  action: PlanAction,
  index: number,
  total: number,
  worktree: { path: string; branch: string },
  images: SpecImages = { card: [], revisions: [] },
): string {
  return [
    `Card ${card.ref} do projeto "${project.name}": ${card.title}`,
    `Ação ${index + 1} de ${total}: ${action.title}`,
    '',
    action.instructions,
    ...imagesNote(images.card, 'Imagens anexadas ao card (abra/leia cada uma antes de começar: ilustram a demanda):'),
    ...imagesNote(images.revisions, 'Imagens anexadas aos pedidos de correção do plano (abra/leia cada uma: ilustram a correção pedida):'),
    '',
    'Regras deste trabalho (Promp IA):',
    `- Trabalhe só no worktree ${worktree.path} (branch ${worktree.branch}).`,
    '- NÃO faça commit, push nem abra PR: o Promp IA faz isso quando todas as ações do card terminarem.',
    '- Outras ações do mesmo card rodam antes ou depois de você na mesma pasta: não desfaça mudanças que não são suas.',
    '- Se precisar de uma decisão que não está nas instruções, pergunte ao coordenador (orchestration ask) em vez de adivinhar.',
    '- Ao terminar, mande o worker_done com um resumo de 1 a 3 frases do que mudou.',
  ].join('\n');
}

/** Resumo do worker a partir do resultado da Task (o Orca grava o worker_done em JSON: subject, body, filesModified). */
export function workerSummary(result: string | null | undefined): string | undefined {
  if (!result) return undefined;
  try {
    const r = JSON.parse(result) as { subject?: unknown; body?: unknown; filesModified?: unknown };
    const text = typeof r.body === 'string' && r.body.trim() ? r.body.trim() : typeof r.subject === 'string' ? r.subject.trim() : '';
    const files = Array.isArray(r.filesModified) ? r.filesModified.filter((f): f is string => typeof f === 'string') : [];
    if (!text && !files.length) return undefined;
    return files.length ? `${text}${text ? ' ' : ''}(${files.slice(0, 8).join(', ')}${files.length > 8 ? '…' : ''})` : text;
  } catch {
    return result.trim() || undefined;
  }
}

function stripRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

interface OrcaTask {
  id: string;
  status: string;
  result?: string | null;
}

interface OrcaMessage {
  id: string;
  type?: string;
  subject?: string;
  body?: string;
  from_handle?: string;
  to_handle?: string;
  payload?: unknown;
}

export class BoardRunner {
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Cards com uma etapa demorada em andamento (preparação, worker-start, finalização). */
  private busy = new Set<string>();
  private lastReviewCheck = new Map<string, number>();
  /** worker-start em andamento (por id de pedido). */
  private inflight = new Set<string>();

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma rodada: prepara os aprovados, anda com os em execução e confere os PRs em revisão. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const { projectId, cardId, work } of this.d.store.allWorks()) {
        const key = `${projectId}|${cardId}`;
        if (this.busy.has(key)) continue;
        try {
          if (work.stage === 'queued') await this.guard(key, () => this.prepare(projectId, cardId));
          else if (work.stage === 'running') await this.advance(projectId, cardId);
          else if (work.stage === 'review') await this.checkReview(projectId, cardId);
          // Card que já saiu da execução não tem worker para receber resposta.
          const ended = work.stage === 'review' || work.stage === 'done' || work.stage === 'failed';
          if (ended && work.run?.questions.length) this.expireQuestions(projectId, cardId);
        } catch (err) {
          log.warnOnce(`board-run:${key}:${errMsg(err)}`, `Quadro: execução de ${cardId} (${projectId}): ${errMsg(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async guard(key: string, fn: () => Promise<void>): Promise<void> {
    this.busy.add(key);
    try {
      await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  private work(projectId: string, cardId: string): CardWork | undefined {
    return this.d.store.work(projectId, cardId);
  }

  /** Grava o trabalho (só se o card ainda está no estágio esperado: a pessoa pode ter cancelado no meio). */
  private save(projectId: string, cardId: string, mutate: (w: CardWork) => CardWork | undefined, expect?: CardWork['stage'][]): CardWork | undefined {
    const cur = this.work(projectId, cardId);
    if (!cur || (expect && !expect.includes(cur.stage))) return undefined;
    const next = mutate(structuredClone(cur));
    if (next) next.updatedAt = this.now();
    this.d.store.setWork(projectId, cardId, next);
    this.d.onChange?.();
    return next;
  }

  private specImages(projectId: string, cardId: string, plan: CardPlan): SpecImages {
    const files = this.d.files;
    if (!files) return { card: [], revisions: [] };
    const paths = (list: readonly CardAttachment[]) => list.map((a) => files.path(a)).filter((p): p is string => !!p);
    return { card: paths(this.d.store.attachments(projectId, cardId)), revisions: paths(plan.revisionAttachments?.flat() ?? []) };
  }

  private note(run: CardRun, text: string): void {
    run.log.push({ at: this.now(), text });
    if (run.log.length > LOG_MAX) run.log.splice(0, run.log.length - LOG_MAX);
  }

  private orca(args: string[], timeoutMs?: number): Promise<string> {
    return this.d.exec(this.d.orca, args, { timeoutMs });
  }

  /** Mutação da orquestração com --retry-request: se a resposta se perder, repetir devolve o resultado da primeira. */
  private async mutate<T>(args: string[], requestId: string, timeoutMs?: number): Promise<T> {
    const full = [...args, '--retry-request', requestId, '--json'];
    try {
      return orcaResult<T>(await this.orca(full, timeoutMs));
    } catch (err) {
      if (err instanceof CliError && err.code && !['runtime_unavailable', 'outcome_unknown'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 1_000));
      return orcaResult<T>(await this.orca(full, timeoutMs));
    }
  }

  // ---- terminal coordenador ----

  private async coordinator(project: BoardProject): Promise<string> {
    const saved = this.d.store.coordinator(project.id);
    if (saved) {
      try {
        orcaResult(await this.orca(['terminal', 'show', '--terminal', saved, '--json']));
        return saved;
      } catch {
        // fechado: cria outro
      }
    }
    if (!project.path) throw new CliError(tr('O Orca não informou a pasta deste projeto.'));
    const r = orcaResult<{ terminal: { handle: string } }>(
      await this.orca(['terminal', 'create', '--worktree', `path:${project.path}`, '--title', COORDINATOR_TITLE, '--json'], 60_000),
    );
    this.d.store.setCoordinator(project.id, r.terminal.handle);
    return r.terminal.handle;
  }

  // ---- 1-3: preparação ----

  private async prepare(projectId: string, cardId: string): Promise<void> {
    const found = await this.d.lookup(projectId, cardId);
    const work = this.work(projectId, cardId);
    if (!found || !work?.plan || work.stage !== 'queued') return;
    const { project, card } = found;
    // Antes de criar as tarefas: IA que ficou sem cota (ou que o Orca não consegue usar) desde o plano dá lugar à
    // equivalente disponível.
    if (!work.run?.runId) {
      await this.d.refreshAgents?.().catch(() => undefined);
      const swap = substitute(work.plan.actions, this.d.agents());
      if (swap.notes.length) {
        this.save(projectId, cardId, (w) => ({ ...w, plan: { ...w.plan!, actions: swap.actions, notes: [...w.plan!.notes, ...swap.notes] } }), ['queued']);
        return this.prepare(projectId, cardId);
      }
    }
    const plan = work.plan;
    const run: CardRun = work.run ?? {
      actions: Object.fromEntries(plan.actions.map((a) => [a.id, { state: 'waiting' } as ActionRun])),
      questions: [],
      answered: [],
      startedAt: this.now(),
      log: [],
    };
    const persist = () => this.save(projectId, cardId, (w) => ({ ...w, run }), ['queued']);
    try {
      const from = await this.coordinator(project);
      if (!run.runId) {
        run.runRequest ??= randomUUID();
        persist();
        const r = await this.mutate<{ run: { id: string } }>(['orchestration', 'run-create', '--from', from, '--objective', `${card.ref} ${card.title}`.slice(0, 200)], run.runRequest);
        run.runId = r.run.id;
        this.note(run, tr('Run {0} criado no Orca.', [run.runId]));
        persist();
      }
      if (!run.worktree) {
        run.worktreeName ??= worktreeName(card);
        persist();
        run.worktree = await this.ensureWorktree(project, card, run.worktreeName);
        this.note(run, tr('Worktree {0} (branch {1}).', [run.worktree.path, run.worktree.branch]));
        persist();
      }
      for (const [i, action] of plan.actions.entries()) {
        const a = run.actions[action.id];
        if (a.taskId) continue;
        a.createRequest ??= randomUUID();
        persist();
        const deps = action.deps.map((d) => run.actions[d]?.taskId).filter((x): x is string => !!x);
        const r = await this.mutate<{ task: { id: string } }>(
          [
            'orchestration',
            'task-create',
            '--from',
            from,
            '--run',
            run.runId,
            '--task-title',
            action.title.slice(0, 120),
            '--spec',
            taskSpec(project, card, action, i, plan.actions.length, { path: run.worktree.path, branch: stripRef(run.worktree.branch) }, this.specImages(projectId, cardId, plan)),
            '--deps',
            JSON.stringify(deps),
          ],
          a.createRequest,
        );
        a.taskId = r.task.id;
        persist();
      }
      this.note(run, tr('{0} tarefas criadas; começando.', [plan.actions.length]));
      this.save(projectId, cardId, (w) => ({ ...w, stage: 'running', run, error: undefined }), ['queued']);
    } catch (err) {
      const msg = err instanceof CliError ? err.message : errMsg(err);
      this.note(run, tr('Preparação falhou: {0}', [msg]));
      this.save(projectId, cardId, (w) => ({ ...w, stage: 'blocked', run, error: tr('Não deu para preparar a execução: {0}', [msg]) }), ['queued']);
    }
  }

  private async ensureWorktree(project: BoardProject, card: BoardCard, name: string): Promise<{ id: string; path: string; branch: string; repoPath?: string }> {
    const withRepo = (w: { id: string; path: string; branch: string }) => ({ ...w, ...(project.path ? { repoPath: project.path } : {}) });
    const existing = await this.findWorktree(name);
    if (existing) return withRepo(existing);
    const issue = card.source === 'github' ? ['--issue', card.ref.replace(/^#/, '')] : ['--linear-issue', card.ref];
    try {
      const r = orcaResult<{ worktree?: { id: string; path: string; branch: string } }>(
        await this.orca(['worktree', 'create', '--name', name, '--repo', `path:${project.path}`, '--no-parent', '--setup', 'skip', ...issue, '--json'], 120_000),
      );
      if (r.worktree?.path) return withRepo({ id: r.worktree.id, path: r.worktree.path, branch: r.worktree.branch });
    } catch (err) {
      // A CLI às vezes falha depois de criar: confere antes de desistir.
      const again = await this.findWorktree(name);
      if (again) return withRepo(again);
      throw err;
    }
    const found = await this.findWorktree(name);
    if (!found) throw new CliError(tr('o Orca não devolveu o worktree criado'));
    return withRepo(found);
  }

  private async findWorktree(name: string): Promise<{ id: string; path: string; branch: string } | undefined> {
    const r = orcaResult<{ worktrees: { id: string; path: string; branch?: string; displayName?: string }[] }>(await this.orca(['worktree', 'list', '--json'], 30_000));
    const w = r.worktrees.find((x) => x.displayName === name || x.path.endsWith(`/${name}`));
    return w ? { id: w.id, path: w.path, branch: w.branch ?? '' } : undefined;
  }

  // ---- 4: execução ----

  /** Workers ativos em todos os cards (o limite vale para o quadro todo). */
  private activeWorkers(): number {
    let n = 0;
    for (const { work } of this.d.store.allWorks()) {
      for (const a of Object.values(work.run?.actions ?? {})) if (a.state === 'starting' || a.state === 'running') n++;
    }
    return n;
  }

  private async advance(projectId: string, cardId: string): Promise<void> {
    const work = this.work(projectId, cardId);
    const run = work?.run;
    if (!work?.plan || !run?.runId || !run.worktree) return;
    const tasks = orcaResult<{ tasks: OrcaTask[] }>(await this.orca(['orchestration', 'task-list', '--run', run.runId, '--json'])).tasks ?? [];
    const byTask = new Map(tasks.map((t) => [t.id, t]));
    let changed = false;
    for (const action of work.plan.actions) {
      const a = run.actions[action.id];
      const t = a.taskId ? byTask.get(a.taskId) : undefined;
      if (!t) continue;
      if (t.status === 'completed' && a.state !== 'done') {
        Object.assign(a, { state: 'done', finishedAt: this.now(), result: workerSummary(t.result) ?? a.result, waitingFor: undefined });
        this.note(run, tr('Concluída: {0}', [action.title]));
        changed = true;
      } else if (t.status === 'failed' && a.state !== 'failed' && a.state !== 'canceled') {
        Object.assign(a, { state: 'failed', finishedAt: this.now(), error: workerSummary(t.result) ?? tr('a tarefa falhou'), waitingFor: undefined });
        this.note(run, tr('Falhou: {0}', [action.title]));
        changed = true;
      } else if (t.status === 'dispatched' && a.state === 'starting') {
        a.state = 'running';
        changed = true;
      }
    }
    // Worker que começou sem o id do dispatch na resposta (ou cuja resposta se perdeu): acha pela lista do Run.
    if (work.plan.actions.some((x) => run.actions[x.id].state === 'running' && !run.actions[x.id].dispatchId)) {
      const workers = await this.orca(['orchestration', 'worker-list', '--run', run.runId, '--json'])
        .then((o) => orcaResult<{ workers: { dispatchId: string; taskId: string }[] }>(o).workers ?? [])
        .catch(() => []);
      for (const x of work.plan.actions) {
        const a = run.actions[x.id];
        const w = a.state === 'running' && !a.dispatchId ? workers.find((y) => y.taskId === a.taskId) : undefined;
        if (w) {
          a.dispatchId = w.dispatchId;
          changed = true;
        }
      }
    }
    // worker-start interrompido (reinício): o mesmo pedido de novo devolve o resultado da primeira vez.
    for (const x of work.plan.actions) {
      const a = run.actions[x.id];
      if (a.state === 'starting' && a.startRequest && !this.inflight.has(a.startRequest)) void this.startWorker(projectId, cardId, x, a.startRequest);
    }
    changed = (await this.collectQuestions(run)) || changed;
    changed = this.dropClosedQuestions(run) || changed;
    const failed = work.plan.actions.find((x) => run.actions[x.id].state === 'failed');
    if (failed) {
      this.save(projectId, cardId, (w) => ({ ...w, stage: 'blocked', run, error: tr('A ação "{0}" falhou: {1}', [failed.title, run.actions[failed.id].error ?? '']) }), ['running']);
      return;
    }
    if (work.plan.actions.every((x) => run.actions[x.id].state === 'done')) {
      if (changed) this.save(projectId, cardId, (w) => ({ ...w, run }), ['running']);
      const key = `${projectId}|${cardId}`;
      if (!this.busy.has(key)) void this.guard(key, () => this.finish(projectId, cardId));
      return;
    }
    // Tasks prontas: um worker cada, com vaga e cota (a IA sem cota agora dá lugar à equivalente disponível).
    if (work.plan.actions.some((x) => run.actions[x.id].state === 'waiting' && byTask.get(run.actions[x.id].taskId ?? '')?.status === 'ready')) {
      await this.d.refreshAgents?.().catch(() => undefined);
    }
    const all = this.d.agents();
    const quotas = new Map(all.map((q) => [q.agent, q]));
    let planChanged = false;
    const max = this.d.maxWorkers ?? DEFAULT_MAX_WORKERS;
    for (const action of work.plan.actions) {
      const a = run.actions[action.id];
      const t = a.taskId ? byTask.get(a.taskId) : undefined;
      if (a.state !== 'waiting' || t?.status !== 'ready') continue;
      const alt = pickAgent(action, all);
      if (alt && alt !== action.agent) {
        const text = swapNote(action, alt, all);
        this.note(run, text);
        work.plan.notes = [...work.plan.notes, text];
        action.agent = alt;
        planChanged = true;
        changed = true;
      }
      const q = quotas.get(action.agent);
      if (!q?.available) {
        const why = tr('esperando {0} ({1})', [AGENT_NAMES[action.agent], q?.reason ?? tr('indisponível')]);
        if (a.waitingFor !== why) {
          a.waitingFor = why;
          changed = true;
        }
        continue;
      }
      if (this.activeWorkers() >= max) {
        const why = tr('esperando vaga ({0} workers ao mesmo tempo)', [max]);
        if (a.waitingFor !== why) {
          a.waitingFor = why;
          changed = true;
        }
        continue;
      }
      a.state = 'starting';
      a.waitingFor = undefined;
      a.startRequest = randomUUID();
      a.startedAt = this.now();
      this.note(run, tr('Começando "{0}" com {1}.', [action.title, AGENT_NAMES[action.agent]]));
      this.save(projectId, cardId, (w) => ({ ...w, run, ...(planChanged ? { plan: work.plan } : {}) }), ['running']);
      changed = false;
      planChanged = false;
      void this.startWorker(projectId, cardId, action, a.startRequest);
    }
    if (changed) this.save(projectId, cardId, (w) => ({ ...w, run, ...(planChanged ? { plan: work.plan } : {}) }), ['running']);
  }

  private async startWorker(projectId: string, cardId: string, action: PlanAction, requestId: string, retryOf?: string): Promise<void> {
    const work = this.work(projectId, cardId);
    const run = work?.run;
    const a = run?.actions[action.id];
    if (!run?.runId || !run.worktree || !a?.taskId) return;
    if (this.inflight.has(requestId)) return;
    this.inflight.add(requestId);
    const found = await this.d.lookup(projectId, cardId);
    try {
      const from = await this.coordinator(found?.project ?? ({ id: projectId } as BoardProject));
      const r = await this.mutate<{ dispatch?: { id: string }; dispatchId?: string }>(
        [
          'orchestration',
          'worker-start',
          '--from',
          from,
          '--run',
          run.runId,
          '--task',
          a.taskId,
          '--worktree',
          `path:${run.worktree.path}`,
          '--agent',
          action.agent,
          ...(retryOf ? ['--retry-of', retryOf] : []),
          '--timeout-ms',
          String(WORKER_START_TIMEOUT_MS - 10_000),
        ],
        requestId,
        WORKER_START_TIMEOUT_MS,
      );
      const dispatchId = r.dispatch?.id ?? r.dispatchId;
      this.save(
        projectId,
        cardId,
        (w) => {
          const x = w.run!.actions[action.id];
          if (x.startRequest === requestId) Object.assign(x, { state: 'running', dispatchId: dispatchId ?? x.dispatchId });
          return w;
        },
        ['running'],
      );
    } catch (err) {
      const msg = err instanceof CliError ? err.message : errMsg(err);
      this.save(
        projectId,
        cardId,
        (w) => {
          const x = w.run!.actions[action.id];
          if (x.startRequest !== requestId) return w;
          Object.assign(x, { state: 'failed', error: tr('O worker não começou: {0}', [msg]) });
          this.note(w.run!, tr('{0} não começou: {1}', [AGENT_NAMES[action.agent], msg]));
          return { ...w, stage: 'blocked', error: tr('A ação "{0}" não começou: {1}', [action.title, msg]) };
        },
        ['running'],
      );
    } finally {
      this.inflight.delete(requestId);
    }
  }

  /** Perguntas novas dos workers deste Run (as respondidas não voltam). */
  private async collectQuestions(run: CardRun): Promise<boolean> {
    let msgs: OrcaMessage[];
    try {
      const r = orcaResult<{ messages?: OrcaMessage[] } | OrcaMessage[]>(await this.orca(['orchestration', 'inbox', '--limit', '200', '--json']));
      msgs = Array.isArray(r) ? r : (r.messages ?? []);
    } catch {
      return false;
    }
    let changed = false;
    for (const m of msgs) {
      if (m.to_handle !== `run:${run.runId}`) continue;
      if (m.type !== 'question' && m.type !== 'escalation' && m.type !== 'decision_gate') continue;
      if (run.answered.includes(m.id) || run.questions.some((q) => q.id === m.id)) continue;
      const payload = (m.payload ?? {}) as { options?: unknown };
      const options = Array.isArray(payload.options) ? payload.options.filter((o): o is string => typeof o === 'string') : undefined;
      run.questions.push({ id: m.id, text: [m.subject, m.body].filter(Boolean).join('\n').trim() || tr('(pergunta sem texto)'), ...(options?.length ? { options } : {}), from: m.from_handle, at: this.now() });
      this.note(run, tr('Um agente perguntou algo: responda no card.'));
      changed = true;
    }
    return changed;
  }

  /** Perguntas de workers que já terminaram (o Orca fecha a pergunta com o dispatch): saem do card. */
  private dropClosedQuestions(run: CardRun): boolean {
    const ended = new Set(
      Object.values(run.actions)
        .filter((a) => a.dispatchId && (a.state === 'done' || a.state === 'failed' || a.state === 'canceled'))
        .map((a) => `dispatch:${a.dispatchId}`),
    );
    const gone = run.questions.filter((q) => q.from && ended.has(q.from));
    if (!gone.length) return false;
    run.questions = run.questions.filter((q) => !gone.includes(q));
    run.answered.push(...gone.map((q) => q.id));
    this.note(run, tr('Pergunta sem resposta encerrada: o agente seguiu sem ela.'));
    return true;
  }

  // ---- 5: commit, push e PR ----

  private git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
    return this.d.exec(this.d.git ?? 'git', ['-C', cwd, ...args], { timeoutMs });
  }

  private async finish(projectId: string, cardId: string): Promise<void> {
    const found = await this.d.lookup(projectId, cardId);
    const work = this.work(projectId, cardId);
    const run = work?.run;
    if (!found || !work?.plan || !run?.worktree || work.stage !== 'running') return;
    const { project, card } = found;
    const wt = run.worktree.path;
    const branch = stripRef(run.worktree.branch);
    try {
      const status = (await this.git(wt, ['status', '--porcelain'])).trim();
      if (status) {
        await this.git(wt, ['add', '-A']);
        const closing = card.source === 'github' ? `Closes ${card.ref}` : `Refs ${card.ref}`;
        await this.git(wt, ['commit', '-m', `${card.title}\n\n${closing}\n\n${tr('Plano executado pelo Promp IA.')}`]);
        this.note(run, tr('Commit feito no branch {0}.', [branch]));
      }
      const base = await this.baseBranch(project);
      const ahead = Number((await this.git(wt, ['rev-list', '--count', `origin/${base}..HEAD`]).catch(() => '1')).trim()) || 0;
      if (!ahead) {
        this.note(run, tr('As ações terminaram sem mudar arquivos: nada para o PR.'));
      } else {
        await this.git(wt, ['push', '-u', 'origin', 'HEAD'], 120_000);
        this.note(run, tr('Push do branch {0}.', [branch]));
        if (project.github && this.d.gh) {
          run.pr = await this.openPr(project, card, branch, base, work);
          this.note(run, tr('PR aberto: {0}', [run.pr.url]));
          if (card.source === 'linear') {
            await this.orca(['linear', 'attach', card.ref, '--url', run.pr.url, '--title', `PR: ${card.title}`.slice(0, 120), '--json']).catch(() => undefined);
          }
        }
      }
      await this.releaseWorkers(run);
      run.finishedAt = this.now();
      this.save(projectId, cardId, (w) => ({ ...w, stage: 'review', run, error: undefined }), ['running']);
    } catch (err) {
      const msg = err instanceof CliError ? err.message : errMsg(err);
      this.note(run, tr('Finalização falhou: {0}', [msg]));
      this.save(projectId, cardId, (w) => ({ ...w, stage: 'blocked', run, error: tr('As ações terminaram, mas o commit/PR falhou: {0}', [msg]) }), ['running']);
    }
  }

  /** Branch padrão do origin ("main"). */
  private async baseBranch(project: BoardProject): Promise<string> {
    const ref = (await this.git(project.path!, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).trim();
    return ref.replace(/^origin\//, '') || 'main';
  }

  private async openPr(project: BoardProject, card: BoardCard, branch: string, base: string, work: CardWork): Promise<{ url: string; number?: number }> {
    const existing = await this.d
      .exec(this.d.gh!, ['pr', 'view', branch, '--repo', project.github!, '--json', 'url,number'])
      .then((o) => JSON.parse(o) as { url: string; number: number })
      .catch(() => undefined);
    if (existing?.url) return existing;
    const lines = [
      card.source === 'github' ? `Closes ${card.ref}` : `Linear: ${card.ref} (${card.url})`,
      '',
      work.plan!.summary,
      '',
      ...work.plan!.actions.map((a, i) => {
        const r = work.run!.actions[a.id];
        return `${i + 1}. **${a.title}** · ${AGENT_NAMES[a.agent]}${r?.result ? ` — ${r.result.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
      }),
      '',
      tr('_PR aberto pelo Promp IA._'),
    ];
    const out = await this.d.exec(this.d.gh!, ['pr', 'create', '--repo', project.github!, '--head', branch, '--base', base, '--title', card.title, '--body', lines.join('\n')], { timeoutMs: 60_000 });
    const url = out.trim().split('\n').pop()!.trim();
    const n = /\/pull\/(\d+)/.exec(url)?.[1];
    return { url, ...(n ? { number: Number(n) } : {}) };
  }

  private async releaseWorkers(run: CardRun): Promise<void> {
    for (const a of Object.values(run.actions)) {
      if (!a.dispatchId) continue;
      await this.orca(['orchestration', 'worker-release', '--dispatch', a.dispatchId, '--json']).catch(() => undefined);
    }
  }

  // ---- revisão ----

  private async checkReview(projectId: string, cardId: string): Promise<void> {
    const key = `${projectId}|${cardId}`;
    if (this.now() - (this.lastReviewCheck.get(key) ?? 0) < REVIEW_CHECK_MS) return;
    this.lastReviewCheck.set(key, this.now());
    const work = this.work(projectId, cardId);
    const found = await this.d.lookup(projectId, cardId);
    if (!work?.run?.pr || !found?.project.github || !this.d.gh) return;
    const pr = JSON.parse(await this.d.exec(this.d.gh, ['pr', 'view', work.run.pr.url, '--json', 'state'])) as { state: string };
    if (pr.state === 'MERGED') {
      this.save(projectId, cardId, (w) => {
        this.note(w.run!, tr('PR aceito.'));
        return { ...w, stage: 'done' };
      }, ['review']);
    }
  }

  // ---- 6: merge pelo quadro ----

  /** Aprova o PR do card: merge no GitHub, limpeza do branch e do worktree, repositório local atualizado. */
  async merge(projectId: string, cardId: string, afterMerge?: string): Promise<string | undefined> {
    const key = `${projectId}|${cardId}`;
    const work = this.work(projectId, cardId);
    const run = work?.run;
    if (work?.stage !== 'review' || !run?.pr) return tr('Este card não tem PR esperando revisão.');
    if (this.busy.has(key)) return tr('O merge deste card já está em andamento.');
    const found = await this.d.lookup(projectId, cardId);
    if (!found?.project.github || !this.d.gh) return tr('O merge pelo quadro precisa do GitHub (gh) no projeto.');
    const { project, card } = found;
    const command = afterMerge?.trim();
    if (afterMerge !== undefined) this.d.saveAfterMerge?.(projectId, command ?? '');
    this.busy.add(key);
    try {
      const pr = JSON.parse(await this.d.exec(this.d.gh, ['pr', 'view', run.pr.url, '--json', 'state,mergeable,baseRefName,headRefName'])) as {
        state: string;
        mergeable?: string;
        baseRefName?: string;
        headRefName?: string;
      };
      if (pr.state === 'CLOSED') return tr('O PR foi fechado sem merge no GitHub.');
      if (pr.state === 'OPEN') {
        if (pr.mergeable === 'CONFLICTING') return tr('O PR tem conflitos com {0}: resolva no GitHub e tente de novo.', [pr.baseRefName ?? 'main']);
        const method = this.d.mergeMethod ?? 'squash';
        // Fora de qualquer repositório: o gh não mexe em branch local nenhum (o do card está no worktree).
        await this.d.exec(this.d.gh, ['pr', 'merge', run.pr.url, `--${method}`], { timeoutMs: 120_000, cwd: tmpdir() });
      }
      const base = pr.baseRefName || (await this.baseBranch(project));
      const branch = pr.headRefName || (run.worktree ? stripRef(run.worktree.branch) : '');
      this.save(projectId, cardId, (w) => {
        this.note(w.run!, pr.state === 'MERGED' ? tr('O PR já estava com merge no GitHub.') : tr('Merge do PR feito em {0}.', [base]));
        w.run!.merged = { at: this.now() };
        return { ...w, stage: 'done', error: undefined };
      }, ['review']);
      void this.afterMerge(projectId, cardId, project, card, base, branch, command);
      return undefined;
    } catch (err) {
      return tr('O GitHub não aceitou o merge: {0}', [err instanceof CliError ? err.message : errMsg(err)]);
    } finally {
      this.busy.delete(key);
    }
  }

  /** Depois do merge: limpeza, repositório local e o comando do projeto. Cada passo que falha só vira nota. */
  private async afterMerge(projectId: string, cardId: string, project: BoardProject, card: BoardCard, base: string, branch: string, command?: string): Promise<void> {
    const notes: string[] = [];
    const run = this.work(projectId, cardId)?.run;
    if (branch && project.github) {
      await this.d
        .exec(this.d.gh!, ['api', '-X', 'DELETE', `repos/${project.github}/git/refs/heads/${branch}`])
        .then(() => notes.push(tr('Branch {0} apagado no GitHub.', [branch])))
        .catch(() => undefined);
    }
    if (run?.worktree) {
      await this.orca(['worktree', 'rm', '--worktree', `path:${run.worktree.path}`, '--json'])
        .then((o) => orcaResult(o))
        .then(() => notes.push(tr('Worktree do card removido.')))
        .catch((err) => notes.push(tr('O worktree ficou ({0}).', [err instanceof CliError ? err.message : errMsg(err)])));
      if (branch && project.path) await this.git(project.path, ['branch', '-D', branch]).catch(() => undefined);
    }
    if (card.source === 'linear') {
      await this.orca(['linear', 'status', 'set', card.ref, '--to', 'Done', '--json'])
        .then((o) => orcaResult(o))
        .then(() => notes.push(tr('Issue {0} marcada como Done no Linear.', [card.ref])))
        .catch(() => undefined);
    }
    const updated = project.path ? await this.updateLocal(project.path, base, notes) : false;
    this.save(projectId, cardId, (w) => {
      for (const n of notes) this.note(w.run!, n);
      if (command && updated) w.run!.merged = { ...w.run!.merged!, update: { command, state: 'running', at: this.now() } };
      return w;
    });
    if (!command || !project.path) return;
    if (!updated) {
      this.save(projectId, cardId, (w) => {
        this.note(w.run!, tr('O comando de depois do merge não rodou: o repositório local não foi atualizado.'));
        return w;
      });
      return;
    }
    const res = await (this.d.shell ?? runShell)(command, { cwd: project.path, timeoutMs: AFTER_MERGE_TIMEOUT_MS });
    this.save(projectId, cardId, (w) => {
      w.run!.merged = { ...w.run!.merged!, update: { command, state: res.ok ? 'done' : 'failed', output: res.output, at: this.now() } };
      this.note(w.run!, res.ok ? tr('Sistema do projeto atualizado ({0}).', [command]) : tr('O comando de depois do merge falhou ({0}).', [command]));
      return w;
    });
  }

  /** Traz o merge para a pasta do projeto: fast-forward do branch base, só se é o branch atual e não há mudanças. */
  private async updateLocal(path: string, base: string, notes: string[]): Promise<boolean> {
    try {
      await this.git(path, ['fetch', 'origin', base], 120_000);
      const current = (await this.git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      if (current !== base) {
        notes.push(tr('Repositório local não atualizado: está no branch {0}, não em {1}.', [current, base]));
        return false;
      }
      if ((await this.git(path, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
        notes.push(tr('Repositório local não atualizado: tem mudanças não salvas em {0}.', [path]));
        return false;
      }
      await this.git(path, ['merge', '--ff-only', `origin/${base}`]);
      notes.push(tr('Repositório local atualizado ({0}).', [base]));
      return true;
    } catch (err) {
      notes.push(tr('Repositório local não atualizado: {0}', [err instanceof CliError ? err.message : errMsg(err)]));
      return false;
    }
  }

  // ---- ações da página ----

  /** Responde uma pergunta de um worker. */
  async answer(projectId: string, cardId: string, questionId: string, text: string): Promise<string | undefined> {
    const work = this.work(projectId, cardId);
    const run = work?.run;
    const q = run?.questions.find((x) => x.id === questionId);
    if (!run?.runId || !q) return tr('Pergunta desconhecida (talvez já respondida).');
    const found = await this.d.lookup(projectId, cardId);
    try {
      const from = await this.coordinator(found?.project ?? ({ id: projectId } as BoardProject));
      await this.mutate(['orchestration', 'reply', '--from', from, '--run', run.runId, '--id', questionId, '--body', text], randomUUID());
    } catch (err) {
      const msg = err instanceof CliError ? err.message : errMsg(err);
      // O worker já terminou (seguiu sem a resposta): a pergunta sai do card em vez de ficar presa.
      if (/closed|inactive/i.test(msg)) {
        this.expireQuestions(projectId, cardId, questionId);
        return tr('O agente já terminou e seguiu sem esta resposta; veja o resultado das ações.');
      }
      return tr('O Orca não aceitou a resposta: {0}', [msg]);
    }
    this.save(projectId, cardId, (w) => {
      const r = w.run!;
      r.questions = r.questions.filter((x) => x.id !== questionId);
      r.answered.push(questionId);
      this.note(r, tr('Você respondeu: {0}', [text.slice(0, 120)]));
      return w;
    });
    return undefined;
  }

  /** Tira do card perguntas que não têm mais quem as receba (todas, ou só `questionId`). */
  private expireQuestions(projectId: string, cardId: string, questionId?: string): void {
    this.save(projectId, cardId, (w) => {
      const r = w.run!;
      const gone = r.questions.filter((q) => !questionId || q.id === questionId);
      if (!gone.length) return w;
      r.questions = r.questions.filter((q) => !gone.includes(q));
      r.answered.push(...gone.map((q) => q.id));
      this.note(r, tr('Pergunta sem resposta encerrada: o agente seguiu sem ela.'));
      return w;
    });
  }

  /** Tenta de novo as ações que falharam (ou a finalização). */
  async retry(projectId: string, cardId: string): Promise<string | undefined> {
    const work = this.work(projectId, cardId);
    if (work?.stage !== 'blocked' || !work.plan) return tr('Este card não está travado.');
    if (!work.run?.runId) {
      // Travou na preparação: recomeça por ela (o que já foi feito é reaproveitado).
      this.save(projectId, cardId, (w) => ({ ...w, stage: 'queued', error: undefined }), ['blocked']);
      void this.tick();
      return undefined;
    }
    const retries: { action: PlanAction; requestId: string; retryOf?: string }[] = [];
    // A falha pode ter sido a cota: quem tenta de novo é uma IA disponível agora (a equivalente, se precisar).
    await this.d.refreshAgents?.().catch(() => undefined);
    const quotas = this.d.agents();
    this.save(
      projectId,
      cardId,
      (w) => {
        for (const action of w.plan!.actions) {
          const a = w.run!.actions[action.id];
          if (a.state !== 'failed') continue;
          const alt = pickAgent(action, quotas);
          if (alt && alt !== action.agent) {
            const text = swapNote(action, alt, quotas);
            this.note(w.run!, text);
            w.plan!.notes = [...w.plan!.notes, text];
            action.agent = alt;
          }
          const retryOf = a.dispatchId;
          Object.assign(a, { state: 'starting', error: undefined, startRequest: randomUUID(), startedAt: this.now() });
          retries.push({ action, requestId: a.startRequest!, retryOf });
        }
        this.note(w.run!, tr('Tentando de novo.'));
        return { ...w, stage: 'running', error: undefined };
      },
      ['blocked'],
    );
    for (const r of retries) {
      if (r.retryOf) void this.startWorker(projectId, cardId, r.action, r.requestId, r.retryOf);
      else {
        // Nunca começou: volta a esperar a vez.
        this.save(projectId, cardId, (w) => {
          Object.assign(w.run!.actions[r.action.id], { state: 'waiting', startRequest: undefined });
          return w;
        });
      }
    }
    void this.tick();
    return undefined;
  }

  /** Cancela a execução: para os workers e marca as tasks como canceladas. O worktree fica (nada se perde). */
  async cancel(projectId: string, cardId: string): Promise<void> {
    const work = this.work(projectId, cardId);
    const run = work?.run;
    if (run?.runId) {
      const found = await this.d.lookup(projectId, cardId);
      const from = await this.coordinator(found?.project ?? ({ id: projectId } as BoardProject)).catch(() => undefined);
      for (const a of Object.values(run.actions)) {
        if (a.dispatchId && (a.state === 'starting' || a.state === 'running')) {
          await this.orca(['orchestration', 'worker-stop', '--dispatch', a.dispatchId, '--json']).catch(() => undefined);
        }
        if (a.taskId && a.state !== 'done' && from) {
          await this.orca(['orchestration', 'task-update', '--from', from, '--run', run.runId, '--id', a.taskId, '--status', 'failed', '--result', 'cancelled', '--json']).catch(() => undefined);
        }
      }
      if (run.worktree) log.info(`Quadro: execução de ${cardId} cancelada; o worktree fica em ${run.worktree.path}.`);
    }
    this.d.store.setWork(projectId, cardId, undefined);
    this.d.onChange?.();
  }
}
