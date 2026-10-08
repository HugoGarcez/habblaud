// Uso do plano do Codex (sessão de 5 h e semanal), lido dos rollouts que o próprio Codex grava:
//   <CODEX_HOME>/sessions/AAAA/MM/DD/rollout-*.jsonl
// Cada evento `token_count` traz `rate_limits` {primary, secondary: {used_percent, window_minutes, resets_at}}.
// Contas: ~/.codex (ou $CODEX_HOME) e as contas que o Orca gerencia (<orca>/codex-accounts/<id>/home).
// Só lê os rollouts: nada de auth.json nem chamadas de rede.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccountUsage, UsageWindow } from '../../shared/types';
import { toEpochMs } from '../accounts/usage';

/** Quanto do fim do rollout mais recente é lido (os eventos token_count aparecem a cada resposta). */
const TAIL_BYTES = 512 * 1024;
/** Rollouts mais velhos que isto não contam (a conta não está em uso). */
const MAX_AGE_MS = 8 * 24 * 3_600_000;

export interface CodexHome {
  /** Chave estável (o caminho). */
  dir: string;
  /** Rótulo curto: "~/.codex" ou "Orca 1", "Orca 2"… */
  label: string;
}

/** Pastas do Codex com sessões: ~/.codex, $CODEX_HOME (se for outra) e as contas gerenciadas pelo Orca. */
export function discoverCodexHomes(home: string, env: NodeJS.ProcessEnv = process.env): CodexHome[] {
  const out: CodexHome[] = [];
  const seen = new Set<string>();
  const add = (dir: string, label: string) => {
    const key = resolve(dir);
    if (seen.has(key) || !existsSync(join(dir, 'sessions'))) return;
    seen.add(key);
    out.push({ dir, label });
  };
  add(join(home, '.codex'), '~/.codex');
  const orca = join(home, 'Library', 'Application Support', 'orca', 'codex-accounts');
  let n = 0;
  for (const id of safeList(orca).sort()) {
    const dir = join(orca, id, 'home');
    if (existsSync(join(dir, 'sessions'))) add(dir, `Orca ${++n}`);
  }
  // O Orca exporta CODEX_HOME com a conta dele: já entrou acima.
  if (env.CODEX_HOME) add(env.CODEX_HOME, env.CODEX_HOME);
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Rollout mais recente (desce pelos diretórios AAAA/MM/DD do mais novo para o mais velho). */
export function latestRollout(codexHome: string, now: number): { path: string; mtimeMs: number } | undefined {
  const root = join(codexHome, 'sessions');
  const desc = (d: string) => safeList(d).filter((x) => /^\d+$/.test(x)).sort().reverse();
  let checkedDays = 0;
  for (const y of desc(root)) {
    for (const m of desc(join(root, y))) {
      for (const d of desc(join(root, y, m))) {
        const dir = join(root, y, m, d);
        let best: { path: string; mtimeMs: number } | undefined;
        for (const f of safeList(dir)) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          try {
            const st = statSync(join(dir, f));
            if (!best || st.mtimeMs > best.mtimeMs) best = { path: join(dir, f), mtimeMs: st.mtimeMs };
          } catch {
            /* sumiu */
          }
        }
        if (best) return now - best.mtimeMs < MAX_AGE_MS ? best : undefined;
        if (++checkedDays > 14) return undefined;
      }
    }
  }
  return undefined;
}

function readTail(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function toWindow(raw: unknown): { win: UsageWindow; minutes?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const pct = typeof r.used_percent === 'number' ? r.used_percent : undefined;
  if (pct === undefined) return undefined;
  const win: UsageWindow = { utilization: Math.min(100, Math.max(0, pct)) };
  const resets = toEpochMs(r.resets_at);
  if (resets !== undefined) win.resetsAt = resets;
  return { win, minutes: typeof r.window_minutes === 'number' ? r.window_minutes : undefined };
}

/** `rate_limits` do Codex -> AccountUsage (janela de ~5 h = fiveHour, de ~7 dias = sevenDay). */
export function usageFromRateLimits(raw: unknown, fetchedAt: number): AccountUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const usage: AccountUsage = { source: 'codex', fetchedAt };
  for (const w of [toWindow(r.primary), toWindow(r.secondary)]) {
    if (!w) continue;
    const m = w.minutes;
    if (m !== undefined && m >= 24 * 60) usage.sevenDay ??= w.win;
    else usage.fiveHour ??= w.win;
  }
  return usage.fiveHour || usage.sevenDay ? usage : undefined;
}

/** Último `rate_limits` de um trecho de rollout (linhas JSONL). */
export function lastRateLimits(text: string): AccountUsage | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    try {
      const o = JSON.parse(line) as { timestamp?: unknown; payload?: { rate_limits?: unknown; info?: { rate_limits?: unknown } } };
      const rl = o.payload?.rate_limits ?? o.payload?.info?.rate_limits;
      const at = toEpochMs(o.timestamp);
      const u = at !== undefined ? usageFromRateLimits(rl, at) : undefined;
      if (u) return u;
    } catch {
      /* linha cortada no começo do trecho */
    }
  }
  return undefined;
}

/** Uso mais recente de uma pasta do Codex (cache pelo mtime do rollout). */
export class CodexUsageReader {
  private cache = new Map<string, { path: string; mtimeMs: number; usage?: AccountUsage }>();

  read(home: CodexHome, now: number): AccountUsage | undefined {
    const latest = latestRollout(home.dir, now);
    if (!latest) return undefined;
    const hit = this.cache.get(home.dir);
    if (hit && hit.path === latest.path && hit.mtimeMs === latest.mtimeMs) return hit.usage;
    let usage: AccountUsage | undefined;
    try {
      usage = lastRateLimits(readTail(latest.path, TAIL_BYTES));
    } catch {
      usage = undefined;
    }
    // Rollout novo ainda sem token_count: mantém os números anteriores desta conta.
    if (!usage && hit?.usage) usage = hit.usage;
    this.cache.set(home.dir, { ...latest, usage });
    return usage;
  }
}

export interface CodexUsageEntry {
  home: CodexHome;
  usage: AccountUsage;
}

/** Relê o uso de cada conta do Codex a cada ~15 s e avisa quando muda. */
export class CodexUsageService {
  private timer: NodeJS.Timeout | undefined;
  private reader = new CodexUsageReader();
  private current: CodexUsageEntry[] = [];

  constructor(private readonly opts: { home: string; env?: NodeJS.ProcessEnv; onChange?: () => void; now?: () => number; pollMs?: number }) {}

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.opts.pollMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Contas com números, da leitura mais recente para a mais antiga. */
  entries(): CodexUsageEntry[] {
    return this.current;
  }

  refresh(): void {
    const now = (this.opts.now ?? Date.now)();
    const next: CodexUsageEntry[] = [];
    for (const home of discoverCodexHomes(this.opts.home, this.opts.env)) {
      const usage = this.reader.read(home, now);
      if (usage) next.push({ home, usage });
    }
    next.sort((a, b) => b.usage.fetchedAt - a.usage.fetchedAt);
    // O Orca copia sessões entre as pastas (backfill): mesmas janelas (mesmo reinício) = mesma conta.
    const seen = new Set<string>();
    const unique = next.filter((e) => {
      const sig = `${e.usage.fiveHour?.resetsAt ?? '-'}|${e.usage.sevenDay?.resetsAt ?? '-'}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    next.length = 0;
    next.push(...unique);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.opts.onChange?.();
  }
}
