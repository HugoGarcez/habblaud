import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, PREFS_KEY, sanitizePrefs, savePrefs, worldOptionsFrom } from './prefs';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe('preferências', () => {
  it('usa o padrão sem armazenamento ou com JSON inválido', () => {
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(memoryStorage({ [PREFS_KEY]: '{oops' }))).toEqual(DEFAULT_PREFS);
  });
  it('valida campo a campo', () => {
    const p = sanitizePrefs({ showNames: false, bubbles: 'muitos', liveliness: 'lively', sound: 'sim', hiddenAccounts: ['.claude', 3] });
    expect(p.showNames).toBe(false);
    expect(p.bubbles).toBe(DEFAULT_PREFS.bubbles);
    expect(p.liveliness).toBe('lively');
    expect(p.sound).toBe(false);
    expect(p.hiddenAccounts).toEqual(['.claude']);
  });
  it('salva e carrega de volta', () => {
    const st = memoryStorage();
    savePrefs(st, { ...DEFAULT_PREFS, bubbles: 'none', feedOpen: false });
    expect(loadPrefs(st)).toEqual({ ...DEFAULT_PREFS, bubbles: 'none', feedOpen: false });
  });
  it('não quebra quando o armazenamento lança exceção', () => {
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('cheio');
      },
    };
    expect(loadPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(() => savePrefs(broken, DEFAULT_PREFS)).not.toThrow();
  });
  it('extrai só as opções do mundo', () => {
    expect(worldOptionsFrom({ ...DEFAULT_PREFS, daylight: 'day' })).toEqual({ showNames: true, bubbles: 'important', liveliness: 'normal', dayNight: false, daylight: 'day' });
    expect(worldOptionsFrom({ ...DEFAULT_PREFS, daylight: 'night' })).toMatchObject({ dayNight: true, daylight: 'night' });
  });
  it('ciclo dia/noite: valida o modo e migra o interruptor antigo', () => {
    expect(DEFAULT_PREFS.daylight).toBe('auto');
    expect(sanitizePrefs({ daylight: 'night' }).daylight).toBe('night');
    expect(sanitizePrefs({ daylight: 'meio-dia' }).daylight).toBe('auto');
    expect(sanitizePrefs({ dayNight: false }).daylight).toBe('day');
    expect(sanitizePrefs({ dayNight: true }).daylight).toBe('auto');
    expect(sanitizePrefs({ dayNight: false, daylight: 'night' }).daylight).toBe('night');
  });
  it('sons: desligados por padrão; volume e categorias validados', () => {
    expect(DEFAULT_PREFS.sound).toBe(false);
    const p = sanitizePrefs({ sound: true, sounds: { volume: 3, keys: false, elevator: 'sim' } });
    expect(p.sound).toBe(true);
    expect(p.sounds).toEqual({ volume: 1, alerts: true, keys: false, elevator: true, social: true });
    expect(sanitizePrefs({ sounds: { volume: -1 } }).sounds.volume).toBe(0);
    expect(sanitizePrefs({ sounds: 'alto' }).sounds).toEqual(DEFAULT_PREFS.sounds);
  });
});
