// Upload e entrega de imagens pelas rotas reais do quadro; HTTP local, arquivos temporários e CLIs falsas.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_MAX, type BoardCard, type BoardView, type CardPlan } from '../../shared/board';
import { createRequestGuard } from '../http/guard';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import type { Exec } from './cli';
import { createBoardRoutes } from './http';
import { BoardService } from './service';
import { BoardStore } from './store';

setQuiet(true);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const upload = (data = PNG, type = 'image/png', name = 'tela.png') => ({ name, type, data: data.toString('base64') });
const ROOT = '/api/board/projects/p';
const CARD = `${ROOT}/cards/github%3A1`;
const plan: CardPlan = { summary: 'S', model: 'sonnet', createdAt: 1, notes: [], actions: [{ id: 'a1', title: 'A', instructions: 'faça', type: 'implementation', agent: 'claude', writes: true, deps: [], reason: '' }] };
let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

async function setup() {
  const tmp = tempDir();
  // Duas camadas dentro da pasta temporária: ../../x.png também ficaria no sandbox do teste.
  const store = new BoardStore(join(tmp.dir, 'data', 'board.json'));
  const calls: string[][] = [];
  let created = false;
  const exec: Exec = async (bin, args) => {
    calls.push([bin, ...args]);
    const cmd = args.join(' ');
    if (cmd === 'project list --json') return JSON.stringify({ ok: true, result: { projects: [{ id: 'p', displayName: 'p', sourceRepoIds: ['r'] }] } });
    if (cmd === 'repo list --json') return JSON.stringify({ ok: true, result: { repos: [{ id: 'r', path: '/p' }] } });
    if (cmd === 'linear team list --json') return JSON.stringify({ ok: false, error: { message: 'x' } });
    if (bin === 'git') return 'https://github.com/o/r.git';
    if (args[0] === 'issue' && args[1] === 'create') {
      created = true;
      return 'https://github.com/o/r/issues/1\n';
    }
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(created ? [{ number: 1, title: 'Novo', url: 'u', state: 'OPEN', updatedAt: new Date().toISOString() }] : []);
    if (args[0] === 'issue' && args[1] === 'view') return JSON.stringify({ title: 'Novo', body: 'Demanda', labels: [] });
    if (bin === 'claude') return JSON.stringify({ structured_output: plan });
    throw new Error(`inesperado: ${bin} ${cmd}`);
  };
  const board = new BoardService({ store, exec, orca: 'orca', gh: 'gh', git: 'git', claude: 'claude', installed: new Set(['claude']), accounts: () => [] });
  const routes = createBoardRoutes(board);
  const guard = createRequestGuard();
  const server = createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://localhost');
    routes(req, res, url.pathname, url);
  });
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => { tmp.cleanup(); resolve(); });
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) => fetch(base + path);
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const create = (images: unknown) => post(`${ROOT}/cards`, { kind: 'fix', title: 'Novo', body: 'Demanda', images });
  return { board, store, calls, get, post, create, dir: tmp.dir };
}

