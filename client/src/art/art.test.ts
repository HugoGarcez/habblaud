// Testes das partes puras do módulo de arte (sem DOM): aparência, templates, personagens, móveis,
// pisos, paredes, ícones, temas e os desenhos por quadro (com um contexto falso).
import { describe, expect, it } from 'vitest';
import { FURNITURE, TILE, type Dir, type FloorKind, type FurnitureKind, type HeldItem, type Pose, type ScreenMode, type WallPattern } from './api';
import { appearanceFromSeed, appearanceKey } from './character/appearance';
import { HAIR, HEAD_BASE } from './character/hair';
import { CHAR_AX, CHAR_AY, CHAR_H, CHAR_W, POSE_FRAMES, renderCharacter } from './character/render';
import { drawBoard, drawClock, drawScreen, drawWindowView } from './dynamic';
import { normalizeFurniture, renderFurniture } from './furniture/index';
import { ICON_NAMES, renderIcon } from './icons';
import { CHUNK_PX, floorChunk } from './surfaces/floor';
import { southWallTile, wallFaceTile } from './surfaces/walls';
import { THEME_COUNT, roomTheme } from './theme';

const DIRS: Dir[] = ['down', 'left', 'up', 'right'];

/** Resumo FNV-1a dos bytes (para comparar imagens sem depender de Buffer/Node). */
function digest(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  let g = 0x01000193;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 0x01000193);
    g = Math.imul(g ^ data[i], 0x5bd1e995) + i;
  }
  return `${h >>> 0}:${g >>> 0}`;
}
const POSES = Object.keys(POSE_FRAMES) as Pose[];
const HELD: HeldItem[] = ['none', 'coffee', 'water', 'papers', 'laptop', 'book', 'box', 'paddle'];

describe('appearanceFromSeed', () => {
  it('é determinística', () => {
    for (const seed of [0, 1, 42, 123456, 0xffffffff]) {
      expect(appearanceFromSeed(seed)).toEqual(appearanceFromSeed(seed));
      expect(appearanceFromSeed(seed, { look: 'f', sub: true })).toEqual(appearanceFromSeed(seed, { look: 'f', sub: true }));
    }
  });

  it('gera grande variedade em 40 sementes', () => {
    const list = Array.from({ length: 40 }, (_, i) => appearanceFromSeed(i + 1));
    const distinct = (f: (a: (typeof list)[number]) => string) => new Set(list.map(f)).size;
    expect(new Set(list.map(appearanceKey)).size).toBe(40);
    expect(distinct((a) => a.hairStyle)).toBeGreaterThanOrEqual(10);
    expect(distinct((a) => a.topStyle)).toBeGreaterThanOrEqual(6);
    expect(distinct((a) => a.skin)).toBeGreaterThanOrEqual(6);
    expect(distinct((a) => a.hair)).toBeGreaterThanOrEqual(6);
    expect(distinct((a) => a.accessory)).toBeGreaterThanOrEqual(5);
  });

  it('cobre todos os estilos de cabelo e roupa ao longo de muitas sementes', () => {
    const hair = new Set<string>();
    const tops = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const a = appearanceFromSeed(i);
      hair.add(a.hairStyle);
      tops.add(a.topStyle);
    }
    expect(hair.size).toBe(14);
    expect(tops.size).toBe(7);
  });

  it('respeita look (sem barba para f) e crachá para subagentes', () => {
    for (let i = 0; i < 300; i++) {
      const f = appearanceFromSeed(i, { look: 'f' });
      expect(f.look).toBe('f');
      expect(f.facialHair ?? 'none').toBe('none');
      expect(appearanceFromSeed(i, { look: 'm' }).look).toBe('m');
      expect(appearanceFromSeed(i, { sub: true }).lanyard).toMatch(/^#/);
      expect(appearanceFromSeed(i).lanyard).toBeNull();
    }
  });
});

