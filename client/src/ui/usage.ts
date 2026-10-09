// Cartões de USO POR CONTA na barra superior: sessão de 5 horas e semanal, com reinício e origem dos números.
// Regras de apresentação:
// - número velho nunca passa por atual: janela que já renovou depois da leitura mostra "—" e "renovada";
//   números antigos ficam acinzentados com a idade ("há 6 d") no cabeçalho ou, no celular, um selo no chip;
// - o reinício vem com verbo implícito no ícone ↻ e contagem regressiva quando falta menos de um dia;
// - conta sem números diz "sem dados de uso" e oferece "Como ativar" (mod do Habblaud, recomendado).
import type { AccountInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { FIVE_HOURS_MS, relativeTime, usageLevel, usageWindowView, WEEK_MS, type UsageWindowView } from './format';
import { ICONS } from './icons';
import { createAccountChip, updateAccountChip } from './widgets';

export const SOURCE_LABEL: Record<NonNullable<AccountInfo['usage']>['source'], string> = {
  cache: 'cache do /usage do Claude Code',
  statusline: 'ao vivo (statusline do Claude Code)',
  codex: 'arquivos do Codex',
};

/** Origem para mostrar: o arquivo ao vivo pode ter sido gravado pelo mod do Habblaud ou pelo tap. */
export function sourceLabel(u: NonNullable<AccountInfo['usage']>): string {
  if (u.source === 'statusline' && u.via === 'mod') return 'ao vivo (mod do Habblaud)';
  return SOURCE_LABEL[u.source] ?? u.source;
}

/**
 * Como ligar o uso de uma conta, em ordem de preferência (dica do cartão e ajuda).
 * Trechos entre crases viram código (sem quebra de linha no meio do comando).
 */
export const USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'npm run mod:install',
    'Recomendado: instala o mod do Habblaud no Claude Code (2.1.287 ou mais novo), que passa o uso de 5 h e da semana ao vivo. Rode na pasta do Habblaud, no computador onde o Claude Code roda; nas sessões já abertas, `/reload-plugins`.',
  ],
  [
    'npm run usage:install',
    'No Claude Code anterior ao 2.1.287: liga um tap na linha de status, que passa os mesmos números ao vivo.',
  ],
  ['/usage', 'Sem instalar nada: rode `/usage` no Claude Code desta conta para atualizar o cache (os números envelhecem até a próxima vez).'],
];

/** Texto com trechos `assim` como código. */
function richText(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { class: 'ui-usage-setup__inline', text: part }) : document.createTextNode(part)));
}

interface Meter {
  el: HTMLElement;
  bar: HTMLElement;
  pct: HTMLElement;
  reset: HTMLElement;
  resetLong: HTMLElement;
  resetShort: HTMLElement;
}

interface CardRefs {
  chip: HTMLElement;
  flag: HTMLElement;
  name: HTMLElement;
  email: HTMLElement;
  state: HTMLElement;
  stateText: HTMLElement;
  meters: HTMLElement;
  five: Meter;
  week: Meter;
  msg: HTMLElement;
  tip: HTMLElement;
  tipTitle: HTMLElement;
  tipRows: HTMLElement;
  tipNote: HTMLElement;
  tipSetup: HTMLElement;
}

let tipSeq = 0;

function createMeter(long: string, short: string, title: string): Meter {
  const bar = h('span', { class: 'ui-meter__bar' }, h('span', { class: 'ui-meter__fill' }));
  const pct = h('span', { class: 'ui-meter__pct' });
  const resetLong = h('span', { class: 'ui-meter__reset-long' });
  const resetShort = h('span', { class: 'ui-meter__reset-short' });
  const reset = h('span', { class: 'ui-meter__reset' }, resetLong, resetShort);
  const label = h(
    'span',
    { class: 'ui-meter__label' },
    h('span', { class: 'ui-meter__label-long', text: long }),
    h('span', { class: 'ui-meter__label-short', text: short, attrs: { 'aria-hidden': 'true' } }),
  );
  const el = h('div', { class: 'ui-meter', role: 'img', attrs: { 'aria-label': title } }, label, bar, pct, reset);
  return { el, bar, pct, reset, resetLong, resetShort };
}

