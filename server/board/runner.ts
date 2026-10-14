// Execução dos cards aprovados pelos agentes do Orca (orquestração do Orca: Run, Tasks e workers).
//
// Por card aprovado (estágio "queued"):
//   1. terminal coordenador do projeto (um por projeto, "Promp IA · coordenador"): as mutações da orquestração
//      exigem `--from <handle>` de um terminal vivo do Orca (o servidor não roda dentro de um);
//   2. `orchestration run-create` (um Run por card) e `worktree create` (cópia do repositório só do card, ligada à
//      issue, sem setup);
//   3. uma Task por ação do plano (`task-create`, com as dependências);
//   4. estágio "running": a cada rodada, `task-list` diz o que está pronto; cada Task pronta ganha um worker
//      (`worker-start --task … --agent <IA> --worktree path:<worktree>`), respeitando o limite de workers ao mesmo
//      tempo e a cota da IA; perguntas dos workers (`orchestration inbox`, tipo question/escalation) aparecem no card e
//      a resposta vai por `orchestration reply`;
//   5. todas as Tasks concluídas: commit, push e PR (`gh pr create`, "Closes #N"; no Linear, o PR é anexado à issue),
//      os workers são liberados e o card vai para Revisão. PR aceito = Concluído.
// Task que falha deixa o card travado ("blocked"): tentar de novo (`worker-start --retry-of`) ou cancelar.
//
// A CLI do Orca às vezes responde erro mesmo tendo feito a ação ("runtime_unavailable"): toda mutação da orquestração
// leva um `--retry-request` gravado antes (repetir devolve o resultado da primeira vez), e o worktree é procurado
// pelo nome antes de criar de novo. O estado fica em board.json: depois de reiniciar, a rodada continua de onde parou.
import { randomUUID } from 'node:crypto';
import type { ActionRun, BoardCard, BoardProject, CardRun, CardWork, PlanAction } from '../../shared/board';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { AGENT_NAMES } from './agents';
import type { AgentQuota } from '../../shared/board';
import { CliError, orcaResult, type Exec } from './cli';
import type { BoardStore } from './store';

export const TICK_MS = 8_000;
export const REVIEW_CHECK_MS = 5 * 60_000;
export const DEFAULT_MAX_WORKERS = 3;
export const WORKER_START_TIMEOUT_MS = 5 * 60_000;
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
  maxWorkers?: number;
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

/** Instruções da Task: a ação, o contexto do card e as regras do trabalho no worktree compartilhado. */
export function taskSpec(project: BoardProject, card: BoardCard, action: PlanAction, index: number, total: number, worktree: { path: string; branch: string }): string {
  return [
    `Card ${card.ref} do projeto "${project.name}": ${card.title}`,
    `Ação ${index + 1} de ${total}: ${action.title}`,
    '',
    action.instructions,
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
            taskSpec(project, card, action, i, plan.actions.length, { path: run.worktree.path, branch: stripRef(run.worktree.branch) }),
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
    // Tasks prontas: um worker cada, com vaga e cota.
    const quotas = new Map(this.d.agents().map((q) => [q.agent, q]));
    const max = this.d.maxWorkers ?? DEFAULT_MAX_WORKERS;
    for (const action of work.plan.actions) {
      const a = run.actions[action.id];
      const t = a.taskId ? byTask.get(a.taskId) : undefined;
      if (a.state !== 'waiting' || t?.status !== 'ready') continue;
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
      this.save(projectId, cardId, (w) => ({ ...w, run }), ['running']);
      changed = false;
      void this.startWorker(projectId, cardId, action, a.startRequest);
    }
    if (changed) this.save(projectId, cardId, (w) => ({ ...w, run }), ['running']);
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
      return tr('O Orca não aceitou a resposta: {0}', [err instanceof CliError ? err.message : errMsg(err)]);
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
    this.save(
      projectId,
      cardId,
      (w) => {
        for (const action of w.plan!.actions) {
          const a = w.run!.actions[action.id];
          if (a.state !== 'failed') continue;
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
