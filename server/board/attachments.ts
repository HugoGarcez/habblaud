// Imagens anexadas aos cards do quadro (ao criar o card e ao pedir revisão do plano). Chegam em base64 no corpo JSON
// (o guard exige JSON em todo POST: CSRF), são conferidas pelos bytes (PNG, JPEG, GIF ou WebP; o tipo enviado não
// vale) e ficam em <dataDir>/board-attachments/<uuid>.<ext> (pasta 700, arquivos 600). O nome enviado só é mostrado:
// o caminho sai do id gerado e da extensão do tipo conferido, então não há como apontar para fora da pasta.
// O planejador e os agentes recebem os caminhos absolutos para abrir as imagens.
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, ATTACHMENTS_MAX, type AttachmentType, type CardAttachment } from '../../shared/board';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { safeFileName } from '../spawn/attachments';

/** Corpo de um POST com imagens: o máximo de imagens em base64 (4/3) e folga para o resto do JSON. */
export const BOARD_IMAGES_BODY_MAX = Math.ceil((ATTACHMENTS_MAX * ATTACHMENT_MAX_BYTES * 4) / 3) + 256 * 1024;

const EXT: Record<AttachmentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DecodedImage {
  name: string;
  type: AttachmentType;
  data: Buffer;
}

/** Tipo da imagem pelos primeiros bytes (magic bytes); undefined = não é PNG, JPEG, GIF nem WebP. */
export function sniffImage(data: Buffer): AttachmentType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

export function isAttachment(v: unknown): v is CardAttachment {
  const a = v as Partial<CardAttachment> | null;
  return !!a && typeof a.id === 'string' && ID.test(a.id) && ATTACHMENT_TYPES.includes(a.type as AttachmentType) && typeof a.name === 'string' && typeof a.size === 'number';
}

/**
 * Confere `images` do corpo: lista de {name, type, data (base64)}, até ATTACHMENTS_MAX, cada uma até
 * ATTACHMENT_MAX_BYTES, só PNG/JPEG/GIF/WebP (o `type` enviado precisa bater com os bytes). Ausente = [].
 */
export function parseImages(raw: unknown): DecodedImage[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: tr('esperado images: [{name, type, data}]') };
  if (raw.length > ATTACHMENTS_MAX) return { error: tr('no máximo {0} imagens por envio', [ATTACHMENTS_MAX]) };
  const out: DecodedImage[] = [];
  for (const item of raw) {
    const r = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const name = safeFileName(typeof r.name === 'string' ? r.name : '');
    if (typeof r.data !== 'string' || !r.data) return { error: tr('imagem vazia: {0}', [name]) };
    // Base64 de até ATTACHMENT_MAX_BYTES: confere o tamanho antes de decodificar.
    if (r.data.length > Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 4) return { error: tr('a imagem {0} passa de {1} MB', [name, ATTACHMENT_MAX_BYTES / 1024 / 1024]) };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: tr('imagem ilegível (base64): {0}', [name]) };
    const data = Buffer.from(r.data, 'base64');
    if (!data.length) return { error: tr('imagem vazia: {0}', [name]) };
    if (data.length > ATTACHMENT_MAX_BYTES) return { error: tr('a imagem {0} passa de {1} MB', [name, ATTACHMENT_MAX_BYTES / 1024 / 1024]) };
    const type = sniffImage(data);
    const declared = typeof r.type === 'string' ? r.type.trim().toLowerCase().replace('image/jpg', 'image/jpeg') : '';
    if (!type || declared !== type) return { error: tr('{0} não é uma imagem PNG, JPEG, GIF ou WebP', [name]) };
    out.push({ name, type, data });
  }
  return out;
}

/** Os arquivos das imagens, numa pasta só do quadro. */
export class BoardFiles {
  constructor(
    readonly dir: string,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** Grava as imagens (nomes gerados) e devolve os anexos, na ordem. Se uma falhar, apaga as já gravadas. */
  save(images: readonly DecodedImage[]): CardAttachment[] {
    if (!images.length) return [];
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const saved: CardAttachment[] = [];
    try {
      for (const img of images) {
        const a: CardAttachment = { id: this.newId(), name: img.name, type: img.type, size: img.data.length };
        writeFileSync(this.path(a)!, img.data, { mode: 0o600, flag: 'wx' });
        saved.push(a);
      }
    } catch (err) {
      this.remove(saved);
      throw err;
    }
    return saved;
  }

  /** Caminho absoluto do arquivo (só de anexos válidos: id gerado e tipo conhecido). */
  path(a: CardAttachment): string | undefined {
    return isAttachment(a) ? join(this.dir, `${a.id}.${EXT[a.type]}`) : undefined;
  }

  /** Conteúdo do anexo, só se os bytes ainda são do tipo registrado. */
  read(a: CardAttachment): Buffer | undefined {
    const p = this.path(a);
    if (!p) return undefined;
    try {
      const data = readFileSync(p);
      return sniffImage(data) === a.type ? data : undefined;
    } catch {
      return undefined;
    }
  }

  remove(list: readonly CardAttachment[] | undefined): void {
    for (const a of list ?? []) {
      const p = this.path(a);
      if (!p) continue;
      try {
        rmSync(p, { force: true });
      } catch (err) {
        log.warn(`Quadro: não deu para apagar ${p} (${errMsg(err)}).`);
      }
    }
  }
}

/** Trecho do pedido (planejador ou agente) com os caminhos das imagens; vazio sem imagens. */
export function imagesNote(paths: readonly string[], head: string): string[] {
  return paths.length ? ['', head, ...paths.map((p) => `- ${p}`)] : [];
}
