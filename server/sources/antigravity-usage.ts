// Cotas do Antigravity (5 h e semanal, por grupo de modelos), pela própria CLI:
//   agy -p /usage --output-format json
// O comando não roda modelo nenhum (0 tokens); quem consulta o Google é o agy, com o login dele — o Habblaud
// não lê credenciais. Uma consulta a cada 5 min. HABBLAUD_ANTIGRAVITY=0 desliga.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AccountUsage, UsageWindow } from '../../shared/types';
import { toEpochMs } from '../accounts/usage';
import { errMsg, log } from '../log';
import type { ExternalUsage } from './orca';

/** Acha a CLI do Antigravity: HABBLAUD_AGY_BIN, o PATH ou ~/.local/bin/agy. */
export function findAgyBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HABBLAUD_AGY_BIN) return env.HABBLAUD_AGY_BIN;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'agy'))) return join(dir, 'agy');
  }
  const local = join(env.HOME ?? '', '.local', 'bin', 'agy');
  return existsSync(local) ? local : undefined;
}

function toWindow(b: Record<string, unknown>): UsageWindow | undefined {
  const rem = typeof b.remaining_fraction === 'number' ? b.remaining_fraction : undefined;
  if (rem === undefined) return undefined;
  const w: UsageWindow = { utilization: Math.round(Math.min(100, Math.max(0, (1 - rem) * 100))) };
  const reset = toEpochMs(b.reset_time);
  if (reset !== undefined) w.resetsAt = reset;
  return w;
}

/** Grupo "Gemini Models" -> "Gemini"; "Claude and GPT models" -> "Claude/GPT". */
export function groupLabel(name: string): string {
  return name
    .replace(/\s+models?$/i, '')
    .replace(/\s+and\s+/gi, '/')
    .trim();
}

/** Saída JSON do `agy -p /usage` -> um uso por grupo de modelos (na ordem da CLI). */
export function parseAgyUsage(raw: unknown, fetchedAt: number): ExternalUsage[] {
  const groups = (raw as { command?: { data?: { groups?: unknown } } })?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const out: ExternalUsage[] = [];
  for (const g of groups as Array<Record<string, unknown>>) {
    const name = typeof g.name === 'string' ? g.name : undefined;
    if (!name || !Array.isArray(g.buckets)) continue;
    const usage: AccountUsage = { source: 'antigravity', fetchedAt };
    for (const b of g.buckets as Array<Record<string, unknown>>) {
      const w = toWindow(b);
      if (!w) continue;
      if (b.window === '5h') usage.fiveHour ??= w;
      else if (b.window === 'weekly') usage.sevenDay ??= w;
    }
    if (usage.fiveHour || usage.sevenDay) out.push({ agentType: 'antigravity', label: groupLabel(name), labelInName: true, configDir: 'agy /usage', usage });
  }
  return out;
}

export class AntigravityUsageService {
  private timer: NodeJS.Timeout | undefined;
  private current: ExternalUsage[] = [];
  private busy = false;
  private failed = false;
  private readonly run: () => Promise<string>;

  constructor(private readonly opts: { bin?: string; run?: () => Promise<string>; onChange?: () => void; now?: () => number; pollMs?: number }) {
    const bin = opts.bin;
    this.run =
      opts.run ??
      (() =>
        new Promise((resolve, reject) => {
          if (!bin) return reject(new Error('CLI do Antigravity (agy) não encontrada'));
          execFile(bin, ['-p', '/usage', '--output-format', 'json'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
            err ? reject(err) : resolve(stdout),
          );
        }));
  }

  get enabled(): boolean {
    return !!(this.opts.bin || this.opts.run);
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.pollMs ?? 300_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  entries(): ExternalUsage[] {
    return this.current;
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const out = await this.run();
      const next = parseAgyUsage(JSON.parse(out), (this.opts.now ?? Date.now)());
      if (!next.length) throw new Error('resposta sem cotas');
      this.failed = false;
      if (JSON.stringify(next) === JSON.stringify(this.current)) return;
      this.current = next;
      this.opts.onChange?.();
    } catch (err) {
      // Mantém os últimos números (viram "desatualizados" com o tempo).
      if (!this.failed) log.warn(`Antigravity: não deu para ler as cotas (${errMsg(err)}).`);
      this.failed = true;
    } finally {
      this.busy = false;
    }
  }
}
