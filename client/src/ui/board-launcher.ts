// Botão "Tarefas" da barra superior e os avisos do quadro. O quadro (ui/board.ts) fica num pedaço separado do bundle
// e só é baixado na primeira abertura. Só aparece quando o servidor tem o quadro e a página é a do próprio computador
// (access().board).
//
// Avisos: o snapshot traz os cards que precisam de você (meta.board.attention: pergunta de um agente, plano pronto,
// card travado, PR aberto). Cada item novo vira um aviso; clicar abre o card. Os que já estavam lá quando a página
// abriu não avisam (só os que surgem depois).
import type { AttentionReason, BoardAttention } from '../../../shared/board';
import type { Notice, NoticeLevel } from '../../../shared/types';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import type { BoardPanel } from './board';
import { iconButton, setHidden } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

function attentionText(a: BoardAttention): string {
  const card = a.title ? `${a.ref} ${a.title}` : a.ref;
  switch (a.reason) {
    case 'question':
      return tr('Um agente perguntou algo no card {0}', [card]);
    case 'approval':
      return tr('Plano pronto para aprovar: {0}', [card]);
    case 'blocked':
      return tr('Card travado: {0}', [card]);
    case 'review':
      return tr('PR aberto para revisão: {0}', [card]);
  }
}

const LEVEL: Record<AttentionReason, NoticeLevel> = { question: 'warn', approval: 'info', blocked: 'warn', review: 'success' };

export class BoardLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private panel: BoardPanel | null = null;
  private loading: Promise<BoardPanel> | null = null;
  /** Avisos já vistos (projeto|card|motivo|quando); null = ainda não leu o primeiro snapshot. */
  private seen: Set<string> | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly mount: (el: HTMLElement) => void,
    private readonly notify: (n: Notice) => void,
  ) {
    this.button = iconButton(ICONS.board, tr('Tarefas: quadro dos projetos do Orca (K)'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.hidden = true;
    ctx.board = {
      available: () => this.available,
      open: (projectId, card) => this.open(projectId, card),
      openForPath: (path) => {
        if (!this.available) return;
        void this.load()
          .then((p) => p.openForPath(path))
          .catch(() => this.ctx.announce(tr('Não foi possível abrir o quadro de tarefas.')));
      },
    };
  }

  get available(): boolean {
    return !!access().board && !this.ctx.store.mock && !this.ctx.store.replaying;
  }

  toggle(): void {
    if (!this.available) return;
    if (this.panel) this.panel.toggle();
    else this.open();
  }

  /** Abre em todos os projetos, ou no projeto (e no card) pedido. */
  open(projectId?: string, card?: string): void {
    if (!this.available) return;
    void this.load()
      .then((p) => p.open(projectId, card))
      .catch(() => this.ctx.announce(tr('Não foi possível abrir o quadro de tarefas.')));
  }

  render(): void {
    setHidden(this.button, !this.available);
    this.watchAttention();
  }

  private watchAttention(): void {
    const list = this.ctx.store.snapshot?.meta.board?.attention;
    if (!list || !this.available) return;
    const keys = list.map((a) => `${a.projectId}|${a.cardId}|${a.reason}|${a.at}`);
    if (!this.seen) {
      this.seen = new Set(keys);
      return;
    }
    list.forEach((a, i) => {
      if (this.seen!.has(keys[i])) return;
      this.seen!.add(keys[i]);
      this.notify({ id: `board:${keys[i]}`, level: LEVEL[a.reason], text: attentionText(a), board: { projectId: a.projectId, card: `${a.projectId}|${a.cardId}` }, at: a.at });
    });
  }

  private load(): Promise<BoardPanel> {
    this.loading ??= import('./board').then((m) => {
      const panel = new m.BoardPanel(this.ctx, this.button);
      this.mount(panel.el);
      this.panel = panel;
      return panel;
    });
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }
}