describe('templates de cabeça e cabelo', () => {
  const allowedHair = new Set('.ohHdDzka');
  const allowedHead = new Set('.sSLeEbmr');
  it('têm linhas de mesmo comprimento e só caracteres conhecidos', () => {
    for (const tpl of Object.values(HEAD_BASE)) {
      for (const row of tpl.rows) {
        expect(row.length).toBe(14);
        for (const ch of row) expect(allowedHead.has(ch)).toBe(true);
      }
    }
    for (const [style, views] of Object.entries(HAIR)) {
      for (const [view, layers] of Object.entries(views)) {
        for (const tpl of [layers.front, layers.back]) {
          if (!tpl) continue;
          const w = tpl.rows[0].length;
          for (const row of tpl.rows) {
            expect(row.length, `${style}/${view}`).toBe(w);
            for (const ch of row) expect(allowedHair.has(ch), `${style}/${view} '${ch}'`).toBe(true);
          }
        }
      }
    }
  });
});

describe('personagens', () => {
  const a = appearanceFromSeed(7, { sub: true });
  it('renderizam todas as poses × direções × quadros × itens', () => {
    for (const pose of POSES) {
      for (const dir of DIRS) {
        for (let frame = 0; frame < POSE_FRAMES[pose]; frame++) {
          for (const held of HELD) {
            const s = renderCharacter({ appearance: a, dir, pose, frame, held });
            expect(s.buf.w).toBe(CHAR_W);
            expect(s.buf.h).toBe(CHAR_H);
            expect(s.ax).toBe(CHAR_AX);
            expect(s.ay).toBe(CHAR_AY);
            expect(s.buf.countOpaque()).toBeGreaterThan(150);
          }
        }
      }
    }
  });

  it('em pé, os pés tocam a âncora', () => {
    for (const dir of DIRS) {
      const s = renderCharacter({ appearance: a, dir, pose: 'stand', frame: 0 });
      let feet = 0;
      for (let x = CHAR_AX - 4; x < CHAR_AX + 4; x++) if (s.buf.alpha(x, CHAR_AY - 1) > 200) feet++;
      expect(feet, dir).toBeGreaterThan(2);
    }
  });

  it('a direção direita espelha a esquerda', () => {
    const l = renderCharacter({ appearance: a, dir: 'left', pose: 'walk', frame: 1 });
    const r = renderCharacter({ appearance: a, dir: 'right', pose: 'walk', frame: 1 });
    expect(r.buf.flipped().data).toEqual(l.buf.data);
  });

  it('variações de estilo geram sprites diferentes', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const s = renderCharacter({ appearance: appearanceFromSeed(i), dir: 'down', pose: 'stand', frame: 0 });
      keys.add(digest(s.buf.data));
    }
    expect(keys.size).toBe(40);
  });
});