function updateMeter(m: Meter, view: UsageWindowView | null, windowName: string): void {
  if (!view || view.pct === null) {
    setVariant(m.el, 'is-', 'none');
    m.el.classList.remove('is-zero');
    m.el.classList.toggle('is-renewed', !!view?.renewed);
    setStyleVar(m.bar, '--pct', '0');
    setText(m.pct, '—');
    setText(m.resetLong, view?.renewed ? '↻ renovada' : '');
    setText(m.resetShort, '');
    const text = view ? `${windowName}: ${view.summary}` : `${windowName}: sem dados`;
    setAttr(m.el, 'aria-label', text);
    setTitle(m.el, view?.renewed ? `${windowName}: a janela já renovou depois da última leitura; o uso atual é desconhecido.` : text);
    return;
  }
  const p = view.pct;
  m.el.classList.remove('is-renewed');
  setVariant(m.el, 'is-', usageLevel(p));
  m.el.classList.toggle('is-zero', p === 0);
  setStyleVar(m.bar, '--pct', String(p));
  setText(m.pct, `${p}%`);
  setText(m.resetLong, view.reset ? `↻ ${view.reset}` : '');
  setText(m.resetShort, view.resetShort ? `↻${view.resetShort}` : '');
  setAttr(m.el, 'aria-label', `${windowName}: ${view.summary}`);
  setTitle(m.el, `${windowName}: ${view.summary}`);
}

function syncRows(dl: HTMLElement, rows: [string, string][]): void {
  while (dl.children.length > rows.length * 2) dl.lastElementChild!.remove();
  rows.forEach(([k, v], i) => {
    let dt = dl.children[i * 2] as HTMLElement | undefined;
    let dd = dl.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt || !dd) {
      dt = h('dt');
      dd = h('dd');
      dl.append(dt, dd);
    }
    setText(dt, k);
    setText(dd, v);
  });
}

/** Passo a passo para ligar o uso (dica do cartão e ajuda). */
export function createUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...USAGE_SETUP_STEPS.map(([cmd, text]) => h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text)))),
  );
}

type CardState = 'ok' | 'stale' | 'empty';

function hasWindows(a: AccountInfo): boolean {
  return !!a.usage && !!(a.usage.fiveHour || a.usage.sevenDay);
}

/** Estado efetivo do cartão. */
function cardState(a: AccountInfo): CardState {
  // Leitura sem nenhuma das janelas (ex.: cache do /usage sem números) vale como "sem dados".
  if (!hasWindows(a)) return 'empty';
  return a.usageStatus === 'ok' ? 'ok' : 'stale';
}

