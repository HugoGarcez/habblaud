// Responder pelo escritório: cartão do pedido de permissão na gaveta do agente (Aprovar, Recusar com
// motivo, "sempre permitir" e Responder no terminal) e os atalhos que levam até ele (aviso, contador da
// barra superior e tecla P). O pedido chega pelo hook PermissionRequest (scripts/permission-hook.mjs);
// o diálogo continua no terminal e vale o que for respondido primeiro.
import type { AgentInfo, PermissionDecision, PermissionRequestInfo, PermissionSuggestionInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setText, setTitle } from './dom';
import { formatClock, formatDuration } from './format';
import { ICONS } from './icons';
import { diffLineKind, moreLabel, previewText, showToolInput, splitToolTitle } from './terminal';

/** Evento (em ctx.root) que pede para o cartão de um agente aparecer: rolar até ele e receber o foco. */
export const PERMISSION_FOCUS_EVENT = 'codetown:permission-focus';
const PREVIEW_LINES = 12;
const MESSAGE_MAX = 1_000;

const DESTINATIONS: Record<string, string> = {
  session: 'só nesta sessão',
  localSettings: 'neste projeto, só para você',
  projectSettings: 'neste projeto, para todos (versionado)',
  userSettings: 'em todos os projetos',
};

/** Onde a regra "sempre permitir" fica guardada, em português. */
export function destinationLabel(destination: string): string {
  return DESTINATIONS[destination] ?? destination;
}

/** "volta ao terminal em 4 min" (quando o hook desiste de esperar). */
export function expiryText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return 'voltando ao terminal…';
  if (left < 60_000) return 'volta ao terminal em menos de 1 min';
  return `volta ao terminal em ${formatDuration(left)}`;
}

/** Agentes com pedido para responder, do pedido mais antigo para o mais recente. */
export function permissionAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.permission && a.status !== 'offline' && a.status !== 'done').sort((a, b) => a.permission!.createdAt - b.permission!.createdAt);
}

/** Próximo agente com pedido depois de `currentId` (volta ao primeiro no fim da fila). */
export function nextPermissionAgent(agents: readonly AgentInfo[], currentId?: string): AgentInfo | undefined {
  const list = permissionAgents(agents);
  if (!list.length) return undefined;
  const i = currentId ? list.findIndex((a) => a.id === currentId) : -1;
  return list[(i + 1) % list.length];
}

/** Seleciona o agente e pede ao cartão para aparecer (rolar até ele e receber o foco). */
export function focusPermission(ctx: UiContext, agentId: string): void {
  ctx.select({ type: 'agent', id: agentId }, { focus: true });
  ctx.root.dispatchEvent(new CustomEvent(PERMISSION_FOCUS_EVENT, { detail: agentId }));
}

/** A página foi aberta pelo próprio computador? (o servidor só aceita respostas assim) */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/** O comando vai inteiro na caixa "$ …" (é o que se aprova); o título mostra só o nome da ferramenta. */
function commandPreview(p: Pick<PermissionRequestInfo, 'input' | 'inputKind'> | null): boolean {
  return !!p && p.inputKind === 'command' && !!p.input?.trim();
}

