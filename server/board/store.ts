// Estado do quadro em <dataDir>/board.json: a configuração de cada projeto (fonte dos cards e time do Linear).
// Gravação atômica (arquivo temporário + rename), como o names.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BoardProjectConfig, BoardSource } from '../../shared/board';
import { errMsg, log } from '../log';

interface BoardFile {
  version: 1;
  projects: Record<string, BoardProjectConfig>;
}

function isSource(v: unknown): v is BoardSource | null {
  return v === null || v === 'github' || v === 'linear';
}

export class BoardStore {
  private data: BoardFile = { version: 1, projects: {} };

  constructor(private readonly file: string) {}

  load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BoardFile>;
      const projects: Record<string, BoardProjectConfig> = {};
      for (const [id, c] of Object.entries(raw.projects ?? {})) {
        if (!c || !isSource(c.source)) continue;
        projects[id] = { source: c.source, ...(typeof c.linearTeam === 'string' && c.linearTeam ? { linearTeam: c.linearTeam } : {}) };
      }
      this.data = { version: 1, projects };
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