export class UsageCards {
  readonly el: HTMLElement;
  private list: KeyedList<AccountInfo>;
  private refs = new WeakMap<HTMLElement, CardRefs>();

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-usage', role: 'group', attrs: { 'aria-label': 'Uso por conta' } });
    this.list = new KeyedList<AccountInfo>(this.el, {
      key: (a) => a.id,
      create: () => this.createCard(),
      update: (el, a) => this.updateCard(el, a),
    });
  }

  render(): void {
    const accounts = this.ctx.store.snapshot?.accounts ?? [];
    this.list.sync(accounts);
    this.el.classList.toggle('is-empty', accounts.length === 0);
    setStyleVar(this.el, '--count', String(accounts.length));
  }

  private createCard(): HTMLElement {
    const tipId = `ui-usage-tip-${++tipSeq}`;
    const chip = createAccountChip('lg');
    const flag = h('span', { class: 'ui-usage-card__flag', hidden: true, attrs: { 'aria-hidden': 'true' } });
    flag.innerHTML = ICONS.clock;
    const name = h('span', { class: 'ui-usage-card__name' });
    const email = h('span', { class: 'ui-usage-card__email' });
    const stateIcon = h('span', { class: 'ui-usage-card__state-icon', attrs: { 'aria-hidden': 'true' } });
    stateIcon.innerHTML = ICONS.clock;
    const stateText = h('span');
    const state = h('span', { class: 'ui-usage-card__state' }, stateIcon, stateText);
    const five = createMeter('5h', '5h', 'Sessão de 5 horas');
    const week = createMeter('Semana', 'Sem.', 'Limite semanal');
    const meters = h('div', { class: 'ui-usage-card__meters' }, five.el, week.el);
    const msgLong = h('span', { class: 'ui-usage-card__msg-long', text: 'sem dados de uso' });
    const msgShort = h('span', { class: 'ui-usage-card__msg-short', text: 'sem dados', attrs: { 'aria-hidden': 'true' } });
    const howLong = h('span', { class: 'ui-usage-card__how-long', text: 'Como ativar' });
    const howShort = h('span', { class: 'ui-usage-card__how-short', text: 'Ativar', attrs: { 'aria-hidden': 'true' } });
    const howBtn = h(
      'button',
      {
        class: 'ui-usage-card__how',
        type: 'button',
        title: 'Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)',
        on: { click: () => this.ctx.openHelp('usage') },
      },
      howLong,
      howShort,
    );
    const msg = h('div', { class: 'ui-usage-card__msg' }, h('span', { class: 'ui-usage-card__msg-text' }, msgLong, msgShort), howBtn);
    const tipTitle = h('div', { class: 'ui-usage-tip__title' });
    const tipRows = h('dl', { class: 'ui-kv' });
    const tipNote = h('p', { class: 'ui-usage-tip__note' });
    const tipSetup = h('div', { class: 'ui-usage-tip__setup' }, h('p', { class: 'ui-usage-tip__setup-title', text: 'Como ter o uso ao vivo' }), createUsageSetup());
    const tip = h('div', { class: 'ui-usage-tip', role: 'tooltip', attrs: { id: tipId } }, tipTitle, tipRows, tipNote, tipSetup);
    const card = h(
      'div',
      { class: 'ui-usage-card', tabIndex: 0, attrs: { 'aria-describedby': tipId } },
      chip,
      flag,
      h('div', { class: 'ui-usage-card__body' }, h('div', { class: 'ui-usage-card__head' }, name, email, state), meters, msg),
      tip,
    );
    this.refs.set(card, { chip, flag, name, email, state, stateText, meters, five, week, msg, tip, tipTitle, tipRows, tipNote, tipSetup });
    return card;
  }

  private updateCard(card: HTMLElement, a: AccountInfo): void {
    const r = this.refs.get(card)!;
    const now = this.ctx.now();
    updateAccountChip(r.chip, a);
    setStyleVar(card, '--acc', a.color);
    setText(r.name, a.name);
    setText(r.email, a.email ?? a.configDir);
    setAttr(card, 'aria-label', `${a.name}: uso do plano`);

    const usage = a.usage;
    const state = cardState(a);
    setVariant(card, 'is-', state);
    const five = usage ? usageWindowView(usage.fiveHour, usage.fetchedAt, now, FIVE_HOURS_MS) : null;
    const week = usage ? usageWindowView(usage.sevenDay, usage.fetchedAt, now, WEEK_MS) : null;
    const showMeters = hasWindows(a);
    setHidden(r.meters, !showMeters);
    if (usage && showMeters) {
      updateMeter(r.five, five, 'Sessão de 5 horas');
      updateMeter(r.week, week, 'Semana');
    }
    r.meters.classList.toggle('is-dim', state !== 'ok');

    // Idade dos números antigos no cabeçalho (no celular, um selo no chip faz esse papel).
    const stale = state === 'stale';
    setHidden(r.state, !stale);
    setHidden(r.flag, !stale);
    if (stale && usage) {
      const age = relativeTime(usage.fetchedAt, now);
      setText(r.stateText, age);
      setTitle(r.state, `Números de ${age}: podem não refletir o uso atual.`);
    }

    // Sem números: "sem dados de uso" + "Como ativar".
    setHidden(r.msg, state !== 'empty');
    this.updateTip(r, a, state, five, week, now);
  }

  private updateTip(r: CardRefs, a: AccountInfo, state: CardState, five: UsageWindowView | null, week: UsageWindowView | null, now: number): void {
    setText(r.tipTitle, `${a.name}${a.plan ? ` · plano ${a.plan}` : ''}`);
    const rows: [string, string][] = [];
    if (a.email) rows.push(['E-mail', a.email]);
    if (a.organization) rows.push(['Organização', a.organization]);
    if (a.plan) rows.push(['Plano', a.plan]);
    rows.push(['Pasta', a.configDir]);
    rows.push(['Sessões abertas', String(a.sessions)]);
    const u = a.usage;
    if (u && (u.fiveHour || u.sevenDay)) {
      rows.push(['Sessão de 5 h', five?.summary ?? '—']);
      rows.push(['Semana', week?.summary ?? '—']);
      const opus = usageWindowView(u.sevenDayOpus, u.fetchedAt, now, WEEK_MS);
      const sonnet = usageWindowView(u.sevenDaySonnet, u.fetchedAt, now, WEEK_MS);
      if (opus) rows.push(['Opus (semana)', opus.summary]);
      if (sonnet) rows.push(['Sonnet (semana)', sonnet.summary]);
      rows.push(['Origem', sourceLabel(u)]);
      rows.push(['Atualizado', relativeTime(u.fetchedAt, now)]);
    }
    syncRows(r.tipRows, rows);

    let note = '';
    if (state === 'empty')
      note = u ? `A última leitura (${sourceLabel(u)}, ${relativeTime(u.fetchedAt, now)}) não trouxe números de 5 h nem da semana.` : 'Ainda não há números de uso para esta conta.';
    else if (state === 'stale') note = 'Números antigos: refletem a última leitura, não o uso de agora.';
    else if (u?.source === 'cache') note = 'Cache do /usage: atualiza quando alguém roda /usage nesta conta.';
    else if (five?.renewed || week?.renewed) note = 'Uma das janelas já reiniciou depois da última leitura.';
    setText(r.tipNote, note);
    setHidden(r.tipNote, !note);
    // O passo a passo aparece sempre que os números não são ao vivo.
    const live = u?.source === 'statusline' && state === 'ok';
    setHidden(r.tipSetup, live);
  }
}