/** Prévia dos argumentos (comando, diff, JSON, texto), com as mesmas classes do terminal somente leitura. */
function previewBlock(p: Pick<PermissionRequestInfo, 'title' | 'input' | 'inputKind'>): HTMLElement | null {
  if (!commandPreview(p) && !showToolInput(p)) return null;
  const kind = p.inputKind ?? 'text';
  const text = p.input!.replace(/\s+$/, '');
  const fill = (target: HTMLElement, value: string) => {
    target.replaceChildren();
    if (kind !== 'diff') return void (target.textContent = value);
    for (const line of value.split('\n')) target.append(h('span', { class: `ui-term__dl is-${diffLineKind(line)}`, text: line || ' ' }));
  };
  const pv = previewText(text, PREVIEW_LINES);
  const body = h('div', { class: 'ui-term__pre' });
  fill(body, pv.head);
  const box = h('div', { class: `ui-term__in ui-term__in--${kind}` }, body);
  if (kind === 'command') box.prepend(h('span', { class: 'ui-term__dollar', text: '$', attrs: { 'aria-hidden': 'true' } }));
  if (pv.collapsed) {
    let open = false;
    const more = h('button', { class: 'ui-term__more', type: 'button', text: moreLabel(pv.hiddenLines), attrs: { 'aria-expanded': 'false' } });
    more.addEventListener('click', () => {
      open = !open;
      fill(body, open ? pv.text : pv.head);
      setText(more, open ? 'recolher' : moreLabel(pv.hiddenLines));
      setAttr(more, 'aria-expanded', String(open));
    });
    box.append(more);
  }
  return box;
}

type Phase = 'idle' | 'deny' | 'sending' | 'sent';

/**
 * Cartão "Pede permissão" na gaveta do agente. Some quando o pedido é respondido (por aqui ou no
 * terminal), expira ou o agente sai.
 */
export class PermissionCard {
  readonly el: HTMLElement;
  private id = '';
  private agentId = '';
  private phase: Phase = 'idle';
  private detailReq = 0;
  private detail: PermissionRequestInfo | null = null;
  private pendingFocus: string | null = null;

  private what: HTMLElement;
  private timer: HTMLElement;
  private tool: HTMLElement;
  private preview: HTMLElement;
  private note: HTMLElement;
  private queue: HTMLElement;
  private approveBtn: HTMLButtonElement;
  private denyBtn: HTMLButtonElement;
  private terminalBtn: HTMLButtonElement;
  private always: HTMLElement;
  private suggestions: KeyedList<PermissionSuggestionInfo, HTMLButtonElement>;
  private denyForm: HTMLFormElement;
  private reason: HTMLTextAreaElement;
  private interrupt: HTMLInputElement;
  private status: HTMLElement;
  private remote: HTMLElement;

  constructor(private ctx: UiContext) {
    const icon = h('span', { class: 'ui-perm__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.lock;
    this.what = h('p', { class: 'ui-perm__what' });
    this.timer = h('span', { class: 'ui-perm__timer' });
    this.tool = h('div', { class: 'ui-perm__tool' });
    this.preview = h('div', { class: 'ui-perm__preview' });
    this.note = h('p', { class: 'ui-perm__note', hidden: true });
    this.queue = h('p', { class: 'ui-perm__queue', hidden: true });
    this.remote = h('p', { class: 'ui-perm__note', hidden: true, text: 'Para responder por aqui, abra o CodeTown por http://localhost (ou 127.0.0.1). Por enquanto, responda no terminal.' });

    this.approveBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => this.send({ behavior: 'allow' }) } }, '✓ Aprovar');
    this.denyBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--deny', type: 'button', attrs: { 'aria-expanded': 'false' }, on: { click: () => this.toggleDeny() } }, '✕ Recusar…');
    this.terminalBtn = h(
      'button',
      { class: 'ui-btn ui-perm__btn', type: 'button', title: 'O CodeTown deixa este pedido de lado: vale o que você responder no terminal', on: { click: () => this.send({ behavior: 'terminal' }) } },
      'Responder no terminal',
    );

    const list = h('div', { class: 'ui-perm__rules' });
    this.suggestions = new KeyedList<PermissionSuggestionInfo, HTMLButtonElement>(list, {
      animate: false,
      key: (s) => String(s.index),
      create: (s) => h('button', { class: 'ui-btn ui-perm__rule', type: 'button', on: { click: () => this.send({ behavior: 'allow', suggestion: s.index }) } }),
      update: (btn, s) => {
        const rules = s.rules.join(', ');
        setText(btn, `${rules} · ${destinationLabel(s.destination)}`);
        setTitle(btn, `Aprovar agora e não perguntar de novo: ${rules} (${destinationLabel(s.destination)})`);
      },
    });
    this.always = h('div', { class: 'ui-perm__always', hidden: true }, h('span', { class: 'ui-perm__always-label', text: 'Aprovar e não perguntar de novo:' }), list);