describe('móveis', () => {
  const kinds = Object.keys(FURNITURE) as FurnitureKind[];
  it('todos os kinds/variantes/estados renderizam com âncora e regiões coerentes', () => {
    for (const kind of kinds) {
      const def = FURNITURE[kind];
      for (const v of def.variants ?? [undefined]) {
        for (let st = 0; st < (def.states ?? 1); st++) {
          const f = renderFurniture(kind, v, st);
          for (const s of [f.base, f.front]) {
            if (!s) continue;
            expect(s.buf.countOpaque(), `${kind}/${v}/${st}`).toBeGreaterThan(8);
            // Âncora horizontal dentro do sprite; regiões dentro do buffer.
            expect(s.ax).toBeGreaterThanOrEqual(0);
            expect(s.ax).toBeLessThanOrEqual(s.buf.w);
            for (const r of Object.values(s.rects ?? {})) {
              if (!r) continue;
              expect(r.x).toBeGreaterThanOrEqual(0);
              expect(r.y).toBeGreaterThanOrEqual(0);
              expect(r.x + r.w).toBeLessThanOrEqual(s.buf.w);
              expect(r.y + r.h).toBeLessThanOrEqual(s.buf.h);
            }
          }
          if (def.mount === 'floor') {
            // O sprite não desce mais que a sombra abaixo da base nem flutua acima do footprint.
            for (const s of [f.base, f.front]) {
              if (!s) continue;
              expect(s.buf.h - s.ay, `${kind}/${v}`).toBeLessThanOrEqual(5);
              expect(s.ay - s.buf.h, `${kind}/${v}`).toBeLessThan(def.footprint.h * TILE);
            }
          } else {
            // Itens de parede ficam acima do rodapé, dentro da face (2 tiles).
            expect(f.base.ay).toBeGreaterThan(0);
            expect(f.base.ay - f.base.buf.h).toBeLessThanOrEqual(2 * TILE);
          }
        }
      }
    }
  });

  it('preenche as regiões dinâmicas pedidas pelo contrato', () => {
    expect(renderFurniture('desk', 'wood').base.rects?.screen).toBeDefined();
    expect(renderFurniture('whiteboard').base.rects?.board).toBeDefined();
    expect(renderFurniture('window').base.rects?.glass).toBeDefined();
    expect(renderFurniture('clock').base.rects?.face).toBeDefined();
    expect(renderFurniture('tv').base.rects?.tv).toBeDefined();
    expect(renderFurniture('sign').base.rects?.sign).toBeDefined();
    expect(renderFurniture('painting').base.rects?.art).toBeDefined();
    expect(renderFurniture('floor_lamp').base.rects?.glow).toBeDefined();
    const scr = renderFurniture('desk', 'white').base.rects?.screen;
    expect(scr?.w).toBe(14);
    expect(scr?.h).toBe(9);
  });

  it('assentos com encosto ao sul têm sprite `front`', () => {
    expect(renderFurniture('office_chair').front).toBeDefined();
    expect(renderFurniture('cafe_chair', 'up').front).toBeDefined();
    expect(renderFurniture('sofa', 'up').front).toBeDefined();
    expect(renderFurniture('toilet_stall', undefined, 1).front).toBeDefined();
    expect(renderFurniture('office_chair_front').front).toBeUndefined();
  });

  it('normaliza variantes, estados e sementes', () => {
    expect(normalizeFurniture('desk', 'xyz').variant).toBe('wood');
    expect(normalizeFurniture('elevator', undefined, 99).state).toBe(4);
    expect(normalizeFurniture('elevator', undefined, -3).state).toBe(0);
    expect(normalizeFurniture('desk', 'wood', 0, 13).vseed).toBe(1);
    expect(normalizeFurniture('stool', undefined, 0, 13).vseed).toBe(0);
  });
});

