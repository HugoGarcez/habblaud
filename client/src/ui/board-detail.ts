// Detalhe de um card do quadro (ui/board.ts): descrição, link para a issue e o trabalho do Promp IA com o card —
// Planejar com IA, acompanhar o planejamento, editar o plano (IA, título e instruções de cada ação; remover ações),
// aprovar ou descartar. Quem fala com o servidor é o quadro; aqui só a apresentação e as edições locais.
import { AGENT_IDS, type ActionRun, type ActionState, type ActionType, type AgentId, type AgentQuota, type BoardCard, type PlanAction, type PlanEdit } from '../../../shared/board';
import { tr } from '../../../shared/i18n';
import { kindLabel } from './board-model';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

export interface CardDetailActions {
  plan(card: BoardCard): Promise<string | undefined>;
  approve(card: BoardCard, edit: PlanEdit | undefined): Promise<string | undefined>;
  discard(card: BoardCard): Promise<string | undefined>;
  retry(card: BoardCard): Promise<string | undefined>;
  answer(card: BoardCard, questionId: string, text: string): Promise<string | undefined>;
  close(): void;
}

export function actionTypeLabel(t: ActionType): string {
  switch (t) {
    case 'analysis':
      return tr('Análise');
    case 'implementation':
      return tr('Implementação');
    case 'tests':
      return tr('Testes');
    case 'review':
      return tr('Revisão');
    case 'docs':
      return tr('Documentação');
  }
}

export function actionStateLabel(s: ActionState): string {
  switch (s) {
    case 'waiting':
      return tr('Aguardando');
    case 'starting':
      return tr('Iniciando…');
    case 'running':
      return tr('Trabalhando');
    case 'done':
      return tr('Concluída');
    case 'failed':
      return tr('Falhou');
    case 'canceled':
      return tr('Cancelada');
  }
}

/** "Codex · 5h 10% · sem. 30%" (ou o motivo de não estar disponível). */
export function quotaText(q: AgentQuota | undefined, agent: AgentId): string {
  if (!q) return agent;
  const parts = [q.fiveHour !== undefined ? tr('5h {0}%', [q.fiveHour]) : '', q.sevenDay !== undefined ? tr('sem. {0}%', [q.sevenDay]) : ''].filter(Boolean);
  if (!q.available) parts.push(q.reason ?? tr('indisponível'));
  return parts.length ? `${q.name} · ${parts.join(' · ')}` : q.name;
}

export class CardDetail {
  readonly el: HTMLElement;
  private card: BoardCard | null = null;
  private agents: AgentQuota[] = [];
  /** Plano sendo editado (cópia do do servidor); undefined = sem edições. */
  private draft: PlanAction[] | undefined;
  private busy = false;
  private readonly head: HTMLElement;
  private readonly content: HTMLElement;
  private readonly error: HTMLElement;

