// Imagens dos cards do quadro (ui/board-new.ts e ui/board-detail.ts): o seletor (botão "Anexar imagens", colar com
// Ctrl+V e arrastar e soltar; miniaturas com remover; os limites do servidor conferidos já aqui) e a galeria das
// imagens já anexadas (miniaturas que abrem em tamanho maior). Quem envia é o quadro: `images` no POST, em base64.
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, ATTACHMENTS_MAX, type AttachmentType, type CardAttachment, type NewAttachment } from '../../../shared/board';
import { tr } from '../../../shared/i18n';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { fileToBase64, formatBytes } from './spawn';

const MAX_MB = ATTACHMENT_MAX_BYTES / 1024 / 1024;
const EXT: Record<AttachmentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function imageType(file: File): AttachmentType | undefined {
  const t = file.type.toLowerCase().replace('image/jpg', 'image/jpeg');
  return ATTACHMENT_TYPES.find((x) => x === t);
}

interface Picked {
  file: File;
  name: string;
  type: AttachmentType;
  url: string;
}

/** Seletor de imagens de um envio (card novo ou pedido de revisão). */
export class ImagePicker {
  readonly el: HTMLElement;
  private items: Picked[] = [];
  private readonly input: HTMLInputElement;
  private readonly thumbs: HTMLElement;
  private readonly error: HTMLElement;
  private readonly addBtn: HTMLButtonElement;

  constructor() {
    this.input = h('input', { type: 'file', hidden: true, attrs: { accept: ATTACHMENT_TYPES.join(','), multiple: true } });
    this.input.addEventListener('change', () => {
      this.add([...(this.input.files ?? [])]);
      this.input.value = '';
    });
    this.addBtn = h('button', { class: 'ui-btn ui-board-img__add', type: 'button', on: { click: () => this.input.click() } });
    const clip = h('span', { attrs: { 'aria-hidden': 'true' } });
    clip.innerHTML = ICONS.attach;
    this.addBtn.append(clip, h('span', { text: tr('Anexar imagens') }));
    this.thumbs = h('ul', { class: 'ui-board-img__thumbs', hidden: true, attrs: { 'aria-label': tr('Imagens a enviar') } });
    this.error = h('p', { class: 'ui-board-new__error', role: 'alert', hidden: true });
    this.el = h(
      'div',
      { class: 'ui-board-img' },
      h(
        'div',
        { class: 'ui-board-img__bar' },
        this.addBtn,
        h('span', { class: 'ui-board-new__hint', text: tr('PNG, JPEG, GIF ou WebP, até {0} MB cada, no máximo {1}. Dá para colar (Ctrl+V) ou arrastar.', [MAX_MB, ATTACHMENTS_MAX]) }),
        this.input,
      ),
      this.thumbs,
      this.error,
    );
    this.listen(this.el);
  }

  get count(): number {
    return this.items.length;
  }

