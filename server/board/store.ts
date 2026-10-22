// Estado do quadro em <dataDir>/board.json: a configuração de cada projeto (fonte dos cards e time do Linear) e o que
// o Promp IA está fazendo com cada card (CardWork: planejamento, plano, aprovação).
// Gravação atômica (arquivo temporário + rename), como o names.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CARD_STAGES, type BoardProjectConfig, type BoardSource, type CardWork } from '../../shared/board';
import { errMsg, log } from '../log';

interface BoardFile {
  version: 1;
  projects: Record<string, BoardProjectConfig>;
  /** projeto → card → trabalho. */
  cards: Record<string, Record<string, CardWork>>;
  /** projeto → handle do terminal coordenador no Orca. */
  coordinators: Record<string, string>;
}

function isWork(v: unknown): v is CardWork {
  const w = v as Partial<CardWork> | null;
  return !!w && CARD_STAGES.includes(w.stage as CardWork['stage']) && typeof w.updatedAt === 'number';
}

function isSource(v: unknown): v is BoardSource | null {
  return v === null || v === 'github' || v === 'linear';
}

export class BoardStore {
  private data: BoardFile = { version: 1, projects: {}, cards: {}, coordinators: {} };

  constructor(private readonly file: string) {}

  /** Arquivo de saída de um comando do quadro (fica ao lado do board.json, em board-logs/). */
  logFile(name: string): string {
    const dir = join(dirname(this.file), 'board-logs');
    mkdirSync(dir, { recursive: true });
    return join(dir, name);
  }

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BoardFile>;
      const projects: Record<string, BoardProjectConfig> = {};
      for (const [id, c] of Object.entries(raw.projects ?? {})) {
        if (!c || !isSource(c.source)) continue;
        projects[id] = {
          source: c.source,
          ...(typeof c.linearTeam === 'string' && c.linearTeam ? { linearTeam: c.linearTeam } : {}),
          ...(typeof c.afterMerge === 'string' && c.afterMerge ? { afterMerge: c.afterMerge } : {}),
        };
      }
      const cards: BoardFile['cards'] = {};
      for (const [pid, byCard] of Object.entries(raw.cards ?? {})) {
        for (const [cid, w] of Object.entries(byCard ?? {})) if (isWork(w)) (cards[pid] ??= {})[cid] = w;
      }
      const coordinators: Record<string, string> = {};
      for (const [pid, h] of Object.entries(raw.coordinators ?? {})) if (typeof h === 'string' && h) coordinators[pid] = h;
      this.data = { version: 1, projects, cards, coordinators };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`Quadro: ${this.file} ilegível (${errMsg(err)}); começando vazio.`);
    }
  }

  config(projectId: string): BoardProjectConfig | undefined {
    return this.data.projects[projectId];
  }

  setConfig(projectId: string, config: BoardProjectConfig): void {
    this.data.projects[projectId] = config;
    this.save();
  }

  work(projectId: string, cardId: string): CardWork | undefined {
    return this.data.cards[projectId]?.[cardId];
  }

  works(projectId: string): Readonly<Record<string, CardWork>> {
    return this.data.cards[projectId] ?? {};
  }

  /** Todos os trabalhos (para retomar depois de reiniciar). */
  allWorks(): { projectId: string; cardId: string; work: CardWork }[] {
    return Object.entries(this.data.cards).flatMap(([projectId, byCard]) => Object.entries(byCard).map(([cardId, work]) => ({ projectId, cardId, work })));
  }

  /** Grava (ou, com undefined, apaga) o trabalho de um card. */
  setWork(projectId: string, cardId: string, work: CardWork | undefined): void {
    if (work) (this.data.cards[projectId] ??= {})[cardId] = work;
    else if (this.data.cards[projectId]) {
      delete this.data.cards[projectId][cardId];
      if (!Object.keys(this.data.cards[projectId]).length) delete this.data.cards[projectId];
    }
    this.save();
  }

  /** Terminal coordenador do Orca de um card (chave `<projeto>#<card>`). */
  coordinator(key: string): string | undefined {
    return this.data.coordinators[key];
  }

  setCoordinator(key: string, handle: string | undefined): void {
    if (handle) this.data.coordinators[key] = handle;
    else delete this.data.coordinators[key];
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn(`Quadro: não deu para gravar ${this.file} (${errMsg(err)}).`);
    }
  }
}
