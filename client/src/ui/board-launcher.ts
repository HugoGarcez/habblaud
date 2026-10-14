// Botão "Tarefas" da barra superior. O quadro (ui/board.ts) fica num pedaço separado do bundle e só é baixado na
// primeira abertura. Só aparece quando o servidor tem o quadro e a página é a do próprio computador (access().board).
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import type { BoardPanel } from './board';
import { iconButton, setHidden } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

export class BoardLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private panel: BoardPanel | null = null;
  private loading: Promise<BoardPanel> | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly mount: (el: HTMLElement) => void,
  ) {
    this.button = iconButton(ICONS.board, tr('Tarefas: quadro dos projetos do Orca (K)'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.hidden = true;
  }

  get available(): boolean {
    return !!access().board && !this.ctx.store.mock && !this.ctx.store.replaying;
  }

  toggle(): void {
    if (!this.available) return;
    if (this.panel) this.panel.toggle();
    else this.open();
  }

  /** Abre no projeto pedido (ex.: o da sala). */
  open(projectId?: string): void {
    if (!this.available) return;
    void this.load()
      .then((p) => p.open(projectId))
      .catch(() => this.ctx.announce(tr('Não foi possível abrir o quadro de tarefas.')));
  }

  render(): void {
    setHidden(this.button, !this.available);
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
