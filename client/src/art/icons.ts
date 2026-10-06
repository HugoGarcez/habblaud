// Ícones pixel art de estado (acima da cabeça), puros. Templates ASCII com contorno automático.
import type { IconName } from './api';
import { PixelBuf, type Palette } from './core/pixbuf';
import type { BufSprite } from './core/sprite';

interface IconDef {
  rows: readonly string[];
  pal: Palette;
}

const ICONS: Readonly<Record<IconName, IconDef>> = {
  alert: {
    rows: [
      '....o....',
      '...oyo...',
      '...yky...',
      '..yykyy..',
      '..yykyy..',
      '.yyykyyy.',
      '.yyyyyyy.',
      'yyyykyyyy',
      'ddddddddd',
    ],
    pal: { o: '#fff2a8', y: '#f7c843', k: '#4a3510', d: '#d9a12a' },
  },
  question: {
    rows: [
      '..bbbbb..',
      '.bbwwwbb.',
      'bbwbbbwbb',
      'bbbbbbwbb',
      'bbbbbwbbb',
      'bbbbwbbbb',
      'bbbbbbbbb',
      '.bbbwbbb.',
      '..ddddd..',
    ],
    pal: { b: '#4f8fe6', w: '#ffffff', d: '#3466b8' },
  },
  zzz: {
    rows: [
      '.....zzzz',
      '.......z.',
      '......z..',
      'zzz..zzzz',
      '..z......',
      '.z.......',
      'zzz......',
    ],
    pal: { z: '#cfe3ff' },
  },
  check: {
    rows: [
      '..ggggg..',
      '.ggggggg.',
      'gggggggwg',
      'ggggggwwg',
      'gwggggwgg',
      'gwwggwwgg',
      'ggwwwwggg',
      '.ggwwggg.',
      '..ddddd..',
    ],
    pal: { g: '#45b866', w: '#ffffff', d: '#2f8a4a' },
  },
  heart: {
    rows: [
      '.rr...rr.',
      'rhrr.rrrr',
      'rhrrrrrrr',
      'rrrrrrrrr',
      '.rrrrrrd.',
      '..rrrrd..',
      '...rrd...',
      '....d....',
    ],
    pal: { r: '#ef5a6f', h: '#ffb3bf', d: '#c23a50' },
  },
  coffee: {
    rows: [
      '..s..s...',
      '.s..s....',
      '..s..s...',
      'wwwwwww..',
      'wccccchhh',
      'wrrrrrw.h',
      'wrrrrrwhh',
      'wwwwwww..',
      '.ddddd...',
    ],
    pal: { s: '#e6ecf5', w: '#f4f2ee', c: '#6b4226', r: '#e2604f', h: '#d6d2c8', d: '#b9b3a6' },
  },
  music: {
    rows: [
      '...nnnnnn',
      '...nhhhhn',
      '...n....n',
      '...n....n',
      '...n....n',
      '.nnn..nnn',
      'nnnn.nnnn',
      '.nn...nn.',
    ],
    pal: { n: '#8d66cf', h: '#b89aea' },
  },
  idea: {
    rows: [
      '..yyyyy..',
      '.yhhyyyy.',
      'yhhyyyyyy',
      'yhyyyyyyy',
      'yyyyyyyyd',
      '.yyyyyyd.',
      '..yyyyd..',
      '..ggggg..',
      '...ggg...',
    ],
    pal: { y: '#ffd84d', h: '#fff4b8', d: '#e0b12e', g: '#9aa2ae' },
  },
  sweat: {
    rows: [
      '...b...',
      '...b...',
      '..bbb..',
      '.bwbbb.',
      '.bwbbb.',
      'bbbbbbb',
      '.bbbbd.',
      '..ddd..',
    ],
    pal: { b: '#6fc3f2', w: '#e6f6ff', d: '#3f9ad6' },
  },
  star: {
    rows: [
      '....y....',
      '...yhy...',
      '...yhy...',
      'yyyyhyyyy',
      '.yyyyyyy.',
      '..yyyyy..',
      '..yyyyy..',
      '.yyd.dyy.',
      '.yd...dy.',
    ],
    pal: { y: '#ffcf3f', h: '#fff2a8', d: '#d99e1f' },
  },
  lightning: {
    rows: [
      '....yyy',
      '...yyy.',
      '..yyy..',
      '.yyyyyy',
      '...yyy.',
      '..yyy..',
      '.yyd...',
      '.yd....',
      'yd.....',
    ],
    pal: { y: '#ffd84d', d: '#e0a62e' },
  },
  chat: {
    rows: [
      '.wwwwwwww.',
      'wwwwwwwwww',
      'wwkwwkwwkw',
      'wwwwwwwwww',
      '.wwwwwwww.',
      '..ww......',
      '.w........',
    ],
    pal: { w: '#ffffff', k: '#5b6b85' },
  },
  box: {
    rows: [
      '.hhhtthhh.',
      'hhhhtthhhh',
      'ccccttcccc',
      'cccctttccd',
      'ccccccccdd',
      'cccllllccd',
      'ccccccccdd',
      '.ddddddddd',
    ],
    pal: { h: '#e2b47a', c: '#c99a5e', t: '#f1dfb6', l: '#8b6a43', d: '#a87b45' },
  },
  wave: {
    rows: [
      '..s.s.s..',
      '..s.s.s.s',
      '..s.s.s.s',
      's.sssssss',
      'sssssssss',
      '.sssssssd',
      '..ssssssd',
      '...ssssd.',
    ],
    pal: { s: '#ffd2a8', d: '#e0a87a' },
  },
};

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Ícone com contorno; âncora no centro inferior. */
export function renderIcon(name: IconName): BufSprite {
  const def = ICONS[name];
  const w = Math.max(...def.rows.map((r) => r.length));
  const h = def.rows.length;
  const b = new PixelBuf(w + 2, h + 2);
  b.stamp(def.rows, 1, 1, def.pal);
  b.outline();
  return { buf: b, ax: Math.floor((w + 2) / 2), ay: h + 2 };
}

export function iconTemplates(): Readonly<Record<IconName, IconDef>> {
  return ICONS;
}
