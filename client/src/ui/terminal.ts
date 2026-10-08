// Terminal somente leitura: janela flutuante sobre o escritório com a conversa de uma sessão (prompts, respostas,
// ferramentas e resultados) no formato em que o Claude Code a mostra, ao vivo pelo stream SSE
// GET /api/agents/:id/terminal (`init` substitui tudo; `append` acrescenta). Nada volta ao agente.
// O modelo (deduplicação, junção ferramenta -> resultado, limite de entradas, prévias recolhidas e rodapé) é puro e
// testado em ui/terminal.test.ts; a montagem usa só textContent (o markdown das respostas vem de ui/markdown.ts).
import type { AgentInfo, TerminalEntry, TerminalInit } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, prefersReducedMotion, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { calendarDayDiff, formatClock, formatDateTime, formatDuration, formatElapsed, relativeTime } from './format';
import { ICONS } from './icons';
import { renderMarkdown } from './markdown';
import { roleLabel, shellWaitIn } from './model';

/** Máximo de itens no DOM: os mais antigos saem primeiro. */
export const TERMINAL_DOM_LIMIT = 1500;
/** Linhas do resultado visíveis antes do "… +N linhas". */
export const RESULT_PREVIEW_LINES = 6;
/** Entrada de ferramenta (comando, diff, JSON) longa: recolhida nas primeiras linhas. */
export const INPUT_PREVIEW_LINES = 10;
/** Prompt do usuário muito longo (texto colado): recolhido. */
export const PROMPT_PREVIEW_LINES = 24;

export const TERMINAL_UNAVAILABLE_HINT = 'O terminal só fica disponível quando o CodeTown roda com acesso local (bind 127.0.0.1)';
const OPEN_ERROR = 'Não foi possível abrir o terminal. O recurso só funciona no acesso local, com o agente ainda aberto.';
const INPUT_PLACEHOLDER = 'Somente leitura — responda no terminal do Claude Code';

/** Distância do fim (px) que ainda conta como "no fim" para seguir as mensagens novas. */
const STICK_PX = 32;
/** EventSource.CLOSED (constante literal, como no store). */
const ES_CLOSED = 2;
/** Quadros do spinner do Claude Code (vai e volta). */
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const SPINNER_MS = 120;
/** "⏺" com seletor de variação de texto: nunca vira emoji colorido (a cor vem do CSS). */
const DOT = '⏺︎';

// ---------------------------------------------------------------- modelo (puro)

export type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
export type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
export type PlainEntry = Exclude<TerminalEntry, ToolEntry | ResultEntry>;

/** O que vira uma linha no terminal: uma entrada simples, uma ferramenta (com o resultado, quando chega) ou um resultado órfão. */
export type TerminalItem =
  | { type: 'entry'; key: string; entry: PlainEntry }
  | { type: 'tool'; key: string; tool: ToolEntry; result?: ResultEntry }
  | { type: 'orphan'; key: string; result: ResultEntry };

export interface TerminalBatch {
  /** Itens novos, na ordem (ferramentas já trazem o resultado que chegou no mesmo lote). */
  added: TerminalItem[];
  /** Resultados de ferramentas que já estavam na tela. */
  attached: { toolKey: string; result: ResultEntry }[];
}

/** Chave estável de uma entrada (o tipo entra na chave: o id de um resultado pode repetir o da ferramenta). */
export function entryKey(e: Pick<TerminalEntry, 'kind' | 'id'>): string {
  return `${e.kind}:${e.id}`;
}

export function toolKey(toolUseId: string): string {
  return `tool:${toolUseId}`;
}

