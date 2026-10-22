// Imagens dos cards: conferência pelos bytes e limites, arquivos (nomes gerados, apagar), store (board.json), o pedido
// do planejador e as instruções dos agentes com os caminhos, e o fluxo de revisão do plano com imagens (CLIs falsas).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_BYTES, type BoardCard, type BoardProject, type PlanAction } from '../../shared/board';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { BoardFiles, parseImages, sniffImage, type DecodedImage } from './attachments';
import type { Exec } from './cli';
import { parseBodyImages } from './http';
import { plannerPrompt, runPlanner } from './planner';
import { taskSpec } from './runner';
import { BoardService } from './service';
import { BoardStore } from './store';

setQuiet(true);

const NOW = Date.parse('2026-10-22T12:00:00Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const b64 = (b: Buffer) => b.toString('base64');

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function tmp(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('parseImages', () => {
  it('reconhece PNG, JPEG, GIF e WebP pelos bytes', () => {
    expect([PNG, JPEG, GIF, WEBP].map(sniffImage)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });

  it('aceita as imagens com o tipo certo e limpa o nome', () => {
    const r = parseImages([
      { name: '../../etc/tela.png', type: 'image/png', data: b64(PNG) },
      { name: 'foto.jpg', type: 'image/jpg', data: b64(JPEG) },
    ]) as DecodedImage[];
    expect(r.map((i) => [i.name, i.type, i.data.length])).toEqual([
      ['tela.png', 'image/png', PNG.length],
      ['foto.jpg', 'image/jpeg', JPEG.length],
    ]);
    expect(parseImages(undefined)).toEqual([]);
  });

  it('recusa tipo que não bate com os bytes, SVG/HTML, base64 torto, vazio, demais e grande demais', () => {
    expect(parseImages([{ name: 'a.png', type: 'image/gif', data: b64(PNG) }])).toHaveProperty('error');
    expect(parseImages([{ name: 'a.svg', type: 'image/svg+xml', data: b64(Buffer.from('<svg/>')) }])).toHaveProperty('error');
    expect(parseImages([{ name: 'a.png', type: 'image/png', data: '%%%' }])).toHaveProperty('error');
    expect(parseImages([{ name: 'a.png', type: 'image/png', data: '' }])).toHaveProperty('error');
    expect(parseImages('x')).toHaveProperty('error');
    expect(parseImages(Array.from({ length: 6 }, () => ({ name: 'a.png', type: 'image/png', data: b64(PNG) })))).toHaveProperty('error');
    const big = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_BYTES)]);
    expect(parseImages([{ name: 'a.png', type: 'image/png', data: b64(big) }])).toHaveProperty('error');
    expect(() => parseBodyImages({ images: [{ name: 'a', type: 'image/png', data: b64(GIF) }] })).toThrow(/não é uma imagem/);
  });
});