  /** Aceita colar (Ctrl+V) e soltar imagens também em `target` (o formulário ou o campo de texto). */
  listen(target: HTMLElement): void {
    target.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return;
      e.preventDefault();
      this.add(files);
    });
    target.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      this.el.classList.add('is-drop');
    });
    target.addEventListener('dragleave', (e) => {
      if (!target.contains(e.relatedTarget as Node | null)) this.el.classList.remove('is-drop');
    });
    target.addEventListener('drop', (e) => {
      this.el.classList.remove('is-drop');
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      this.add(files);
    });
  }

  /** Confere tipo, tamanho e quantidade; as que passam entram, as outras viram mensagem. */
  add(files: readonly File[]): void {
    const errors: string[] = [];
    for (const file of files) {
      const name = file.name || tr('imagem');
      const type = imageType(file);
      if (!type) errors.push(tr('{0} não é uma imagem PNG, JPEG, GIF ou WebP.', [name]));
      else if (file.size > ATTACHMENT_MAX_BYTES) errors.push(tr('{0} tem {1}: o máximo é {2} MB por imagem.', [name, formatBytes(file.size), MAX_MB]));
      else if (!file.size) errors.push(tr('{0} está vazia.', [name]));
      else if (this.items.length >= ATTACHMENTS_MAX) {
        errors.push(tr('No máximo {0} imagens por envio.', [ATTACHMENTS_MAX]));
        break;
      } else {
        // Imagem colada vem como "image.png": um nome que diz de onde veio.
        const pasted = !file.name || /^image\.\w+$/.test(file.name);
        this.items.push({ file, type, name: pasted ? `${tr('imagem-colada')}-${this.items.length + 1}.${EXT[type]}` : file.name, url: URL.createObjectURL(file) });
      }
    }
    setText(this.error, errors.join(' '));
    setHidden(this.error, !errors.length);
    this.refresh();
  }

  /** Esvazia (depois de enviar, ou ao trocar de card). */
  clear(): void {
    for (const it of this.items) URL.revokeObjectURL(it.url);
    this.items = [];
    setHidden(this.error, true);
    this.refresh();
  }

  /** As imagens para o corpo do POST. */
  async encode(): Promise<NewAttachment[]> {
    return Promise.all(this.items.map(async (it) => ({ name: it.name, type: it.type, data: await fileToBase64(it.file) })));
  }

  private remove(i: number): void {
    const [gone] = this.items.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    setHidden(this.error, true);
    this.refresh();
    this.addBtn.focus();
  }

  /** Redesenha as miniaturas (e reabilita os botões que o detalhe desliga durante um envio). */
  refresh(): void {
    this.addBtn.disabled = this.items.length >= ATTACHMENTS_MAX;
    setHidden(this.thumbs, !this.items.length);
    this.thumbs.replaceChildren(
      ...this.items.map((it, i) =>
        h(
          'li',
          { class: 'ui-board-img__thumb', title: `${it.name} · ${formatBytes(it.file.size)}` },
          h('img', { attrs: { src: it.url, alt: it.name } }),
          iconButton(ICONS.close, tr('Remover {0}', [it.name]), () => this.remove(i), 'ui-icon-btn--sm ui-board-img__remove'),
        ),
      ),
    );
  }
}

let viewer: HTMLDialogElement | null = null;

/** Abre a imagem em tamanho maior (por cima do quadro; Esc ou clique fecha). */
function openViewer(url: string, name: string): void {
  if (!viewer) {
    viewer = h('dialog', { class: 'ui-board-img__viewer', attrs: { 'aria-label': tr('Imagem anexada') } });
    viewer.addEventListener('click', (e) => {
      if (!(e.target instanceof HTMLAnchorElement)) viewer?.close();
    });
    viewer.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(viewer);
  }
  const close = iconButton(ICONS.close, tr('Fechar (Esc)'), () => viewer?.close(), 'ui-icon-btn--sm ui-board-img__viewer-close');
  viewer.replaceChildren(
    h('img', { attrs: { src: url, alt: name } }),
    h('div', { class: 'ui-board-img__viewer-bar' }, h('span', { text: name }), h('a', { class: 'ui-link-btn', text: tr('Abrir em nova aba ↗'), attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } }), close),
  );
  if (!viewer.open) viewer.showModal();
  close.focus();
}

/** Miniaturas das imagens já anexadas; `url` dá o endereço de cada uma (GET .../attachments/:id). */
export function attachmentGallery(list: readonly CardAttachment[], url: (a: CardAttachment) => string | undefined, label: string): HTMLElement | null {
  const shown = list.flatMap((a) => {
    const src = url(a);
    return src ? [{ a, src }] : [];
  });
  if (!shown.length) return null;
  return h(
    'ul',
    { class: 'ui-board-img__thumbs ui-board-img__gallery', attrs: { 'aria-label': label } },
    ...shown.map(({ a, src }) =>
      h(
        'li',
        { class: 'ui-board-img__thumb' },
        h(
          'button',
          { class: 'ui-board-img__open', type: 'button', title: `${a.name} · ${formatBytes(a.size)}`, attrs: { 'aria-label': tr('Ampliar {0}', [a.name]) }, on: { click: () => openViewer(src, a.name) } },
          h('img', { attrs: { src, alt: a.name, loading: 'lazy' } }),
        ),
      ),
    ),
  );
}
