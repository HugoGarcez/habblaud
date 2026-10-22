// Quadro de tarefas (botão "Tarefas" da barra superior; atalho K; botão do quadro na sala): o kanban dos projetos do
// Orca, com as issues do GitHub ou do Linear nas colunas Backlog → Planejando → Aguardando aprovação → Em execução →
// Revisão → Concluído. Sem filtro, mostra os cards de TODOS os projetos e de todos os times do Linear
// (GET /api/board/all); escolher um projeto filtra (GET /api/board/projects/:id) e deixa trocar a fonte dele.
// Filtrar por texto, abrir o detalhe do card (ui/board-detail.ts: planejar, aprovar, acompanhar a execução) e criar
// cards novos (ui/board-new.ts). Relido a cada 30 s com a janela aberta (mais rápido com card planejando ou rodando).
import type { AgentQuota, BoardAllView, BoardCard, BoardIndex, BoardProject, BoardSource, BoardView, CardDetails, CardEdit, CardStage, MergeRequest, NewCard, PlanEdit, PlanRequest } from '../../../shared/board';
import { tr } from '../../../shared/i18n';
import { cardKey, columnLabel, groupCards, kindLabel, matchesFilter, projectForPath } from './board-model';
import { CardDetail } from './board-detail';
import { NewCardForm, type CardTarget } from './board-new';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { ago } from './spawn';

const REFRESH_MS = 30_000;
/** Com algum card planejando, relê mais rápido (o plano aparece logo que chega). */
const PLANNING_REFRESH_MS = 4_000;
/** Com algum card em execução. */
const RUNNING_REFRESH_MS = 8_000;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error || tr('O servidor respondeu {0}.', [res.status]));
  return body as T;
}

function stageLabel(s: CardStage): string {
  switch (s) {
    case 'planning':
      return tr('Planejando…');
    case 'approval':
      return tr('Plano pronto');
    case 'queued':
      return tr('Na fila');
    case 'running':
      return tr('Rodando');
    case 'blocked':
      return tr('Travado');
    case 'review':
      return tr('PR aberto');
    case 'done':
      return tr('Concluído');
    case 'failed':
      return tr('Falhou');
  }
}

/** O que está na tela: um projeto (com a fonte dele) ou todos. */
interface Shown {
  cards: BoardCard[];
  agents: AgentQuota[];
  fetchedAt: number;
  /** Só com um projeto. */
  project?: BoardProject;
  error?: string;
  /** Só com todos: fontes que não responderam. */
  errors?: { name: string; error: string }[];
}

/** Para onde vão os cards de um projeto ("GitHub · dono/repo"); undefined = sem fonte utilizável. */
function destinationOf(p: BoardProject): string | undefined {
  if (p.source === 'github' && p.github) return `GitHub · ${p.github}`;
  if (p.source === 'linear' && p.linearTeam) return `Linear · ${p.linearTeam}`;
  return undefined;
}