  constructor(private readonly actions: CardDetailActions) {
    this.head = h('div', { class: 'ui-board-card__head' });
    this.content = h('div', { class: 'ui-board-card__content' });
    this.error = h('p', { class: 'ui-board-new__error', role: 'alert', hidden: true });
    this.el = h(
      'aside',
      { class: 'ui-board-card', hidden: true, attrs: { 'aria-label': tr('Detalhe do card') } },
      this.head,
      h('div', { class: 'ui-board-card__scroll' }, this.content, this.error),
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.actions.close();
      }
    });
  }

  get cardId(): string | null {
    return this.card?.id ?? null;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Mostra (ou atualiza) o card. Edições locais do plano ficam enquanto o card continua esperando aprovação. */
  show(card: BoardCard, agents: AgentQuota[]): void {
    const same = this.card?.id === card.id;
    const planChanged = this.card?.work?.plan?.createdAt !== card.work?.plan?.createdAt || this.card?.work?.stage !== card.work?.stage;
    if (!same || planChanged || card.work?.stage !== 'approval') this.draft = undefined;
    // Durante a edição (plano ou resposta a uma pergunta), não redesenha por cima do que a pessoa está digitando.
    const typing = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName);
    if (same && (this.draft || typing) && !planChanged) {
      this.card = card;
      this.agents = agents;
      return;
    }
    this.card = card;
    this.agents = agents;
    if (!same) setHidden(this.error, true);
    this.render();
    setHidden(this.el, false);
  }

  hide(): void {
    this.card = null;
    this.draft = undefined;
    setHidden(this.el, true);
  }

  private render(): void {
    const c = this.card;
    if (!c) return;
    const close = iconButton(ICONS.close, tr('Fechar detalhe'), () => this.actions.close(), 'ui-icon-btn--sm');
    this.head.replaceChildren(
      h(
        'div',
        { class: 'ui-board-card__top' },
        h('a', { class: 'ui-board__ref', text: `${c.ref} ↗`, attrs: { href: c.url, target: '_blank', rel: 'noopener noreferrer', title: tr('Abrir na fonte') } }),
        h('span', { class: `ui-board__kind ui-board__kind--${c.kind}`, text: kindLabel(c.kind) }),
        close,
      ),
      h('h3', { class: 'ui-board-card__title', text: c.title }),
    );
    const parts: (HTMLElement | null)[] = [c.body ? h('p', { class: 'ui-board-card__body', text: c.body }) : null];
    const w = c.work;
    if (!w || w.stage === 'failed') parts.push(this.renderStart());
    else if (w.stage === 'planning') parts.push(this.renderPlanning());
    else parts.push(this.renderPlan());
    this.content.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }

  private renderStart(): HTMLElement {
    const c = this.card!;
    const done = c.column === 'done';
    const btn = this.button(tr('Planejar com IA'), 'allow', () => this.run(() => this.actions.plan(c)), done);
    return h(
      'section',
      { class: 'ui-board-card__section' },
      c.work?.error ? h('p', { class: 'ui-board-new__error', text: c.work.error }) : null,
      h('p', { class: 'ui-board-new__hint', text: tr('Um Claude lê o repositório (sem mudar nada), quebra o card em ações e escolhe a IA de cada uma pelas cotas abaixo. Você revisa e aprova.') }),
      this.renderQuotas(),
      h('div', { class: 'ui-board-new__foot' }, btn),
    );
  }

  private renderPlanning(): HTMLElement {
    const c = this.card!;
    return h(
      'section',
      { class: 'ui-board-card__section' },
      h('p', { class: 'ui-board-card__planning', text: tr('Planejando… o Claude está lendo o repositório (leva de 1 a 4 minutos).') }),
      h('div', { class: 'ui-board-new__foot' }, this.button(tr('Cancelar'), '', () => this.run(() => this.actions.discard(c)))),
    );
  }

  private renderPlan(): HTMLElement {
    const c = this.card!;
    const plan = c.work!.plan!;
    const editable = c.work!.stage === 'approval';
    const list = this.draft ?? plan.actions;
    const byId = new Map(list.map((a, i) => [a.id, i + 1]));
    const section = h(
      'section',
      { class: 'ui-board-card__section' },
      h('h4', { text: editable ? tr('Plano (aguardando sua aprovação)') : tr('Plano aprovado') }),
      editable ? null : this.renderRunHead(),
      plan.summary ? h('p', { class: 'ui-board-card__summary', text: plan.summary }) : null,
      plan.notes.length ? h('ul', { class: 'ui-board-card__notes' }, ...plan.notes.map((n) => h('li', { text: n }))) : null,
      h('ol', { class: 'ui-board-card__actions' }, ...list.map((a, i) => this.renderAction(a, i, byId, editable && list.length > 1, editable))),
    );
    if (editable) {
      section.append(
        h(
          'div',
          { class: 'ui-board-new__foot' },
          this.button(tr('Descartar'), '', () => this.run(() => this.actions.discard(c))),
          this.button(tr('Planejar de novo'), '', () => this.run(() => this.actions.plan(c))),
          this.button(tr('Aprovar plano'), 'allow', () => this.run(() => this.actions.approve(c, this.draft ? { actions: this.draft, summary: plan.summary } : undefined)), !list.length),
        ),
      );
    } else {
      const stage = c.work!.stage;
      const run = c.work!.run;
      if (run?.log.length) {
        section.append(
          h(
            'details',
            { class: 'ui-board-card__details ui-board-card__log' },
            h('summary', { text: tr('Histórico da execução') }),
            h('ol', {}, ...run.log.slice().reverse().map((l) => h('li', { text: `${new Date(l.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${l.text}` }))),
          ),
        );
      }
      const foot = h('div', { class: 'ui-board-new__foot' });
      if (stage === 'blocked') foot.append(this.button(tr('Tentar de novo'), 'allow', () => this.run(() => this.actions.retry(c))));
      if (stage === 'queued' || stage === 'running' || stage === 'blocked') {
        foot.prepend(this.button(stage === 'queued' && !run?.runId ? tr('Tirar da fila') : tr('Cancelar execução'), '', () => this.run(() => this.actions.discard(c))));
      }
      if (stage === 'review' || stage === 'done') foot.append(this.button(tr('Tirar do quadro'), '', () => this.run(() => this.actions.discard(c))));
      if (foot.childElementCount) section.append(foot);
    }
    return section;
  }

  /** Situação da execução: erro, perguntas dos agentes, worktree e PR. */
  private renderRunHead(): HTMLElement | null {
    const c = this.card!;
    const w = c.work!;
    const run = w.run;
    const box = h('div', { class: 'ui-board-card__run' });
    if (w.stage === 'queued') box.append(h('p', { class: 'ui-board-new__hint', text: tr('Na fila: preparando o worktree e as tarefas no Orca…') }));
    if (w.error) box.append(h('p', { class: 'ui-board-new__error', text: w.error }));
    for (const q of run?.questions ?? []) box.append(this.renderQuestion(q.id, q.text, q.options));
    if (run?.pr) box.append(h('p', {}, h('a', { class: 'ui-link-btn', text: tr('Abrir o PR ↗'), attrs: { href: run.pr.url, target: '_blank', rel: 'noopener noreferrer' } })));
    if (run?.worktree) box.append(h('p', { class: 'ui-board-new__hint', text: tr('Worktree: {0} · branch {1}', [run.worktree.path, run.worktree.branch.replace(/^refs\/heads\//, '')]) }));
    return box.childElementCount ? box : null;
  }

  private renderQuestion(id: string, text: string, options?: string[]): HTMLElement {
    const c = this.card!;
    const input = h('textarea', { class: 'ui-rename__input', attrs: { rows: 2, placeholder: tr('Sua resposta'), 'aria-label': tr('Resposta ao agente') } });
    const send = (answer: string) => {
      const t = answer.trim();
      if (t) void this.run(() => this.actions.answer(c, id, t));
    };
    return h(
      'div',
      { class: 'ui-board-card__question', role: 'group', attrs: { 'aria-label': tr('Pergunta de um agente') } },
      h('strong', { text: tr('Um agente pergunta:') }),
      h('p', { class: 'ui-board-card__body', text }),
      options?.length ? h('div', { class: 'ui-board-card__options' }, ...options.map((o) => this.button(o, '', () => send(o)))) : null,
      input,
      h('div', { class: 'ui-board-new__foot' }, this.button(tr('Responder'), 'allow', () => send(input.value))),
    );
  }

  private renderAction(a: PlanAction, i: number, byId: Map<string, number>, removable: boolean, editable: boolean): HTMLElement {
    const runState: ActionRun | undefined = this.card?.work?.run?.actions[a.id];
    const deps = a.deps.map((d) => byId.get(d)).filter((n): n is number => !!n);
    const quota = new Map(this.agents.map((q) => [q.agent, q]));
    const meta = h(
      'div',
      { class: 'ui-board-card__action-meta' },
      h('span', { class: 'ui-board__label', text: actionTypeLabel(a.type) }),
      a.writes ? h('span', { class: 'ui-board__label', text: tr('muda arquivos') }) : null,
      runState ? h('span', { class: `ui-board__stage ui-board__action-state--${runState.state}`, text: actionStateLabel(runState.state) }) : null,
      deps.length ? h('span', { class: 'ui-board__ago', text: tr('depois de {0}', [deps.join(', ')]) }) : null,
    );
    let agentEl: HTMLElement;
    if (editable) {
      const sel = h(
        'select',
        { class: 'ui-day__select ui-board-card__agent', attrs: { 'aria-label': tr('IA da ação {0}', [i + 1]) }, on: { change: () => this.edit(i, { agent: sel.value as AgentId }) } },
        ...AGENT_IDS.map((id) => h('option', { text: quotaText(quota.get(id), id), attrs: { value: id, disabled: !quota.get(id)?.installed } })),
      );
      sel.value = a.agent;
      agentEl = sel;
    } else {
      agentEl = h('span', { class: 'ui-board-card__agent-name', text: quotaText(quota.get(a.agent), a.agent) });
    }
    const instructions = editable
      ? h('textarea', { class: 'ui-rename__input ui-board-card__instr', attrs: { rows: 5, 'aria-label': tr('Instruções da ação {0}', [i + 1]) }, on: { input: (e) => this.edit(i, { instructions: (e.target as HTMLTextAreaElement).value }) } })
      : h('p', { class: 'ui-board-card__instr-text', text: a.instructions });
    if (instructions instanceof HTMLTextAreaElement) instructions.value = a.instructions;
    const title = editable
      ? h('input', { class: 'ui-rename__input ui-board-card__action-title', type: 'text', attrs: { 'aria-label': tr('Título da ação {0}', [i + 1]), maxlength: 120 }, on: { input: (e) => this.edit(i, { title: (e.target as HTMLInputElement).value }) } })
      : h('strong', { text: a.title });
    if (title instanceof HTMLInputElement) title.value = a.title;
    return h(
      'li',
      { class: 'ui-board-card__action' },
      h(
        'div',
        { class: 'ui-board-card__action-head' },
        title,
        removable ? iconButton(ICONS.close, tr('Remover ação {0}', [i + 1]), () => this.removeAction(i), 'ui-icon-btn--sm') : null,
      ),
      meta,
      h('div', { class: 'ui-board-card__agent-row' }, agentEl),
      a.reason && !runState ? h('p', { class: 'ui-board-new__hint', text: a.reason }) : null,
      runState?.waitingFor ? h('p', { class: 'ui-board-new__hint', text: runState.waitingFor }) : null,
      runState?.result ? h('p', { class: 'ui-board-card__result', text: runState.result }) : null,
      runState?.error ? h('p', { class: 'ui-board-new__error', text: runState.error }) : null,
      h('details', { class: 'ui-board-card__details' }, h('summary', { text: tr('Instruções para o agente') }), instructions),
    );
  }

  private renderQuotas(): HTMLElement {
    return h(
      'ul',
      { class: 'ui-board-card__quotas' },
      ...this.agents.map((q) => h('li', { class: q.available ? 'is-ok' : 'is-off', text: quotaText(q, q.agent), title: q.strengths })),
    );
  }

  private edit(i: number, patch: Partial<PlanAction>): void {
    const base = this.draft ?? this.card?.work?.plan?.actions.map((a) => ({ ...a })) ?? [];
    base[i] = { ...base[i], ...patch, ...(patch.agent && patch.agent !== base[i].agent ? { reason: tr('IA escolhida por você.') } : {}) };
    this.draft = base;
  }

  private removeAction(i: number): void {
    const base = this.draft ?? this.card?.work?.plan?.actions.map((a) => ({ ...a })) ?? [];
    if (base.length <= 1) return;
    const [gone] = base.splice(i, 1);
    this.draft = base.map((a) => ({ ...a, deps: a.deps.filter((d) => d !== gone.id) }));
    this.render();
  }

  private button(text: string, variant: '' | 'allow', onClick: () => void, disabled = false): HTMLButtonElement {
    const b = h('button', { class: `ui-btn${variant ? ' ui-perm__btn ui-perm__btn--allow' : ''}`, type: 'button', text, on: { click: onClick } });
    b.disabled = disabled || this.busy;
    return b;
  }

  private async run(fn: () => Promise<string | undefined>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    setHidden(this.error, true);
    for (const b of this.el.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
    try {
      const err = await fn();
      if (err) {
        setText(this.error, err);
        setHidden(this.error, false);
      } else this.draft = undefined;
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