describe('legibilidade das mesas, sofá e olhos', () => {
  /** Luminância (0–1) do pixel (x, y) do buffer, em coordenadas do footprint do móvel. */
  function lumAt(s: { buf: { w: number; data: Uint8ClampedArray }; ax: number; ay: number }, fw: number, fh: number, fx: number, fy: number): number {
    const x = s.ax - (fw * TILE) / 2 + fx;
    const y = s.ay - fh * TILE + fy;
    const i = (y * s.buf.w + x) * 4;
    return (0.2126 * s.buf.data[i] + 0.7152 * s.buf.data[i + 1] + 0.0722 * s.buf.data[i + 2]) / 255;
  }

  it('o verso do monitor (desk_back) é plástico claro/médio, nunca escuro como tela', () => {
    for (const v of ['white', 'wood', 'dark']) {
      for (let seed = 0; seed < 4; seed++) {
        const f = renderFurniture('desk_back', v, 0, seed);
        // Centro da carcaça do monitor (x 8..23 ou 2..16 na variação 1; y -7..2).
        const cx = seed % 4 === 1 ? 6 : 13;
        const l = lumAt(f.base, 2, 1, cx, -4);
        expect(l, `${v}/${seed}`).toBeGreaterThan(v === 'dark' ? 0.45 : 0.7);
      }
    }
  });

  it('a 2ª tela (monitor/notebook) vem ligada com conteúdo e é exposta em rects.screen2', () => {
    for (const seed of [1, 2, 4]) {
      const f = renderFurniture('desk', 'wood', 0, seed);
      const r = f.base.rects?.screen2;
      expect(r, `seed ${seed}`).toBeDefined();
      if (!r) continue;
      let sum = 0;
      const colors = new Set<number>();
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = (y * f.base.buf.w + x) * 4;
          const d = f.base.buf.data;
          sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
        }
      }
      expect(sum / (r.w * r.h), `seed ${seed}`).toBeGreaterThan(0.13);
      expect(colors.size, `seed ${seed}`).toBeGreaterThan(2);
    }
    expect(renderFurniture('desk', 'wood', 0, 0).base.rects?.screen2).toBeUndefined();
  });

  it('teclado e papéis não somem na mesa branca', () => {
    // Variação 0: teclado em x 11..20, y -1..1 sobre o tampo branco.
    const f = renderFurniture('desk', 'white', 0, 0);
    const top = lumAt(f.base, 2, 1, 4, -3);
    const kb = lumAt(f.base, 2, 1, 15, 1);
    expect(top - kb).toBeGreaterThan(0.12);
  });

  it("sofá 'up' (de costas): encosto contínuo, sem as divisões de assento da frente", () => {
    const f = renderFurniture('sofa', 'up');
    const front = f.front;
    expect(front).toBeDefined();
    if (!front) return;
    // Linha no meio da face traseira: uma cor só de ponta a ponta (fora as bordas).
    const row = new Set<number>();
    for (let fx = 2; fx <= 45; fx++) row.add(Math.round(lumAt(front, 3, 1, fx, 8) * 1000));
    expect(row.size).toBe(1);
    // Os braços sobem acima do encosto (lê como "visto de trás").
    expect(lumAt(f.base, 3, 1, 2, -4)).toBeGreaterThan(0);
    expect(f.base.buf.alpha(f.base.ax - 24 + 2, f.base.ay - 16 - 4)).toBeGreaterThan(200);
  });

  it('olhos mantêm contraste com a pele em todos os tons (brilho nos tons escuros)', () => {
    const base = appearanceFromSeed(11);
    for (const skin of ['#ffe2cc', '#d69f78', '#9a6444', '#7a4a31', '#5a3623']) {
      const a = { ...base, skin, hairStyle: 'buzz' as const, accessory: 'none' as const, eyes: '#4a2f22' };
      const s = renderCharacter({ appearance: a, dir: 'down', pose: 'stand', frame: 0 });
      const d = s.buf.data;
      const lum = (x: number, y: number) => {
        const i = (y * s.buf.w + x) * 4;
        return (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      };
      // Olho esquerdo: coluna 4 da grade da cabeça (x = 9), linhas 10–11 (y = 13–14); pele ao lado (x = 8).
      const skinL = lum(8, 13);
      const contrast = Math.max(Math.abs(lum(9, 13) - skinL), Math.abs(lum(9, 14) - skinL));
      expect(contrast, skin).toBeGreaterThan(0.25);
    }
  });
});