export class BoardPanel {
  readonly el: HTMLDialogElement;
  private readonly projectSel: HTMLSelectElement;
  private readonly sourceSel: HTMLSelectElement;
  private readonly teamSel: HTMLSelectElement;
  private readonly filter: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly retry: HTMLButtonElement;
  private readonly columns: HTMLElement;
  private readonly newBtn: HTMLButtonElement;
  private readonly form: NewCardForm;
  private readonly detail: CardDetail;
  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Card recém-criado (destacado até a próxima troca de projeto). */
  private fresh: string | null = null;
  private index: BoardIndex | null = null;
  private view: Shown | null = null;
  /** Projeto filtrado; null = todos. */
  private projectId: string | null = null;
  private wanted: string | null = null;
  /** Card a abrir quando os dados chegarem (aviso clicado). */
  private wantedCard: string | null = null;
  /** Pasta da sala: abre no projeto dela quando a lista de projetos chegar. */
  private wantedPath: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loadSeq = 0;
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly button: HTMLElement,
  ) {
    this.projectSel = h('select', { class: 'ui-day__select ui-board__project', attrs: { 'aria-label': tr('Projeto do Orca') }, on: { change: () => this.pick(this.projectSel.value || null) } });
    this.sourceSel = h(
      'select',
      { class: 'ui-day__select ui-board__source', attrs: { 'aria-label': tr('De onde vêm as tarefas') }, on: { change: () => void this.saveSource() } },
      h('option', { text: tr('Sem fonte'), attrs: { value: '' } }),
      h('option', { text: 'GitHub Issues', attrs: { value: 'github' } }),
      h('option', { text: 'Linear', attrs: { value: 'linear' } }),
    );
    this.teamSel = h('select', { class: 'ui-day__select ui-board__team', hidden: true, attrs: { 'aria-label': tr('Time do Linear') }, on: { change: () => void this.saveSource() } });
    this.filter = h('input', {
      class: 'ui-board__filter',
      type: 'search',
      attrs: { placeholder: tr('Filtrar cards'), 'aria-label': tr('Filtrar cards') },
      on: { input: () => this.renderCards() },
    });
    const refresh = iconButton(ICONS.clock, tr('Atualizar agora'), () => void this.load(true), 'ui-icon-btn--sm');
    const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.statusText = h('span', {});
    this.retry = h('button', { class: 'ui-link-btn', type: 'button', text: tr('Tentar de novo'), hidden: true, on: { click: () => void this.load(true) } });
    this.status = h('p', { class: 'ui-board__status', attrs: { 'aria-live': 'polite' } }, this.statusText, ' ', this.retry);
    this.columns = h('div', { class: 'ui-board__columns' });
    this.form = new NewCardForm({ submit: (card, projectId) => this.createCard(card, projectId) });
    this.detail = new CardDetail({
      plan: (c) => this.cardAction(c, 'plan', 'POST'),
      approve: async (c, edit) => (edit ? ((await this.cardAction(c, 'plan', 'PUT', edit)) ?? this.cardAction(c, 'approve', 'POST')) : this.cardAction(c, 'approve', 'POST')),
      discard: (c) => this.cardAction(c, 'discard', 'POST'),
      retry: (c) => this.cardAction(c, 'retry', 'POST'),
      answer: (c, questionId, text) => this.cardAction(c, 'answer', 'POST', { questionId, text }),
      merge: (c, afterMerge) => this.mergeCard(c, afterMerge),
      afterMerge: (c) => this.index?.projects.find((p) => p.id === (c.projectId ?? this.projectId))?.afterMerge ?? '',
      revise: async (c, feedback, edit, images) => {
        const req: PlanRequest = images.length ? { feedback, images } : { feedback };
        return edit ? ((await this.cardAction(c, 'plan', 'PUT', edit)) ?? this.cardAction(c, 'plan', 'POST', req)) : this.cardAction(c, 'plan', 'POST', req);
      },
      attachmentUrl: (c, a) => {
        const url = this.cardUrl(c);
        return url ? `${url}/attachments/${encodeURIComponent(a.id)}` : undefined;
      },
      details: (c) => this.cardDetails(c),
      edit: (c, edit) => this.editCard(c, edit),
      close: () => this.closeDetail(),
    });
    this.newBtn = h('button', { class: 'ui-btn ui-board__new', type: 'button', text: tr('+ Novo card'), on: { click: () => this.toggleForm() } });

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-board', attrs: { 'aria-labelledby': 'ui-board-title' } },
      h(
        'div',
        { class: 'ui-dialog__head ui-board__head' },
        h('h2', { text: tr('Tarefas'), attrs: { id: 'ui-board-title' } }),
        h('div', { class: 'ui-board__controls' }, this.projectSel, this.sourceSel, this.teamSel, this.filter, refresh, this.newBtn),
        close,
      ),
      h('div', { class: 'ui-board__main' }, h('div', { class: 'ui-board__body' }, this.form.el, this.status, this.columns), this.detail.el),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => this.onClosed());
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /**
   * Abre em todos os projetos ou no projeto pedido (ex.: o da sala). `cardId` abre também o detalhe desse card (um
   * aviso clicado).
   */
  open(projectId?: string, cardId?: string): void {
    this.wanted = projectId ?? null;
    this.wantedCard = cardId ?? null;
    this.projectId = this.wanted;
    this.view = null;
    this.closeDetail();
    if (!this.el.open) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el.showModal();
      this.button.setAttribute('aria-expanded', 'true');
      this.timer = setInterval(() => void this.load(false), REFRESH_MS);
    }
    this.renderCards();
    void this.load(false, true);
  }

  /** Abre no projeto da pasta (a sala); sem projeto para ela, em todos. */
  openForPath(path: string): void {
    this.open();
    this.wantedPath = path;
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  private onClosed(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.fastTimer) clearTimeout(this.fastTimer);
    this.fastTimer = null;
    this.closeDetail();
    this.button.setAttribute('aria-expanded', 'false');
    this.opener?.focus();
  }

  private pick(id: string | null): void {
    this.projectId = id;
    this.fresh = null;
    this.form.close();
    this.closeDetail();
    this.view = null;
    this.renderControls();
    this.renderCards();
    void this.load(false);
  }

  /** `withIndex`: relê também a lista de projetos (ao abrir). */
  private async load(refresh: boolean, withIndex = false): Promise<void> {
    const seq = ++this.loadSeq;
    if (!this.view) this.setStatus(tr('Carregando…'));
    try {
      if (withIndex || !this.index) {
        this.index = await api<BoardIndex>('/api/board');
        if (seq !== this.loadSeq) return;
        if (this.wantedPath) {
          this.projectId = projectForPath(this.index.projects, this.wantedPath)?.id ?? null;
          this.wantedPath = null;
        }
        if (this.projectId && !this.index.projects.some((p) => p.id === this.projectId)) this.projectId = null;
        this.renderControls();
      }
      const q = refresh ? '?refresh=1' : '';
      let shown: Shown;
      if (this.projectId) {
        const v = await api<BoardView>(`/api/board/projects/${encodeURIComponent(this.projectId)}${q}`);
        shown = { cards: v.cards, agents: v.agents, fetchedAt: v.fetchedAt, project: v.project, ...(v.error ? { error: v.error } : {}) };
        this.mergeProject(v.project);
      } else {
        const v = await api<BoardAllView>(`/api/board/all${q}`);
        shown = { cards: v.cards, agents: v.agents, fetchedAt: v.fetchedAt, errors: v.errors };
        if (this.index) this.index.projects = v.projects;
      }
      if (seq !== this.loadSeq) return;
      this.view = shown;
      this.renderControls();
      this.renderCards();
      this.syncDetail();
      this.scheduleFast();
      this.renderStatus();
      if (this.wantedCard) {
        const key = this.wantedCard;
        this.wantedCard = null;
        const card = shown.cards.find((c) => c.id === key || cardKey(c) === key);
        if (card) this.openDetail(cardKey(card));
      }
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  private renderStatus(): void {
    const v = this.view;
    if (!v) return;
    if (v.error) return this.setStatus(v.error, true);
    const when = ago(v.fetchedAt, this.ctx.now()) || tr('agora');
    let text = v.cards.length === 1 ? tr('1 card · atualizado {0}', [when]) : tr('{0} cards · atualizado {1}', [v.cards.length, when]);
    if (!this.projectId) text = `${tr('Todos os projetos')} · ${text}`;
    const errs = v.errors ?? [];
    if (errs.length) text += ` · ${tr('sem resposta: {0}', [errs.map((e) => e.name).join(', ')])}`;
    this.setStatus(text, false);
    this.status.title = errs.map((e) => `${e.name}: ${e.error}`).join('\n');
  }

  private openDetail(key: string): void {
    const card = this.view?.cards.find((c) => cardKey(c) === key);
    if (!card) return;
    this.form.close();
    this.detail.show(card, this.view?.agents ?? []);
    this.el.classList.add('has-detail');
    this.renderCards();
    (this.detail.el.querySelector('button, a, select, textarea, input') as HTMLElement | null)?.focus();
  }

  private closeDetail(): void {
    if (!this.detail.isOpen) return;
    const key = this.detail.cardId;
    this.detail.hide();
    this.el.classList.remove('has-detail');
    this.renderCards();
    if (key) (this.columns.querySelector(`[data-card="${CSS.escape(key)}"]`) as HTMLElement | null)?.focus();
  }

  /** Card aberto no detalhe com os dados novos (ou fecha, se ele sumiu da lista). */
  private syncDetail(): void {
    const key = this.detail.cardId;
    if (!key) return;
    const card = this.view?.cards.find((c) => cardKey(c) === key);
    if (card) this.detail.show(card, this.view?.agents ?? []);
    else this.closeDetail();
  }

  private scheduleFast(): void {
    if (this.fastTimer) clearTimeout(this.fastTimer);
    this.fastTimer = null;
    const stages = new Set(this.view?.cards.map((c) => c.work?.stage));
    if (!this.el.open) return;
    if (stages.has('planning')) this.fastTimer = setTimeout(() => void this.load(false), PLANNING_REFRESH_MS);
    else if (stages.has('queued') || stages.has('running') || this.view?.cards.some((c) => c.work?.run?.merged?.update?.state === 'running')) this.fastTimer = setTimeout(() => void this.load(false), RUNNING_REFRESH_MS);
  }

  /** Planejar, editar, aprovar, descartar, tentar de novo, responder: devolve o erro, ou undefined. */
  /** Merge do PR; o comando de depois do merge fica no projeto (e na lista local, para o próximo card). */
  private async mergeCard(card: BoardCard, afterMerge: string): Promise<string | undefined> {
    const err = await this.cardAction(card, 'merge', 'POST', { afterMerge });
    if (err) return err;
    const pid = card.projectId ?? this.projectId;
    if (this.index) this.index.projects = this.index.projects.map((p) => (p.id === pid ? { ...p, afterMerge: afterMerge || undefined } : p));
    this.ctx.announce(tr('Merge feito: {0}', [card.ref]));
    return undefined;
  }

  private async cardAction(card: BoardCard, verb: 'plan' | 'approve' | 'discard' | 'retry' | 'answer' | 'merge', method: 'POST' | 'PUT', body?: PlanEdit | { questionId: string; text: string } | PlanRequest | MergeRequest): Promise<string | undefined> {
    const projectId = card.projectId ?? this.projectId;
    if (!projectId) return tr('Este card não está ligado a um projeto do Orca.');
    try {
      const updated = await api<BoardCard>(`/api/board/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(card.id)}/${verb}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const merged: BoardCard = { ...updated, projectId, projectName: card.projectName };
      if (this.view) {
        this.view = { ...this.view, cards: this.view.cards.map((c) => (cardKey(c) === cardKey(merged) ? merged : c)) };
        this.renderCards();
        this.syncDetail();
        this.scheduleFast();
      }
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private cardUrl(card: BoardCard): string | undefined {
    const projectId = card.projectId ?? this.projectId;
    return projectId ? `/api/board/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(card.id)}` : undefined;
  }

  private async cardDetails(card: BoardCard): Promise<CardDetails | string> {
    const url = this.cardUrl(card);
    if (!url) return tr('Este card não está ligado a um projeto do Orca.');
    try {
      return await api<CardDetails>(`${url}/details`);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async editCard(card: BoardCard, edit: CardEdit): Promise<string | undefined> {
    const url = this.cardUrl(card);
    if (!url) return tr('Este card não está ligado a um projeto do Orca.');
    try {
      const updated = await api<BoardCard>(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit) });
      const merged: BoardCard = { ...updated, projectId: card.projectId ?? this.projectId ?? undefined, projectName: card.projectName };
      if (this.view) {
        this.view = { ...this.view, cards: this.view.cards.map((c) => (cardKey(c) === cardKey(merged) ? merged : c)) };
        this.renderCards();
        this.syncDetail();
      }
      this.ctx.announce(tr('Card {0} atualizado.', [card.ref]));
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Projetos que podem receber um card novo (com fonte funcionando). */
  private targets(): CardTarget[] {
    const projects = (this.index?.projects ?? []).filter((p) => (this.projectId ? p.id === this.projectId : true));
    if (this.projectId && this.view?.error) return [];
    return projects.flatMap((p) => {
      const where = destinationOf(p);
      return where ? [{ id: p.id, label: this.projectId ? where : `${p.name} · ${where}` }] : [];
    });
  }

  private toggleForm(): void {
    if (this.form.isOpen) return this.form.close();
    const targets = this.targets();
    if (targets.length) this.form.open(targets, this.projectId ?? undefined);
  }

  private async createCard(card: NewCard, projectId: string): Promise<string | undefined> {
    try {
      const created = await api<BoardCard>(`/api/board/projects/${encodeURIComponent(projectId)}/cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
      });
      const project = this.index?.projects.find((p) => p.id === projectId);
      const withProject: BoardCard = { ...created, projectId, projectName: project?.name };
      if (this.view && (!this.projectId || this.projectId === projectId)) {
        this.view = { ...this.view, cards: [withProject, ...this.view.cards.filter((c) => cardKey(c) !== cardKey(withProject))] };
        this.fresh = cardKey(withProject);
        this.filter.value = '';
        this.renderCards();
      }
      this.setStatus(tr('Card {0} criado.', [created.ref]));
      this.ctx.announce(tr('Card {0} criado.', [created.ref]));
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  private async saveSource(): Promise<void> {
    if (!this.projectId) return;
    const source = (this.sourceSel.value || null) as BoardSource | null;
    const team = this.teamSel.value || this.index?.linearTeams[0]?.key;
    setHidden(this.teamSel, source !== 'linear');
    if (source === 'linear' && !team) return this.setStatus(tr('O Linear não está conectado no Orca.'), true);
    try {
      const project = await api<BoardProject>(`/api/board/projects/${encodeURIComponent(this.projectId)}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source === 'linear' ? { source, linearTeam: team } : { source }),
      });
      this.mergeProject(project);
      this.renderControls();
      await this.load(true);
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err), true);
    }
  }

  private mergeProject(p: BoardProject): void {
    if (!this.index) return;
    this.index.projects = this.index.projects.map((x) => (x.id === p.id ? p : x));
  }

  private renderControls(): void {
    const projects = this.index?.projects ?? [];
    this.projectSel.replaceChildren(
      h('option', { text: tr('Todos os projetos'), attrs: { value: '' } }),
      ...projects.map((p) => h('option', { text: p.github ? `${p.name} · ${p.github}` : p.name, attrs: { value: p.id } })),
    );
    this.projectSel.value = this.projectId ?? '';
    const project = projects.find((p) => p.id === this.projectId);
    this.sourceSel.value = project?.source ?? '';
    setHidden(this.sourceSel, !project);
    const linearOpt = this.sourceSel.querySelector<HTMLOptionElement>('option[value="linear"]');
    if (linearOpt) linearOpt.disabled = !this.index?.linear;
    const ghOpt = this.sourceSel.querySelector<HTMLOptionElement>('option[value="github"]');
    if (ghOpt) ghOpt.disabled = !project?.github;
    const teams = this.index?.linearTeams ?? [];
    this.teamSel.replaceChildren(...teams.map((t) => h('option', { text: `${t.name} (${t.key})`, attrs: { value: t.key } })));
    if (project?.linearTeam) this.teamSel.value = project.linearTeam;
    setHidden(this.teamSel, project?.source !== 'linear' || teams.length < 2);
    this.renderNewButton();
  }

  private renderNewButton(): void {
    const targets = this.targets();
    this.newBtn.disabled = !targets.length;
    this.newBtn.title = targets.length ? tr('Cria uma issue no projeto escolhido') : tr('Escolha uma fonte que esteja funcionando para criar cards');
    if (!targets.length) this.form.close();
  }

  private renderCards(): void {
    this.renderNewButton();
    const cards = (this.view?.cards ?? []).filter((c) => matchesFilter(c, this.filter.value));
    this.columns.replaceChildren(
      ...groupCards(cards).map(({ column, cards: list }) =>
        h(
          'section',
          { class: `ui-board__col ui-board__col--${column}`, attrs: { 'aria-label': columnLabel(column) } },
          h('header', { class: 'ui-board__col-head' }, h('h3', { text: columnLabel(column) }), h('span', { class: 'ui-board__count', text: String(list.length) })),
          list.length
            ? h('ul', { class: 'ui-board__list' }, ...list.map((c) => this.cardEl(c)))
            : h('p', { class: 'ui-board__empty', text: this.view ? tr('Nada aqui') : '' }),
        ),
      ),
    );
  }

  private cardEl(c: BoardCard): HTMLElement {
    const key = cardKey(c);
    const updated = ago(c.updatedAt, this.ctx.now());
    const stage = c.work?.stage;
    const selected = this.detail.cardId === key;
    const where = this.projectId ? null : (c.projectName ?? tr('Linear (sem projeto)'));
    return h(
      'li',
      { class: `ui-board__card ui-board__card--${c.kind}${key === this.fresh ? ' is-fresh' : ''}${selected ? ' is-selected' : ''}` },
      h(
        'button',
        { class: 'ui-board__card-link', type: 'button', attrs: { 'data-card': key, 'aria-pressed': selected, title: c.body || c.title }, on: { click: () => this.openDetail(key) } },
        h(
          'span',
          { class: 'ui-board__card-top' },
          h('span', { class: 'ui-board__ref', text: c.ref }),
          h('span', { class: `ui-board__kind ui-board__kind--${c.kind}`, text: kindLabel(c.kind) }),
          stage ? h('span', { class: `ui-board__stage ui-board__stage--${stage}`, text: stageLabel(stage) }) : null,
        ),
        where ? h('span', { class: 'ui-board__project-chip', text: where }) : null,
        h('span', { class: 'ui-board__title', text: c.title }),
        c.labels.length || updated
          ? h(
              'span',
              { class: 'ui-board__meta' },
              ...c.labels.slice(0, 3).map((l) => h('span', { class: 'ui-board__label', text: l })),
              updated ? h('span', { class: 'ui-board__ago', text: updated }) : null,
            )
          : null,
      ),
    );
  }

  private setStatus(text: string, error = false): void {
    setText(this.statusText, text);
    this.status.title = '';
    this.status.classList.toggle('is-error', error);
    setHidden(this.retry, !error);
  }
}