describe('BoardFiles e store', () => {
  it('grava com nome gerado (600), lê só o tipo registrado e apaga', () => {
    const dir = join(tmp(), 'board-attachments');
    let n = 0;
    const files = new BoardFiles(dir, () => `00000000-0000-4000-8000-00000000000${n++}`);
    const [a, b] = files.save([
      { name: 'tela.png', type: 'image/png', data: PNG },
      { name: 'x.webp', type: 'image/webp', data: WEBP },
    ]);
    expect(a).toEqual({ id: '00000000-0000-4000-8000-000000000000', name: 'tela.png', type: 'image/png', size: PNG.length });
    expect(readdirSync(dir).sort()).toEqual(['00000000-0000-4000-8000-000000000000.png', '00000000-0000-4000-8000-000000000001.webp']);
    expect(statSync(files.path(a)!).mode & 0o777).toBe(0o600);
    expect(files.read(a)).toEqual(PNG);
    // Registro adulterado (id que não é o gerado, outro tipo): sem caminho, sem leitura.
    expect(files.path({ ...a, id: '../board' })).toBeUndefined();
    expect(files.read({ ...a, type: 'image/gif' })).toBeUndefined();
    files.remove([a, b]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('board.json guarda as imagens do card e descarta registros inválidos', () => {
    const file = join(tmp(), 'board.json');
    const store = new BoardStore(file);
    expect(store.attachmentsDir).toBe(join(file, '..', 'board-attachments'));
    const att = { id: '00000000-0000-4000-8000-000000000000', name: 'a.png', type: 'image/png' as const, size: 3 };
    store.setAttachments('p', 'github:1', [att]);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.attachments.p['github:2'] = [{ id: '../x', name: 'b', type: 'text/html', size: 1 }];
    writeFileSync(file, JSON.stringify(raw));
    const again = new BoardStore(file);
    again.load();
    expect(again.attachments('p', 'github:1')).toEqual([att]);
    expect(again.attachments('p', 'github:2')).toEqual([]);
    again.setAttachments('p', 'github:1', []);
    expect(JSON.parse(readFileSync(file, 'utf8')).attachments).toEqual({});
  });
});

describe('caminhos no planejador e nos agentes', () => {
  const project: BoardProject = { id: 'p', name: 'proj', source: 'github', github: 'o/r', path: '/p' };
  const card: BoardCard = { id: 'github:1', source: 'github', ref: '#1', title: 'Bug', body: 'b', url: 'u', kind: 'fix', column: 'backlog', labels: [], state: 'open', updatedAt: NOW };

  it('plannerPrompt lista as imagens do card e as da revisão; runPlanner libera a pasta', async () => {
    const prompt = plannerPrompt(project, card, [], { previous: { summary: 's', actions: [], createdAt: NOW, model: 'm', notes: [] }, feedback: 'mude' }, { card: ['/d/a.png'], revision: ['/d/b.png'] });
    expect(prompt).toMatch(/Imagens anexadas ao card[^\n]*\n- \/d\/a\.png/);
    expect(prompt).toMatch(/Imagens anexadas a este pedido de revisão[^\n]*\n- \/d\/b\.png/);
    expect(plannerPrompt(project, card, [])).not.toMatch(/Imagens/);
    let args: string[] = [];
    const exec: Exec = async (_bin, a) => {
      args = a;
      return JSON.stringify({ structured_output: { summary: '', actions: [] } });
    };
    await runPlanner({ claude: 'claude', cwd: '/p', model: 'sonnet', exec, addDirs: ['/d'] }, 'x');
    expect(args.slice(-2)).toEqual(['--add-dir', '/d']);
  });

  it('taskSpec lista as imagens do card e das revisões', () => {
    const action: PlanAction = { id: 'a1', title: 'A', instructions: 'faça', type: 'implementation', agent: 'claude', writes: true, deps: [], reason: '' };
    const spec = taskSpec(project, card, action, 0, 1, { path: '/wt', branch: 'b' }, { card: ['/d/a.png'], revisions: ['/d/b.png'] });
    expect(spec).toMatch(/faça\n\nImagens anexadas ao card[^\n]*\n- \/d\/a\.png\n\nImagens anexadas aos pedidos de correção[^\n]*\n- \/d\/b\.png/);
    expect(taskSpec(project, card, action, 0, 1, { path: '/wt', branch: 'b' })).not.toMatch(/Imagens/);
  });
});

describe('fluxo do serviço com imagens', () => {
  const planJson = JSON.stringify({
    structured_output: { summary: 'S', actions: [{ id: 'a1', title: 'A', instructions: 'i', type: 'implementation', agent: 'claude', writes: true, deps: [], reason: '' }] },
  });

  function setup() {
    const file = join(tmp(), 'board.json');
    const store = new BoardStore(file);
    const prompts: string[][] = [];
    const exec: Exec = async (bin, args) => {
      const cmd = args.join(' ');
      if (cmd === 'project list --json') return JSON.stringify({ ok: true, result: { projects: [{ id: 'p', displayName: 'p', sourceRepoIds: ['r'] }] } });
      if (cmd === 'repo list --json') return JSON.stringify({ ok: true, result: { repos: [{ id: 'r', path: '/p' }] } });
      if (cmd === 'linear team list --json') return JSON.stringify({ ok: false, error: { message: 'x' } });
      if (args[0] === '-C') return 'https://github.com/o/r.git';
      if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([{ number: 1, title: 'Bug', url: 'u', state: 'OPEN', updatedAt: new Date(NOW).toISOString() }]);
      if (args[0] === 'issue' && args[1] === 'create') return 'https://github.com/o/r/issues/2\n';
      if (bin === 'claude') {
        prompts.push(args);
        return planJson;
      }
      throw new Error(`inesperado: ${cmd}`);
    };
    const board = new BoardService({ store, orca: 'orca', gh: 'gh', git: 'git', exec, now: () => NOW, claude: 'claude', installed: new Set(['claude']), accounts: () => [] });
    return { board, store, prompts };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const png = (name: string): DecodedImage => ({ name, type: 'image/png', data: PNG });

  it('card novo guarda as imagens; a rota de leitura acha as do card e as das revisões; descartar apaga as das revisões', async () => {
    const { board, store, prompts } = setup();
    const created = await board.create('p', { kind: 'fix', title: 'Novo', body: '' }, [png('tela.png')]);
    expect(created && 'card' in created && created.card.attachments?.map((a) => a.name)).toEqual(['tela.png']);
    const cardAtt = store.attachments('p', 'github:2')[0];
    expect(board.attachment('p', 'github:2', cardAtt.id)?.data).toEqual(PNG);
    expect(board.attachment('p', 'github:1', cardAtt.id)).toBeUndefined();

    store.setAttachments('p', 'github:1', [cardAtt]);
    await board.plan('p', 'github:1');
    await settle();
    expect(await board.plan('p', 'github:1', undefined, [png('x.png')])).toMatchObject({ status: 400 });
    await board.plan('p', 'github:1', 'mude o botão', [png('rev.png')]);
    await settle();
    const work = store.work('p', 'github:1')!;
    expect(work.stage).toBe('approval');
    const rev = work.plan!.revisionAttachments![0][0];
    expect(rev.name).toBe('rev.png');
    const revPath = board.files.path(rev)!;
    const last = prompts.at(-1)!;
    expect(last[last.indexOf('-p') + 1]).toContain(revPath);
    expect(last[last.indexOf('-p') + 1]).toContain(board.files.path(cardAtt)!);
    expect(last.slice(-2)).toEqual(['--add-dir', board.files.dir]);
    expect(board.attachment('p', 'github:1', rev.id)?.attachment).toEqual(rev);

    await board.discard('p', 'github:1');
    expect(existsSync(revPath)).toBe(false);
    expect(existsSync(board.files.path(cardAtt)!)).toBe(true);
  });
});