    this.reason = h('textarea', { class: 'ui-perm__reason', attrs: { rows: 2, maxlength: MESSAGE_MAX, placeholder: 'Motivo (opcional, vai para o agente). Ex.: use pnpm em vez de npm', 'aria-label': 'Motivo da recusa (opcional)' } });
    this.interrupt = h('input', { type: 'checkbox', class: 'ui-perm__check' });
    this.denyForm = h(
      'form',
      { class: 'ui-perm__deny', hidden: true },
      this.reason,
      h('label', { class: 'ui-perm__check-row' }, this.interrupt, h('span', { text: 'Interromper o agente (ele para e espera você)' })),
      h(
        'div',
        { class: 'ui-perm__actions' },
        h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--deny', type: 'submit' }, 'Recusar'),
        h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => this.toggleDeny(false) } }, 'Cancelar'),
      ),
    );
    this.denyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const message = this.reason.value.trim().slice(0, MESSAGE_MAX);
      this.send({ behavior: 'deny', ...(message ? { message } : {}), ...(this.interrupt.checked ? { interrupt: true } : {}) });
    });
    // Esc dentro do formulário fecha só o formulário (não a gaveta).
    this.denyForm.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      this.toggleDeny(false);
    });

    this.status = h('p', { class: 'ui-perm__status', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'section',
      { class: 'ui-perm', hidden: true, tabIndex: -1, attrs: { 'aria-label': 'Pedido de permissão' } },
      h('div', { class: 'ui-perm__head' }, icon, h('div', { class: 'ui-perm__head-text' }, h('strong', { class: 'ui-perm__title', text: 'Pede permissão' }), this.what), this.timer),
      this.tool,
      this.preview,
      this.note,
      this.queue,
      this.remote,
      h('div', { class: 'ui-perm__actions' }, this.approveBtn, this.denyBtn, this.terminalBtn),
      this.always,
      this.denyForm,
      this.status,
    );
    ctx.root.addEventListener(PERMISSION_FOCUS_EVENT, (e) => {
      this.pendingFocus = (e as CustomEvent<string>).detail;
      ctx.invalidate();
    });
  }

  /** O cartão está à mostra (há pedido para este agente). */
  get visible(): boolean {
    return !this.el.hidden;
  }

  render(agent: AgentInfo | undefined): void {
    const p = agent?.permission;
    if (!agent || !p) {
      setHidden(this.el, true);
      this.reset('', agent?.id ?? '');
      return;
    }
    if (p.id !== this.id || agent.id !== this.agentId) this.reset(p.id, agent.id);
    setHidden(this.el, false);
    const now = this.ctx.now();
    const full = this.detail?.id === p.id ? this.detail : p.input !== undefined ? p : null;

    setText(this.what, `${p.icon} ${p.text}${p.subagent ? ` · subagente ${p.subagent}` : ''}`);
    setText(this.timer, expiryText(p.expiresAt, now));
    setTitle(this.timer, `Pedido feito às ${formatClock(p.createdAt)}. Sem resposta aqui até ${formatClock(p.expiresAt)}, o CodeTown devolve o pedido ao terminal.`);
    const { name, args } = splitToolTitle(p.title);
    const shown = commandPreview(full) ? '' : args;
    if (this.tool.dataset.title !== `${p.title}|${shown}`) {
      this.tool.dataset.title = `${p.title}|${shown}`;
      this.tool.replaceChildren(h('strong', { text: name }), shown ? document.createTextNode(shown) : '');
    }
    setTitle(this.tool, p.title);
    if (this.preview.dataset.id !== `${p.id}:${full ? 'full' : 'short'}`) {
      this.preview.dataset.id = `${p.id}:${full ? 'full' : 'short'}`;
      this.preview.replaceChildren(full ? (previewBlock(full) ?? '') : h('span', { class: 'ui-muted ui-small', text: 'Carregando os detalhes…' }));
    }

    // Subagente em segundo plano: o Claude Code só mostra o diálogo depois que o hook responde.
    const blocking = agent.kind === 'sub' && agent.background;
    setHidden(this.note, !blocking);
    setText(this.note, blocking ? 'Este subagente roda em segundo plano: o terminal só mostra o pedido depois que você responder aqui ou escolher “Responder no terminal”.' : '');
    setHidden(this.queue, !p.queued);
    setText(this.queue, p.queued ? `+${p.queued} ${p.queued === 1 ? 'pedido' : 'pedidos'} deste agente na fila` : '');

    const local = this.ctx.store.mock || isLocalHostname(location.hostname);
    setHidden(this.remote, local);
    const busy = this.phase === 'sending' || this.phase === 'sent' || !local;
    for (const b of [this.approveBtn, this.denyBtn, this.terminalBtn]) b.disabled = busy;
    this.suggestions.sync(p.suggestions ?? []);
    for (const b of this.suggestions.container.querySelectorAll('button')) b.disabled = busy;
    setHidden(this.always, !p.suggestions?.length || this.phase === 'deny');
    setHidden(this.denyForm, this.phase !== 'deny');
    for (const el of this.denyForm.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLInputElement>('button, textarea, input')) el.disabled = busy;
    setAttr(this.denyBtn, 'aria-expanded', String(this.phase === 'deny'));
    this.denyBtn.classList.toggle('is-on', this.phase === 'deny');

    if (this.pendingFocus === agent.id) {
      this.pendingFocus = null;
      requestAnimationFrame(() => {
        this.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        this.el.focus({ preventScroll: true });
      });
    }
  }

  private reset(id: string, agentId: string): void {
    if (id === this.id && agentId === this.agentId) return;
    this.id = id;
    this.agentId = agentId;
    this.phase = 'idle';
    this.detail = null;
    this.reason.value = '';
    this.interrupt.checked = false;
    setText(this.status, '');
    this.status.classList.remove('is-error');
    delete this.preview.dataset.id;
    if (!id) return;
    const req = ++this.detailReq;
    this.ctx.store
      .permissionDetail(agentId, id)
      .then((d) => {
        if (req !== this.detailReq || !d) return;
        this.detail = d;
        this.ctx.invalidate();
      })
      .catch(() => {
        // Sem detalhe (acesso que não é local ou pedido já respondido): fica o título.
      });
  }

  private toggleDeny(open = this.phase !== 'deny'): void {
    if (this.phase === 'sending' || this.phase === 'sent') return;
    this.phase = open ? 'deny' : 'idle';
    this.ctx.invalidate();
    if (open) requestAnimationFrame(() => this.reason.focus());
    else this.denyBtn.focus();
  }

  private async send(d: PermissionDecision): Promise<void> {
    const id = this.id;
    if (!id || this.phase === 'sending' || this.phase === 'sent') return;
    this.phase = 'sending';
    this.status.classList.remove('is-error');
    setText(this.status, 'Enviando a resposta…');
    this.ctx.invalidate();
    let error: string | undefined;
    try {
      error = await this.ctx.store.decidePermission(id, d);
    } catch {
      error = 'Não foi possível falar com o CodeTown. Responda no terminal.';
    }
    if (this.id !== id) return;
    if (error) {
      this.phase = 'idle';
      this.status.classList.add('is-error');
      setText(this.status, error);
    } else {
      this.phase = 'sent';
      const done = d.behavior === 'allow' ? 'Aprovado' : d.behavior === 'deny' ? 'Recusado' : 'Devolvido ao terminal';
      setText(this.status, `${done}.`);
      this.ctx.announce(`${done}: ${this.ctx.agent(this.agentId)?.name ?? 'agente'}.`);
    }
    this.ctx.invalidate();
  }
}
