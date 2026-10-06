// Nomes dos personagens, persistidos por sessão/subagente em <dataDir>/names.json
// para que cada um mantenha o nome entre reinícios do servidor.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pickName, type PersonName } from '../../shared/names';
import { errMsg, log } from '../log';

interface StoredName {
  name: string;
  look: 'f' | 'm';
  at: number;
}

interface NamesFile {
  version: 1;
  names: Record<string, StoredName>;
}

const MAX_ENTRIES = 4000;
const MAX_AGE_MS = 60 * 24 * 3_600_000;

export class NameStore {
  private names = new Map<string, StoredName>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  /** `file` null = só em memória (testes ou diretório de dados indisponível). */
  constructor(
    private readonly file: string | null,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<NamesFile>;
      for (const [key, v] of Object.entries(j.names ?? {})) {
        if (v && typeof v.name === 'string' && (v.look === 'f' || v.look === 'm')) {
          this.names.set(key, { name: v.name, look: v.look, at: typeof v.at === 'number' ? v.at : 0 });
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`names.json ilegível (${errMsg(err)}); começando do zero.`);
    }
  }

  /** Nome de `key`: o persistido, se não colidir com `used`; senão um novo do pool. */
  assign(key: string, used: ReadonlySet<string>): PersonName {
    const stored = this.names.get(key);
    if (stored && !used.has(stored.name)) {
      stored.at = this.now();
      this.scheduleFlush();
      return { name: stored.name, look: stored.look };
    }
    const person = pickName(key, used);
    this.remember(key, person);
    return person;
  }

  /** Associa `person` a mais uma chave (ex.: a sessão nova depois de um /clear). */
  remember(key: string, person: PersonName): void {
    this.names.set(key, { name: person.name, look: person.look, at: this.now() });
    this.scheduleFlush();
  }

  get(key: string): PersonName | undefined {
    const s = this.names.get(key);
    return s ? { name: s.name, look: s.look } : undefined;
  }

  private scheduleFlush(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const now = this.now();
    const kept = [...this.names]
      .filter(([, v]) => now - v.at < MAX_AGE_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    this.names = new Map(kept);
    const data: NamesFile = { version: 1, names: Object.fromEntries(kept) };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.file);
      log.clearOnce('names-write');
    } catch (err) {
      log.warnOnce('names-write', `Não foi possível gravar ${this.file} (${errMsg(err)}); os nomes valem só nesta execução.`);
    }
  }
}