export function terminalUrl(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/terminal`;
}

/**
 * A conversa em memória: deduplica por id, junta cada resultado à sua ferramenta pelo `toolUseId` e limita o total
 * de itens (os mais antigos saem). Não conhece o DOM: devolve o que mudou para a tela aplicar.
 */
export class TerminalLog {
  /** Itens na ordem de chegada (o Map preserva a ordem de inserção: o primeiro é o mais antigo). */
  private items = new Map<string, TerminalItem>();
  /** Chaves de entradas já vistas (inclui os resultados juntados às ferramentas). */
  private seen = new Set<string>();

  get size(): number {
    return this.items.size;
  }

  reset(): void {
    this.items.clear();
    this.seen.clear();
  }

  push(entries: readonly TerminalEntry[]): TerminalBatch {
    const added: TerminalItem[] = [];
    const attached: TerminalBatch['attached'] = [];
    const fresh = new Set<string>();
    for (const e of entries) {
      const key = entryKey(e);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (e.kind === 'tool') {
        const item: TerminalItem = { type: 'tool', key, tool: e };
        this.items.set(key, item);
        added.push(item);
        fresh.add(key);
      } else if (e.kind === 'result') {
        const tk = toolKey(e.toolUseId);
        const tool = this.items.get(tk);
        if (tool?.type === 'tool' && !tool.result) {
          tool.result = e;
          // Ferramenta deste mesmo lote: o resultado já sai junto; senão, vira uma atualização da linha existente.
          if (!fresh.has(tk)) attached.push({ toolKey: tk, result: e });
        } else {
          // Ferramenta fora da janela (ou resultado repetido): aparece sozinho.
          const item: TerminalItem = { type: 'orphan', key, result: e };
          this.items.set(key, item);
          added.push(item);
        }
      } else {
        const item: TerminalItem = { type: 'entry', key, entry: e };
        this.items.set(key, item);
        added.push(item);
      }
    }
    return { added, attached };
  }

  /** Descarta os itens mais antigos até sobrar `limit`; devolve as chaves removidas. */
  trim(limit: number): string[] {
    const removed: string[] = [];
    for (const [key, item] of this.items) {
      if (this.items.size <= limit) break;
      this.items.delete(key);
      this.seen.delete(key);
      if (item.type === 'tool' && item.result) this.seen.delete(entryKey(item.result));
      removed.push(key);
    }
    return removed;
  }
}

const KINDS = new Set<TerminalEntry['kind']>(['user', 'assistant', 'thinking', 'tool', 'result', 'system']);

function validEntry(raw: unknown): raw is TerminalEntry {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string' || !KINDS.has(e.kind as TerminalEntry['kind'])) return false;
  switch (e.kind) {
    case 'thinking':
      return e.text === undefined || typeof e.text === 'string';
    case 'tool':
      return typeof e.title === 'string';
    case 'result':
      return typeof e.toolUseId === 'string' && typeof e.text === 'string';
    default:
      return typeof e.text === 'string';
  }
}

/** Entradas válidas de um `append` (ou da lista do `init`); o resto é ignorado. */
export function sanitizeEntries(raw: unknown): TerminalEntry[] {
  return Array.isArray(raw) ? raw.filter(validEntry) : [];
}

function parseJson(data: unknown): unknown {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

/** Dados do evento `init`; null se não forem reconhecíveis. */
export function parseInit(data: unknown): TerminalInit | null {
  const obj = parseJson(data);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  return { agentId: typeof o.agentId === 'string' ? o.agentId : '', entries: sanitizeEntries(o.entries), truncated: o.truncated === true };
}

/** Dados do evento `append`. */
export function parseAppend(data: unknown): TerminalEntry[] {
  return sanitizeEntries(parseJson(data));
}

export interface TextPreview {
  /** Texto completo (sem espaços/linhas em branco no fim). */
  text: string;
  /** O que aparece recolhido. */
  head: string;
  /** Há mais do que a prévia mostra. */
  collapsed: boolean;
  /** Linhas escondidas na prévia (0 quando o corte foi no meio de uma linha comprida). */
  hiddenLines: number;
  total: number;
}

/**
 * Prévia recolhida de um texto longo: as primeiras `maxLines` linhas (e no máximo `maxChars` caracteres).
 * Só recolhe se sobrarem ao menos 3 linhas (esconder 1 ou 2 linhas atrás de um clique não compensa).
 */
export function previewText(raw: string, maxLines: number, maxChars = maxLines * 200): TextPreview {
  const text = raw.replace(/\s+$/, '');
  const lines = text === '' ? [] : text.split('\n');
  const total = lines.length;
  if (total <= maxLines + 2 && text.length <= maxChars) return { text, head: text, collapsed: false, hiddenLines: 0, total };
  let shown = Math.min(total, maxLines);
  let head = lines.slice(0, shown).join('\n');
  if (head.length > maxChars) {
    head = `${head.slice(0, maxChars).replace(/\s+$/, '')}…`;
    shown = head.split('\n').length;
  }
  return { text, head, collapsed: true, hiddenLines: Math.max(0, total - shown), total };
}

/** Rótulo do botão que expande: "… +12 linhas" (ou "… mostrar tudo" quando o corte foi numa linha comprida). */
export function moreLabel(hiddenLines: number): string {
  if (hiddenLines <= 0) return '… mostrar tudo';
  return `… +${hiddenLines} ${hiddenLines === 1 ? 'linha' : 'linhas'}`;
}

/** "Bash(npm test)" -> nome em destaque + argumentos, como o Claude Code mostra. */
export function splitToolTitle(title: string): { name: string; args: string } {
  const i = title.indexOf('(');
  if (i > 0 && title.endsWith(')') && !/\s/.test(title.slice(0, i))) return { name: title.slice(0, i), args: title.slice(i) };
  return { name: title, args: '' };
}

/** Mostra o `input` da ferramenta? Um comando que já cabe inteiro no título não se repete embaixo. */
export function showToolInput(tool: Pick<ToolEntry, 'title' | 'input' | 'inputKind'>): boolean {
  const input = tool.input?.trim();
  if (!input) return false;
  if ((tool.inputKind ?? 'text') === 'command' && !input.includes('\n') && tool.title.includes(input)) return false;
  return true;
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx';

export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  return 'ctx';
}

/** Horário da entrada para a dica: "14:30:05" hoje, "06 de out., 14:30" em outro dia. */
export function entryTimeTitle(at: number, now: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  return calendarDayDiff(at, now) === 0 ? formatClock(at) : formatDateTime(at);
}

export type TerminalFooterKind = 'working' | 'waiting' | 'shell' | 'idle' | 'ended';

export interface TerminalFooter {
  kind: TerminalFooterKind;
  text: string;
  /** Desde quando está nesse estado (para o tempo ao lado do texto). */
  since?: number;
}

/** Linha de estado do rodapé, imitando o Claude Code, a partir do agente vivo no snapshot. */
export function terminalFooter(agent: AgentInfo | undefined, agents: readonly AgentInfo[], now: number): TerminalFooter {
  if (!agent || agent.status === 'offline') return { kind: 'ended', text: 'Sessão encerrada' };
  if (agent.status === 'done') return { kind: 'ended', text: 'Subagente concluído · sessão encerrada' };
  const wait = shellWaitIn(agent, agents, now);
  if (wait) {
    const label = wait.main?.label?.trim();
    const more = wait.jobs.length > 1 ? ` (+${wait.jobs.length - 1})` : '';
    return { kind: 'shell', text: label ? `Esperando o shell: ${label}${more}` : 'Esperando o shell terminar', since: wait.since };
  }
  switch (agent.status) {
    case 'working': {
      const act = agent.activity?.text?.trim().replace(/(?:…|\.{1,3})$/, '');
      return { kind: 'working', text: `${act || 'Trabalhando'}…`, since: agent.statusSince };
    }
    case 'waiting':
      return { kind: 'waiting', text: agent.waitingFor ? `Esperando você: ${agent.waitingFor}` : 'Esperando você', since: agent.statusSince };
    default:
      return { kind: 'idle', text: 'Aguardando o próximo prompt' };
  }
}

// ---------------------------------------------------------------- linhas (DOM)

type Fill = (target: HTMLElement, text: string) => void;

const fillPlain: Fill = (target, text) => {
  target.textContent = text;
};

/** Diff: uma linha por elemento, com fundo verde (+) ou vermelho (-), como no Claude Code. */
const fillDiff: Fill = (target, text) => {
  const frag = document.createDocumentFragment();
  for (const line of text.split('\n')) frag.append(h('span', { class: `ui-term__dl is-${diffLineKind(line)}`, text: line || ' ' }));
  target.append(frag);
};

/** Bloco de texto que recolhe quando é longo, com "… +N linhas" para expandir (e "recolher" depois). */
function collapsible(raw: string, maxLines: number, cls: string, fill: Fill = fillPlain): HTMLElement {
  const p = previewText(raw, maxLines);
  const body = h('div', { class: 'ui-term__pre' });
  fill(body, p.head);
  const box = h('div', { class: cls }, body);
  if (!p.collapsed) return box;
  let open = false;
  const more = h('button', { class: 'ui-term__more', type: 'button', text: moreLabel(p.hiddenLines), attrs: { 'aria-expanded': 'false' } });
  more.addEventListener('click', () => {
    open = !open;
    body.replaceChildren();
    fill(body, open ? p.text : p.head);
    setText(more, open ? 'recolher' : moreLabel(p.hiddenLines));
    setAttr(more, 'aria-expanded', String(open));
    setTitle(more, open ? 'Recolher' : `Mostrar tudo (${p.total} ${p.total === 1 ? 'linha' : 'linhas'})`);
  });
  setTitle(more, `Mostrar tudo (${p.total} ${p.total === 1 ? 'linha' : 'linhas'})`);
  box.append(more);
  return box;
}

/** Texto que expande num clique (raciocínio, detalhe de evento). */
function expander(label: string, cls: string, detail: string, detailCls: string): HTMLElement {
  const body = h('div', { class: detailCls, text: detail, hidden: true });
  const btn = h('button', { class: cls, type: 'button', text: label, attrs: { 'aria-expanded': 'false' } });
  btn.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    setAttr(btn, 'aria-expanded', String(open));
  });
  return h('div', { class: 'ui-term__exp' }, btn, body);
}

function mark(text: string, extra = ''): HTMLElement {
  return h('span', { class: `ui-term__mark ${extra}`.trim(), text, attrs: { 'aria-hidden': 'true' } });
}

function row(kind: string, at: number, now: number, ...children: (Node | null)[]): HTMLElement {
  return h('div', { class: `ui-term__row ui-term__row--${kind}`, title: entryTimeTitle(at, now) }, ...children);
}

/** "  ⎿  resultado" (primeiras linhas, "… +N linhas" e o aviso de corte). */
function resultBlock(r: ResultEntry): HTMLElement {
  const out = h('div', { class: 'ui-term__out' });
  const text = r.text.replace(/\s+$/, '');
  if (text) out.append(collapsible(text, RESULT_PREVIEW_LINES, 'ui-term__res-text'));
  else out.append(h('span', { class: 'ui-term__empty', text: r.error ? '(erro sem mensagem)' : '(sem saída)' }));
  if (r.truncated) out.append(h('span', { class: 'ui-term__cut', text: '(resultado cortado)' }));
  const el = h('div', { class: `ui-term__result${r.error ? ' is-error' : ''}` }, h('span', { class: 'ui-term__elbow', text: '⎿', attrs: { 'aria-hidden': 'true' } }), out);
  return el;
}

function toolInput(t: ToolEntry): HTMLElement | null {
  if (!showToolInput(t)) return null;
  const kind = t.inputKind ?? 'text';
  const input = t.input!.replace(/\s+$/, '');
  if (kind === 'diff') return collapsible(input, INPUT_PREVIEW_LINES, 'ui-term__in ui-term__in--diff', fillDiff);
  if (kind === 'command') {
    const box = collapsible(input, INPUT_PREVIEW_LINES, 'ui-term__in ui-term__in--command');
    box.prepend(h('span', { class: 'ui-term__dollar', text: '$', attrs: { 'aria-hidden': 'true' } }));
    return box;
  }
  return collapsible(input, INPUT_PREVIEW_LINES, `ui-term__in ui-term__in--${kind === 'json' ? 'json' : 'text'}`);
}

interface ToolRefs {
  row: HTMLElement;
  slot: HTMLElement;
}

function toolRow(t: ToolEntry, now: number): ToolRefs {
  const { name, args } = splitToolTitle(t.title);
  const title = h('div', { class: 'ui-term__title' }, h('strong', { text: name }), args ? document.createTextNode(args) : null);
  const slot = h('div', { class: 'ui-term__slot' });
  const el = row('tool', t.at, now, mark(DOT, 'ui-term__dot'), h('div', { class: 'ui-term__col' }, title, toolInput(t), slot));
  el.classList.add('is-pending');
  return { row: el, slot };
}

function attachResult(refs: ToolRefs, r: ResultEntry): void {
  refs.row.classList.remove('is-pending');
  refs.row.classList.toggle('is-error', !!r.error);
  refs.row.classList.toggle('is-ok', !r.error);
  refs.slot.replaceChildren(resultBlock(r));
}

function entryRow(e: PlainEntry, now: number): HTMLElement {
  switch (e.kind) {
    case 'user':
      return row('user', e.at, now, mark('>'), h('div', { class: 'ui-term__col' }, collapsible(e.text, PROMPT_PREVIEW_LINES, 'ui-term__user-text')));
    case 'assistant': {
      const body = h('div', { class: 'ui-term__col ui-md' });
      body.append(renderMarkdown(e.text));
      return row('assistant', e.at, now, mark(DOT, 'ui-term__dot'), body);
    }
    case 'thinking': {
      const text = e.text?.trim();
      const content = text ? expander('Pensando…', 'ui-term__think', text, 'ui-term__think-text') : h('span', { class: 'ui-term__think', text: 'Pensando…' });
      return row('thinking', e.at, now, mark('✻'), h('div', { class: 'ui-term__col' }, content));
    }
    case 'system': {
      const text = h('span', { class: 'ui-term__sys-text', text: e.text });
      const col = h('div', { class: 'ui-term__col' }, text);
      if (e.detail?.trim()) col.append(expander('detalhes', 'ui-term__sys-more', e.detail.trim(), 'ui-term__sys-detail'));
      const el = row('system', e.at, now, mark('※'), col);
      if (e.level === 'warn' || e.level === 'error') el.classList.add(`is-${e.level}`);
      return el;
    }
  }
}

// ---------------------------------------------------------------- janela

/** O que o resto da interface (gaveta, atalhos) usa do terminal. */
export interface TerminalControl {
  /** Agente com o terminal aberto (null = fechado). */
  readonly agentId: string | null;
  open(agentId: string, opener?: HTMLElement | null): void;
  close(): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
}

type ConnState = 'connecting' | 'open' | 'reconnecting' | 'failed';

export class TerminalPanel implements UiComponent, TerminalControl {
  readonly el: HTMLElement;
  private id: string | null = null;
  private last: AgentInfo | null = null;
  private source: EventSource | null = null;
  private opener: HTMLElement | null = null;
  private conn: ConnState = 'connecting';
  /** Já recebeu um `init` desta conexão (ou de uma anterior, no mesmo agente). */
  private loaded = false;
  private truncated = false;
  private log = new TerminalLog();
  private rows = new Map<string, HTMLElement>();
  private tools = new Map<string, ToolRefs>();
  /** Grudado no fim: mensagens novas rolam a tela. */
  private follow = true;
  /** Itens que chegaram enquanto o usuário lia lá em cima. */
  private unread = 0;
  private spinTimer: ReturnType<typeof setInterval> | null = null;
  private spinFrame = 0;

  private nameEl: HTMLElement;
  private roleEl: HTMLElement;
  private roomEl: HTMLElement;
  private reconnEl: HTMLElement;
  private alertEl: HTMLElement;
  private scroll: HTMLElement;
  private list: HTMLElement;
  private note: HTMLElement;
  private placeholder: HTMLElement;
  private newBtn: HTMLButtonElement;
  private status: HTMLElement;
  private glyph: HTMLElement;
  private statusText: HTMLElement;
  private statusTime: HTMLElement;

  constructor(private ctx: UiContext) {
    const icon = h('span', { class: 'ui-term__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.terminal;
    this.nameEl = h('strong', { class: 'ui-term__name' });
    this.roleEl = h('span', { class: 'ui-role' });
    this.roomEl = h('span', { class: 'ui-term__room' });
    this.reconnEl = h('span', { class: 'ui-term__reconn', text: 'reconectando…', hidden: true, role: 'status' });
    const lock = h('span', { class: 'ui-term__ro-icon', attrs: { 'aria-hidden': 'true' } });
    lock.innerHTML = ICONS.lock;
    const ro = h('span', { class: 'ui-term__ro', title: 'Só para ler: para responder, use o terminal do Claude Code' }, lock, h('span', { text: 'somente leitura' }));
    const close = iconButton(ICONS.close, 'Fechar terminal (Esc)', () => this.close(), 'ui-icon-btn--sm ui-term__close');
    const bar = h(
      'div',
      { class: 'ui-term__bar' },
      icon,
      h('span', { class: 'ui-term__kind', text: 'terminal' }),
      h('div', { class: 'ui-term__who' }, this.nameEl, this.roleEl, this.roomEl),
      this.reconnEl,
      ro,
      close,
    );

    const retry = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: 'Tentar de novo', on: { click: () => this.connect() } });
    this.alertEl = h('div', { class: 'ui-term__alert', role: 'alert', hidden: true }, h('span', { class: 'ui-term__alert-text', text: OPEN_ERROR }), retry);
    this.note = h('p', { class: 'ui-term__note', text: 'Conversa anterior não carregada', hidden: true });
    this.list = h('div', { class: 'ui-term__list' });
    this.placeholder = h('p', { class: 'ui-term__placeholder' });
    this.scroll = h('div', { class: 'ui-term__scroll', tabIndex: 0, attrs: { 'aria-label': 'Conversa da sessão' } }, this.note, this.list, this.placeholder);
    this.scroll.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.newBtn = h('button', { class: 'ui-term__new', type: 'button', hidden: true, on: { click: () => this.jumpToEnd() } });

    this.glyph = h('span', { class: 'ui-term__glyph', attrs: { 'aria-hidden': 'true' } });
    this.statusText = h('span', { class: 'ui-term__status-text' });
    this.statusTime = h('span', { class: 'ui-term__status-time' });
    this.status = h('p', { class: 'ui-term__status' }, this.glyph, this.statusText, this.statusTime);
    const input = h('input', { class: 'ui-term__input', type: 'text', attrs: { disabled: true, placeholder: INPUT_PLACEHOLDER, 'aria-label': INPUT_PLACEHOLDER } });

    this.el = h(
      'section',
      { class: 'ui-term', role: 'dialog', hidden: true, tabIndex: -1, attrs: { 'aria-label': 'Terminal somente leitura' } },
      bar,
      h('div', { class: 'ui-term__body' }, this.alertEl, this.scroll, this.newBtn),
      h('div', { class: 'ui-term__foot' }, this.status, h('label', { class: 'ui-term__prompt' }, h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }), input)),
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    // Janela redimensionada: quem está no fim continua vendo o fim.
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.follow && this.scrollToEnd()).observe(this.scroll);
  }

  get agentId(): string | null {
    return this.id;
  }

  get isOpen(): boolean {
    return this.id !== null;
  }

  open(agentId: string, opener: HTMLElement | null = activeElement()): void {
    if (opener && !this.el.contains(opener)) this.opener = opener;
    if (this.id === agentId) {
      this.focusLog();
      return;
    }
    // Um terminal por vez: abrir o de outro agente substitui o atual.
    this.disconnect();
    this.clear();
    this.id = agentId;
    this.last = this.ctx.agent(agentId) ?? null;
    this.loaded = false;
    this.truncated = false;
    this.follow = true;
    this.unread = 0;
    this.el.hidden = false;
    this.connect();
    this.render();
    this.focusLog();
    this.ctx.invalidate();
  }

  close(): void {
    if (this.id === null) return;
    this.disconnect();
    this.stopSpinner();
    const hadFocus = this.el.contains(document.activeElement) || document.activeElement === document.body;
    this.id = null;
    this.last = null;
    this.el.hidden = true;
    this.clear();
    const opener = this.opener;
    this.opener = null;
    if (hadFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    this.ctx.invalidate();
  }

  toggle(agentId: string, opener: HTMLElement | null = activeElement()): void {
    if (this.id === agentId) this.close();
    else this.open(agentId, opener);
  }

  render(): void {
    if (this.id === null) return;
    const live = this.ctx.agent(this.id);
    if (live) this.last = live;
    const a = this.last;
    const name = a?.name ?? 'Agente';
    setText(this.nameEl, name);
    setText(this.roleEl, a ? roleLabel(a) : '');
    setHidden(this.roleEl, !a);
    if (a) setVariant(this.roleEl, 'ui-role--', a.kind);
    const room = a ? this.ctx.store.room(a.roomId) : undefined;
    setText(this.roomEl, room ? `sala ${room.name}` : '');
    setTitle(this.roomEl, room?.path ?? '');
    setHidden(this.roomEl, !room);
    setAttr(this.el, 'aria-label', `Terminal somente leitura de ${name}`);
    this.el.classList.toggle('is-gone', !live);
    this.renderFooter();
    this.renderState();
  }

  // ---------------------------------------------------------------- stream

  private connect(): void {
    this.disconnect();
    const id = this.id;
    if (id === null) return;
    this.conn = 'connecting';
    let es: EventSource;
    try {
      es = new EventSource(terminalUrl(id));
    } catch {
      this.conn = 'failed';
      this.renderState();
      return;
    }
    this.source = es;
    es.addEventListener('open', () => {
      if (this.source !== es) return;
      this.conn = 'open';
      this.renderState();
    });
    es.addEventListener('init', (ev) => {
      if (this.source !== es) return;
      const data = parseInit((ev as MessageEvent).data);
      if (data) this.onInit(data);
    });
    es.addEventListener('append', (ev) => {
      if (this.source !== es) return;
      const entries = parseAppend((ev as MessageEvent).data);
      if (entries.length) this.ingest(entries, false);
    });
    es.addEventListener('error', () => {
      if (this.source !== es) return;
      // Fechado = o servidor recusou (403/404/429) ou o navegador desistiu; senão, ele mesmo tenta reconectar.
      if (es.readyState === ES_CLOSED) {
        es.close();
        this.source = null;
        this.conn = 'failed';
      } else {
        this.conn = 'reconnecting';
      }
      this.renderState();
    });
    this.renderState();
  }

  private disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  private onInit(data: TerminalInit): void {
    // Reconexão com o usuário lendo lá em cima: tenta manter a mesma entrada no mesmo lugar.
    const anchor = this.follow ? null : this.captureAnchor();
    this.clear();
    this.conn = 'open';
    this.loaded = true;
    this.truncated = data.truncated;
    this.unread = 0;
    this.ingest(data.entries, true);
    const target = anchor ? this.rows.get(anchor.key) : undefined;
    if (anchor && target) this.scroll.scrollTop = target.offsetTop - anchor.offset;
    else {
      this.follow = true;
      this.scrollToEnd();
    }
    this.renderState();
  }

  /** Aplica um lote: cria as linhas novas num fragmento, junta resultados e descarta as linhas mais antigas. */
  private ingest(entries: readonly TerminalEntry[], initial: boolean): void {
    const batch = this.log.push(entries);
    const evicted = this.log.trim(TERMINAL_DOM_LIMIT);
    if (evicted.length) {
      const before = this.follow ? 0 : this.scroll.scrollHeight;
      for (const key of evicted) {
        this.rows.get(key)?.remove();
        this.rows.delete(key);
        this.tools.delete(key);
      }
      // Lendo lá em cima: compensa a altura que saiu do topo para o texto não pular.
      if (!this.follow) this.scroll.scrollTop -= before - this.scroll.scrollHeight;
    }
    for (const { toolKey: key, result } of batch.attached) {
      const refs = this.tools.get(key);
      if (refs) attachResult(refs, result);
    }
    const gone = new Set(evicted);
    const now = this.ctx.now();
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const item of batch.added) {
      if (gone.has(item.key)) continue;
      const el = this.buildRow(item, now);
      el.dataset.key = item.key;
      this.rows.set(item.key, el);
      frag.append(el);
      added++;
    }
    this.list.append(frag);
    if (!initial) {
      if (this.follow) this.scrollToEnd();
      else this.unread += added + batch.attached.length;
      this.renderState();
    }
  }

  private buildRow(item: TerminalItem, now: number): HTMLElement {
    if (item.type === 'entry') return entryRow(item.entry, now);
    if (item.type === 'orphan') {
      const el = row('orphan', item.result.at, now, mark(''), h('div', { class: 'ui-term__col' }, resultBlock(item.result)));
      if (!el.title) el.title = 'Resultado de uma ferramenta anterior';
      return el;
    }
    const refs = toolRow(item.tool, now);
    this.tools.set(item.key, refs);
    if (item.result) attachResult(refs, item.result);
    return refs.row;
  }

  private clear(): void {
    this.log.reset();
    this.rows.clear();
    this.tools.clear();
    this.list.replaceChildren();
  }

  // ---------------------------------------------------------------- rolagem

  private distanceToEnd(): number {
    const s = this.scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight;
  }

  private onScroll(): void {
    const atEnd = this.distanceToEnd() <= STICK_PX;
    if (atEnd === this.follow) return;
    this.follow = atEnd;
    if (atEnd) this.unread = 0;
    this.renderNewButton();
  }

  private scrollToEnd(): void {
    this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  private jumpToEnd(): void {
    this.follow = true;
    this.unread = 0;
    this.scrollToEnd();
    this.renderNewButton();
  }

  private captureAnchor(): { key: string; offset: number } | null {
    const top = this.scroll.scrollTop;
    for (const [key, el] of this.rows) if (el.offsetTop + el.offsetHeight > top) return { key, offset: el.offsetTop - top };
    return null;
  }

  private focusLog(): void {
    this.scroll.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- estado e rodapé

  private renderState(): void {
    setHidden(this.reconnEl, this.conn !== 'reconnecting');
    setHidden(this.alertEl, this.conn !== 'failed');
    setHidden(this.note, !(this.loaded && this.truncated));
    const empty = this.rows.size === 0;
    setHidden(this.placeholder, !empty || this.conn === 'failed');
    if (empty) setText(this.placeholder, this.loaded ? 'Nenhuma mensagem nesta sessão ainda.' : 'Abrindo o terminal…');
    this.renderNewButton();
  }

  private renderNewButton(): void {
    setHidden(this.newBtn, this.follow || this.rows.size === 0);
    setText(this.newBtn, this.unread > 0 ? '↓ Novas mensagens' : '↓ Ir para o fim');
  }

  private renderFooter(): void {
    if (this.id === null) return;
    const now = this.ctx.now();
    const f = terminalFooter(this.ctx.agent(this.id), this.ctx.store.snapshot?.agents ?? [], now);
    setVariant(this.status, 'is-', f.kind);
    setText(this.statusText, f.text);
    setTitle(this.status, f.text);
    let time = '';
    if (f.since !== undefined) {
      const ms = Math.max(0, now - f.since);
      if (f.kind === 'working') time = `(${formatDuration(ms)})`;
      else if (f.kind === 'shell') time = formatElapsed(ms);
      else if (f.kind === 'waiting') time = relativeTime(f.since, now);
    }
    setText(this.statusTime, time);
    setHidden(this.statusTime, !time);
    const glyphs: Record<typeof f.kind, string> = { working: '✻', waiting: '✋', shell: '⏳', idle: '○', ended: '■' };
    if (f.kind === 'working' && !prefersReducedMotion()) this.startSpinner();
    else {
      this.stopSpinner();
      setText(this.glyph, glyphs[f.kind]);
    }
  }

  private startSpinner(): void {
    if (this.spinTimer) return;
    setText(this.glyph, SPINNER[this.spinFrame % SPINNER.length]);
    this.spinTimer = setInterval(() => {
      this.spinFrame = (this.spinFrame + 1) % (SPINNER.length * 8);
      setText(this.glyph, SPINNER[this.spinFrame % SPINNER.length]);
      // O tempo ao lado do texto anda a cada ~1 s, mesmo sem snapshot novo.
      if (this.spinFrame % 8 === 0) this.renderFooter();
    }, SPINNER_MS);
  }

  private stopSpinner(): void {
    if (this.spinTimer) clearInterval(this.spinTimer);
    this.spinTimer = null;
  }
}

function activeElement(): HTMLElement | null {
  return typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}
