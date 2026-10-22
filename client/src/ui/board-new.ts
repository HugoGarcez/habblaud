// Formulário "Novo card" do quadro de tarefas (ui/board.ts): tipo (Issue, Funcionalidade, Correção), título,
// descrição e imagens (ui/board-images.ts). Quem cria a issue é o quadro (POST /api/board/projects/:id/cards); aqui só o formulário.
import { CARD_BODY_MAX, CARD_TITLE_MAX, type CardKind, type NewAttachment, type NewCard } from '../../../shared/board';
import { tr } from '../../../shared/i18n';
import { ImagePicker } from './board-images';
import { kindLabel } from './board-model';
import { h, setHidden, setText } from './dom';

const KINDS: readonly CardKind[] = ['issue', 'feature', 'fix'];

/** Dica de cada tipo (embaixo do seletor). */
function kindHint(k: CardKind): string {
  switch (k) {
    case 'issue':
      return tr('Uma tarefa ou pergunta qualquer.');
    case 'feature':
      return tr('Algo novo para o projeto fazer.');
    case 'fix':
      return tr('Algo que está errado e precisa de conserto: diga o que acontece e o que deveria acontecer.');
  }
}

export interface NewCardFormOptions {
  /** Cria a issue no projeto; devolve a mensagem de erro, ou undefined se deu certo. */
  submit(card: NewCard, projectId: string): Promise<string | undefined>;
}

/** Projeto que pode receber o card: id e para onde vai ("Loja · GitHub · dono/repo"). */
export interface CardTarget {
  id: string;
  label: string;
}

export class NewCardForm {
  readonly el: HTMLFormElement;
  private kind: CardKind = 'issue';
  private readonly kindBtns: HTMLButtonElement[];
  private readonly hint: HTMLElement;
  private readonly target: HTMLSelectElement;
  private readonly title: HTMLInputElement;
  private readonly body: HTMLTextAreaElement;
  private readonly images = new ImagePicker();
  private readonly error: HTMLElement;
  private readonly createBtn: HTMLButtonElement;
  private busy = false;

  constructor(private readonly opts: NewCardFormOptions) {
    this.kindBtns = KINDS.map((k) =>
      h('button', { class: 'ui-seg__opt', type: 'button', role: 'radio', text: kindLabel(k), attrs: { 'data-kind': k }, on: { click: () => this.setKind(k) } }),
    );
    this.hint = h('p', { class: 'ui-board-new__hint' });
    this.target = h('select', { class: 'ui-day__select ui-board-new__target', attrs: { 'aria-label': tr('Projeto do card') } });
    this.title = h('input', {
      class: 'ui-rename__input',
      type: 'text',
      attrs: { id: 'ui-board-new-title', maxlength: CARD_TITLE_MAX, placeholder: tr('Ex.: Botão de salvar não responde no celular'), autocomplete: 'off', required: true },
    });
    this.body = h('textarea', {
      class: 'ui-rename__input ui-board-new__body',
      attrs: { id: 'ui-board-new-body', rows: 6, maxlength: CARD_BODY_MAX, placeholder: tr('Detalhes: contexto, o que deve mudar, critérios para dar como pronto (opcional)') },
    });
    this.error = h('p', { class: 'ui-board-new__error', role: 'alert', hidden: true });
    this.createBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'submit' }, tr('Criar card'));
    const cancel = h('button', { class: 'ui-btn', type: 'button', text: tr('Cancelar'), on: { click: () => this.close() } });

    this.el = h(
      'form',
      { class: 'ui-board-new', hidden: true, attrs: { 'aria-label': tr('Novo card'), novalidate: true } },
      h('div', { class: 'ui-seg ui-board-new__kinds', role: 'radiogroup', attrs: { 'aria-label': tr('Tipo do card') } }, ...this.kindBtns),
      this.hint,
      h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-board-new-title' }, text: tr('Título') }),
      this.title,
      h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-board-new-body' }, text: tr('Descrição') }),
      this.body,
      this.images.el,
      this.error,
      h('div', { class: 'ui-board-new__foot' }, h('span', { class: 'ui-board-new__hint', text: tr('Vai para:') }), this.target, cancel, this.createBtn),
    );
    this.images.listen(this.el);
    this.el.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.send();
      }
    });
    this.setKind('issue');
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** `targets`: projetos que podem receber o card (com uma só opção, o seletor fica travado nela). */
  open(targets: readonly CardTarget[], selected?: string): void {
    this.target.replaceChildren(...targets.map((t) => h('option', { text: t.label, attrs: { value: t.id } })));
    if (selected && targets.some((t) => t.id === selected)) this.target.value = selected;
    this.target.disabled = targets.length < 2;
    setHidden(this.error, true);
    setHidden(this.el, false);
    this.title.focus();
  }

  close(): void {
    setHidden(this.el, true);
  }

  private setKind(k: CardKind): void {
    this.kind = k;
    for (const b of this.kindBtns) b.setAttribute('aria-checked', String(b.dataset.kind === k));
    setText(this.hint, kindHint(k));
  }

  private async send(): Promise<void> {
    if (this.busy) return;
    const title = this.title.value.trim();
    if (!title) {
      this.showError(tr('Escreva um título.'));
      this.title.focus();
      return;
    }
    this.busy = true;
    this.createBtn.disabled = true;
    setText(this.createBtn, tr('Criando…'));
    try {
      if (!this.target.value) return this.showError(tr('Escolha um projeto.'));
      let images: NewAttachment[] = [];
      try {
        images = await this.images.encode();
      } catch (err) {
        return this.showError(err instanceof Error ? err.message : String(err));
      }
      const err = await this.opts.submit({ kind: this.kind, title, body: this.body.value, ...(images.length ? { images } : {}) }, this.target.value);
      if (err) return this.showError(err);
      this.title.value = '';
      this.body.value = '';
      this.images.clear();
      this.setKind('issue');
      this.close();
    } finally {
      this.busy = false;
      this.createBtn.disabled = false;
      setText(this.createBtn, tr('Criar card'));
    }
  }

  private showError(text: string): void {
    setText(this.error, text);
    setHidden(this.error, false);
  }
}