describe('pisos e paredes', () => {
  const floors: FloorKind[] = ['carpet', 'wood', 'tile_check', 'tile_white', 'concrete', 'marble', 'grass', 'sidewalk', 'street'];
  it('blocos de piso são opacos e determinísticos', () => {
    for (const k of floors) {
      const a = floorChunk(k, 2, -1, { seed: 3, tint: '#c9d1dc', tint2: '#bdc6d3' });
      expect(a.countOpaque(), k).toBe(CHUNK_PX * CHUNK_PX);
      expect(floorChunk(k, 2, -1, { seed: 3, tint: '#c9d1dc', tint2: '#bdc6d3' }).data).toEqual(a.data);
    }
  });

  it('a madeira continua entre blocos vizinhos (sem emenda na borda)', () => {
    const left = floorChunk('wood', 0, 0, { seed: 1 });
    const right = floorChunk('wood', 1, 0, { seed: 1 });
    let differ = 0;
    for (let y = 0; y < CHUNK_PX; y++) {
      const i = (y * CHUNK_PX + CHUNK_PX - 1) * 4;
      const j = (y * CHUNK_PX) * 4;
      if (left.data[i] !== right.data[j]) differ++;
    }
    // Só as emendas reais das tábuas (poucas linhas) podem diferir.
    expect(differ).toBeLessThan(CHUNK_PX / 3);
  });

  it('paredes renderizam todos os padrões', () => {
    const patterns: WallPattern[] = ['plain', 'stripes', 'tiles', 'wood_panel', 'brick', 'glass', 'marble'];
    for (const p of patterns) {
      const face = wallFaceTile({ base: '#eef1f4', trim: '#9fb0c4', pattern: p }, 1, 0);
      expect(face.w).toBe(TILE);
      expect(face.h).toBe(2 * TILE);
      expect(face.countOpaque()).toBeGreaterThan(TILE * 10);
      expect(southWallTile({ base: '#eef1f4', pattern: p, exterior: true }, 2).countOpaque()).toBe(TILE * TILE);
    }
  });
});

describe('ícones e temas', () => {
  it('os 14 ícones existem com contorno', () => {
    expect(ICON_NAMES.length).toBe(14);
    for (const n of ICON_NAMES) {
      const s = renderIcon(n);
      expect(s.buf.w).toBeGreaterThanOrEqual(8);
      expect(s.buf.w).toBeLessThanOrEqual(13);
      expect(s.buf.countOpaque()).toBeGreaterThan(20);
    }
  });

  it('temas vizinhos são diferentes e determinísticos', () => {
    for (let i = 0; i < 30; i++) {
      expect(roomTheme(i)).toEqual(roomTheme(i));
      expect(roomTheme(i).carpet).not.toBe(roomTheme(i + 1).carpet);
      expect(roomTheme(i).accent).not.toBe(roomTheme(i + 1).accent);
    }
    expect(roomTheme(THEME_COUNT)).toEqual(roomTheme(0));
    expect(roomTheme(-1)).toEqual(roomTheme(THEME_COUNT - 1));
  });
});