describe('imagens dos cards por HTTP', () => {
  it('cria com PNG/JPEG, persiste bytes e metadados, lista e entrega cada imagem com o tipo certo', async () => {
    const { board, store, create, get, dir } = await setup();
    const response = await create([upload(PNG, 'image/png', '../../x.png'), upload(JPEG, 'image/jpeg', 'foto.jpg')]);
    expect(response.status).toBe(201);
    const card = await response.json() as BoardCard;
    expect(card.attachments).toHaveLength(2);
    expect(card.attachments!.map((a) => [a.name, a.type, a.size])).toEqual([['x.png', 'image/png', PNG.length], ['foto.jpg', 'image/jpeg', JPEG.length]]);
    const listing = await get(`${ROOT}?refresh=1`);
    expect(listing.status).toBe(200);
    expect((await listing.json() as BoardView).cards.find((c) => c.id === card.id)?.attachments).toEqual(card.attachments);
    const again = new BoardStore(join(dir, 'data', 'board.json'));
    again.load();
    expect(again.attachments('p', card.id)).toEqual(card.attachments);
    for (const [i, attachment] of card.attachments!.entries()) {
      const path = board.files.path(attachment)!;
      expect(dirname(path)).toBe(store.attachmentsDir);
      expect(readFileSync(path)).toEqual([PNG, JPEG][i]);
      const image = await get(`${CARD}/attachments/${attachment.id}`);
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe(attachment.type);
      expect(image.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await image.arrayBuffer())).toEqual([PNG, JPEG][i]);
    }
    expect(readdirSync(store.attachmentsDir)).toHaveLength(2);
    expect(existsSync(join(dir, 'x.png'))).toBe(false);
    expect(existsSync(join(dir, 'data', 'x.png'))).toBe(false);
  });

  it('GET de id inexistente, outro card ou outro projeto devolve 404', async () => {
    const { create, get } = await setup();
    const card = await (await create([upload()])).json() as BoardCard;
    const id = card.attachments![0].id;
    for (const path of [`${CARD}/attachments/00000000-0000-4000-8000-000000000000`, `${ROOT}/cards/github%3A2/attachments/${id}`, `/api/board/projects/outro/cards/github%3A1/attachments/${id}`]) {
      const response = await get(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toHaveProperty('error');
    }
  });

  it.each(['tipo inválido', 'magic bytes diferentes', 'quantidade', 'tamanho'])('recusa %s antes de criar issue ou gravar anexos', async (scenario) => {
    const { create, calls, store } = await setup();
    const images = scenario === 'tipo inválido' ? [upload(Buffer.from('<svg/>'), 'image/svg+xml')]
      : scenario === 'magic bytes diferentes' ? [upload(JPEG, 'image/png')]
      : scenario === 'quantidade' ? Array.from({ length: ATTACHMENTS_MAX + 1 }, () => upload())
      : [upload(Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1 - PNG.length)]))];
    const response = await create(images);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty('error');
    expect(calls.some((c) => c[1] === 'issue' && c[2] === 'create')).toBe(false);
    expect(existsSync(store.attachmentsDir)).toBe(false);
    expect(store.attachments('p', 'github:1')).toEqual([]);
  });

  it('revisão por HTTP guarda imagens no plano e entrega os caminhos reais ao planejador', async () => {
    const { create, post, get, board, store, calls, dir } = await setup();
    const card = await (await create([upload()])).json() as BoardCard;
    store.setWork('p', card.id, { stage: 'approval', plan, updatedAt: 1 });
    const response = await post(`${CARD}/plan`, { feedback: 'Use esta foto', images: [upload(JPEG, 'image/jpeg', 'revisao.jpg')] });
    expect(response.status).toBe(202);
    await response.json();
    await vi.waitFor(() => expect(store.work('p', card.id)?.stage).toBe('approval'));
    const revised = store.work('p', card.id)!.plan!;
    expect(revised.revisions).toEqual(['Use esta foto']);
    expect(revised.revisionAttachments).toHaveLength(1);
    expect(revised.revisionAttachments![0]).toHaveLength(1);
    const attachment = revised.revisionAttachments![0][0];
    expect(attachment).toMatchObject({ name: 'revisao.jpg', type: 'image/jpeg', size: JPEG.length });
    expect(readFileSync(board.files.path(attachment)!)).toEqual(JPEG);
    const again = new BoardStore(join(dir, 'data', 'board.json'));
    again.load();
    expect(again.work('p', card.id)?.plan?.revisionAttachments).toEqual(revised.revisionAttachments);
    const planner = calls.find((c) => c[0] === 'claude')!;
    const prompt = planner[planner.indexOf('-p') + 1];
    expect(prompt).toContain(board.files.path(card.attachments![0])!);
    expect(prompt).toContain(board.files.path(attachment)!);
    const image = await get(`${CARD}/attachments/${attachment.id}`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(JPEG);
  });
});
