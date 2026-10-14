// Quadro de tarefas (botão "Tarefas" da barra superior; atalho K): o kanban de cada projeto do Orca, com as issues
// do GitHub ou do Linear nas colunas Backlog → Planejando → Aguardando aprovação → Em execução → Revisão → Concluído.
// Nesta fase é só leitura: escolher o projeto e a fonte, filtrar e abrir a issue na fonte. Os dados vêm de
// GET /api/board e GET /api/board/projects/:id (server/board/), relidos a cada 30 s com a janela aberta.
import type { BoardCard, BoardIndex, BoardProject, BoardSource, BoardView } from '../../../shared/board';
import { tr } from '../../../shared/i18n';
import { columnLabel, groupCards, kindLabel, matchesFilter, pickProject } from './board-model';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { ago } from './spawn';

const REFRESH_MS = 30_000;
const LAST_PROJECT_KEY = 'habblaud.board.project';

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeLast(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // navegação privada / armazenamento bloqueado
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error || tr('O servidor respondeu {0}.', [res.status]));
  return body as T;
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
  private index: BoardIndex | null = null;
  private view: BoardView | null = null;
  private projectId: string | null = null;
  private wanted: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loadSeq = 0;
  private opener: HTMLElement | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly button: HTMLElement,
  ) {
    this.projectSel = h('select', { class: 'ui-day__select ui-board__project', attrs: { 'aria-label': tr('Projeto do Orca') }, on: { change: () => this.pick(this.projectSel.value) } });
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

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-board', attrs: { 'aria-labelledby': 'ui-board-title' } },
      h(
        'div',
        { class: 'ui-dialog__head ui-board__head' },
        h('h2', { text: tr('Tarefas'), attrs: { id: 'ui-board-title' } }),
        h('div', { class: 'ui-board__controls' }, this.projectSel, this.sourceSel, this.teamSel, this.filter, refresh),
        close,
      ),
      h('div', { class: 'ui-board__body' }, this.status, this.columns),
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

  /** Abre no projeto pedido (ex.: o da sala), ou no último aberto. */
  open(projectId?: string): void {
    this.wanted = projectId ?? null;
    if (!this.el.open) {
      this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.el.showModal();
      this.button.setAttribute('aria-expanded', 'true');
      this.timer = setInterval(() => void this.load(false), REFRESH_MS);
    }
    void this.load(true, true);
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
    this.button.setAttribute('aria-expanded', 'false');
    this.opener?.focus();
  }

  private pick(id: string): void {
    this.projectId = id;
    writeLast(id);
    this.view = null;
    this.renderCards();
    void this.load(false);
  }

  /** `withIndex`: relê também a lista de projetos (ao abrir). */
  private async load(refresh: boolean, withIndex = false): Promise<void> {
    const seq = ++this.loadSeq;
    this.setStatus(tr('Carregando…'));
    try {
      if (withIndex || !this.index) {
        this.index = await api<BoardIndex>('/api/board');
        if (seq !== this.loadSeq) return;
        const p = pickProject(this.index.projects, this.wanted, this.projectId ?? readLast());
        this.projectId = p?.id ?? null;
        this.renderControls();
      }
      if (!this.projectId) {
        this.view = null;
        this.renderCards();
        this.setStatus(tr('Nenhum projeto no Orca. Adicione um repositório no Orca para ver o quadro.'));
        return;
      }
      const view = await api<BoardView>(`/api/board/projects/${encodeURIComponent(this.projectId)}${refresh ? '?refresh=1' : ''}`);
      if (seq !== this.loadSeq) return;
      this.view = view;
      this.mergeProject(view.project);
      this.renderControls();
      this.renderCards();
      if (view.error) this.setStatus(view.error, true);
      else {
        const when = ago(view.fetchedAt, this.ctx.now()) || tr('agora');
        this.setStatus(view.cards.length === 1 ? tr('1 card · atualizado {0}', [when]) : tr('{0} cards · atualizado {1}', [view.cards.length, when]));
      }
    } catch (err) {
      if (seq !== this.loadSeq) return;
      this.setStatus(err instanceof Error ? err.message : String(err), true);
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
    this.projectSel.replaceChildren(...projects.map((p) => h('option', { text: p.github ? `${p.name} · ${p.github}` : p.name, attrs: { value: p.id } })));
    if (this.projectId) this.projectSel.value = this.projectId;
    setHidden(this.projectSel, !projects.length);
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
  }

  private renderCards(): void {
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
    const updated = ago(c.updatedAt, this.ctx.now());
    return h(
      'li',
      { class: `ui-board__card ui-board__card--${c.kind}` },
      h(
        'a',
        { class: 'ui-board__card-link', attrs: { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: c.body || c.title } },
        h('span', { class: 'ui-board__card-top' }, h('span', { class: 'ui-board__ref', text: c.ref }), h('span', { class: `ui-board__kind ui-board__kind--${c.kind}`, text: kindLabel(c.kind) })),
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
    this.status.classList.toggle('is-error', error);
    setHidden(this.retry, !error);
  }
}