describe('desenhos por quadro', () => {
  /** Contexto falso que registra os fillRect (únicas chamadas permitidas). */
  function fakeCtx() {
    const rects: [number, number, number, number][] = [];
    const ctx = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        rects.push([x, y, w, h]);
      },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, rects };
  }
  const inside = (rects: [number, number, number, number][], r: { x: number; y: number; w: number; h: number }) =>
    rects.every(([x, y, w, h]) => x >= r.x && y >= r.y && x + w <= r.x + r.w && y + h <= r.y + r.h && w > 0 && h > 0);

  it('drawScreen fica dentro do retângulo em todos os modos e tamanhos', () => {
    const modes: ScreenMode[] = ['off', 'standby', 'idle', 'code', 'terminal', 'browser', 'search', 'chat', 'docs', 'tasks', 'alert'];
    for (const r of [{ x: 10, y: 20, w: 14, h: 9 }, { x: 3, y: 4, w: 28, h: 15 }, { x: 0, y: 0, w: 10, h: 7 }]) {
      for (const m of modes) {
        for (const t of [0, 777, 12345, 99999]) {
          const { ctx, rects } = fakeCtx();
          drawScreen(ctx, r, m, t, 5);
          expect(rects.length, m).toBeGreaterThan(0);
          expect(rects.length, m).toBeLessThan(200);
          expect(inside(rects, r), `${m} ${r.w}x${r.h} t=${t}`).toBe(true);
        }
      }
    }
  });

  it('drawScreen tem custo independente de t (o mundo passa Date.now())', () => {
    // Regressão: o modo terminal percorria todas as linhas desde t = 0 (~10^9 iterações por
    // monitor com t ≈ 1,8e12), congelando o app inteiro. Agora cada chamada é O(tamanho da tela).
    const modes: ScreenMode[] = ['off', 'standby', 'idle', 'code', 'terminal', 'browser', 'search', 'chat', 'docs', 'tasks', 'alert'];
    const r = { x: 10, y: 20, w: 14, h: 9 };
    const big = 1.8e12;
    const t0 = performance.now();
    for (const m of modes) {
      for (let k = 0; k < 40; k++) {
        const { ctx, rects } = fakeCtx();
        drawScreen(ctx, r, m, big + k * 997, k);
        expect(rects.length, m).toBeGreaterThan(0);
        expect(rects.length, m).toBeLessThan(200);
        expect(inside(rects, r), `${m} t=${big + k * 997}`).toBe(true);
      }
    }
    // 440 chamadas: com o bug levava minutos; o esperado é bem abaixo de 1 s mesmo em CI lento.
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("tela 'off' é azul-marinho fosco (não quase preta) e 'standby' é azul com logo", () => {
    const fills: string[] = [];
    const ctx = {
      fillStyle: '',
      fillRect() {
        fills.push(String((ctx as { fillStyle: string }).fillStyle));
      },
    };
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1, 7), 16);
      return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
    };
    drawScreen(ctx as unknown as CanvasRenderingContext2D, { x: 0, y: 0, w: 14, h: 9 }, 'off', 0, 1);
    expect(lum(fills[0])).toBeGreaterThan(0.15);
    expect(new Set(fills).size).toBeGreaterThan(2); // fundo + reflexos
    fills.length = 0;
    drawScreen(ctx as unknown as CanvasRenderingContext2D, { x: 0, y: 0, w: 14, h: 9 }, 'standby', 0, 1);
    expect(Math.max(...fills.map(lum))).toBeGreaterThan(0.6); // logo claro
  });

  it('terminal: a linha atual avança com o tempo e digita aos poucos', () => {
    const r = { x: 0, y: 0, w: 14, h: 9 };
    const snap = (t: number) => {
      const { ctx, rects } = fakeCtx();
      drawScreen(ctx, r, 'terminal', t, 3);
      return JSON.stringify(rects);
    };
    // Determinístico e animado (o quadro muda ao longo de alguns segundos), também com t enorme.
    for (const base of [0, 1.8e12]) {
      expect(snap(base + 5000)).toBe(snap(base + 5000));
      const frames = new Set([0, 1300, 2600, 3900, 5200, 6500].map((d) => snap(base + d)));
      expect(frames.size).toBeGreaterThan(3);
    }
  });

  it('drawWindowView, drawBoard e drawClock ficam dentro do retângulo', () => {
    const r = { x: 4, y: 6, w: 24, h: 15 };
    for (const hour of [0, 3, 5.8, 7, 12, 17.5, 18.4, 19.6, 22, 23.99]) {
      for (const t of [0, 5000, 60000]) {
        const { ctx, rects } = fakeCtx();
        drawWindowView(ctx, r, hour, t, 9);
        expect(inside(rects, r), `hora ${hour}`).toBe(true);
      }
    }
    const board = { x: 2, y: 2, w: 40, h: 15 };
    const { ctx, rects } = fakeCtx();
    drawBoard(ctx, board, Array.from({ length: 30 }, (_, i) => ({ status: (['pending', 'in_progress', 'completed'] as const)[i % 3] })), 1000);
    expect(inside(rects, board)).toBe(true);
    const face = { x: 3, y: 3, w: 10, h: 10 };
    const c = fakeCtx();
    for (let h = 0; h < 24; h++) drawClock(c.ctx, face, new Date(2026, 0, 1, h, h * 2, h));
    expect(inside(c.rects, face)).toBe(true);
  });
});
