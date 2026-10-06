// Preferências da interface, persistidas em localStorage ('codetown:prefs').
// Puro: o armazenamento é injetado (testável em node).
import type { WorldOptions } from '../world/api';
import { DEFAULT_WORLD_OPTIONS } from '../world/api';

export const PREFS_KEY = 'codetown:prefs';

export interface UiPrefs {
  showNames: boolean;
  bubbles: WorldOptions['bubbles'];
  liveliness: WorldOptions['liveliness'];
  dayNight: boolean;
  /** Sons sintetizados (ding para alerta, pop para conclusão). */
  sound: boolean;
  /** Notification do navegador para alertas com a aba oculta. */
  browserNotifications: boolean;
  sidebarOpen: boolean;
  feedOpen: boolean;
  /** Contas ocultas na barra lateral (AccountInfo.id). */
  hiddenAccounts: string[];
}

export const DEFAULT_PREFS: UiPrefs = {
  showNames: DEFAULT_WORLD_OPTIONS.showNames,
  bubbles: DEFAULT_WORLD_OPTIONS.bubbles,
  liveliness: DEFAULT_WORLD_OPTIONS.liveliness,
  dayNight: DEFAULT_WORLD_OPTIONS.dayNight,
  sound: false,
  browserNotifications: false,
  sidebarOpen: true,
  feedOpen: true,
  hiddenAccounts: [],
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Valida campo a campo: valores desconhecidos ou corrompidos caem no padrão. */
export function sanitizePrefs(raw: unknown): UiPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PREFS;
  return {
    showNames: bool(o.showNames, d.showNames),
    bubbles: oneOf(o.bubbles, ['all', 'important', 'none'] as const, d.bubbles),
    liveliness: oneOf(o.liveliness, ['calm', 'normal', 'lively'] as const, d.liveliness),
    dayNight: bool(o.dayNight, d.dayNight),
    sound: bool(o.sound, d.sound),
    browserNotifications: bool(o.browserNotifications, d.browserNotifications),
    sidebarOpen: bool(o.sidebarOpen, d.sidebarOpen),
    feedOpen: bool(o.feedOpen, d.feedOpen),
    hiddenAccounts: Array.isArray(o.hiddenAccounts) ? o.hiddenAccounts.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
  };
}

export function loadPrefs(storage: StorageLike | null): UiPrefs {
  if (!storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(PREFS_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(storage: StorageLike | null, prefs: UiPrefs): void {
  if (!storage) return;
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Armazenamento cheio ou bloqueado (aba anônima): as preferências valem só nesta sessão.
  }
}

/** Parte das preferências que o mundo (canvas) consome. */
export function worldOptionsFrom(p: UiPrefs): Partial<WorldOptions> {
  return { showNames: p.showNames, bubbles: p.bubbles, liveliness: p.liveliness, dayNight: p.dayNight };
}

/** localStorage com proteção contra navegadores que lançam exceção ao acessá-lo. */
export function safeLocalStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
