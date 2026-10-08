import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { CodexUsageService, discoverCodexHomes, lastRateLimits, usageFromRateLimits } from './codex-usage';
import { OrcaWatcher } from './orca';

setQuiet(true);

const limits = (five: number, week: number, reset = 2_000_000_000) => ({
  limit_id: 'codex',
  primary: { used_percent: five, window_minutes: 300, resets_at: reset },
  secondary: { used_percent: week, window_minutes: 10080, resets_at: reset + 500_000 },
});
const tokenCount = (ts: string, rl: unknown) =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });

describe('uso do Codex', () => {
  it('rate_limits -> janela de 5 h e semanal', () => {
    expect(usageFromRateLimits(limits(66, 10), 5)).toEqual({
      source: 'codex',
      fetchedAt: 5,
      fiveHour: { utilization: 66, resetsAt: 2_000_000_000_000 },
      sevenDay: { utilization: 10, resetsAt: 2_000_500_000_000 },
    });
    expect(usageFromRateLimits({ primary: null, secondary: null }, 5)).toBeUndefined();
  });

  it('pega o último token_count do trecho (ignorando a linha cortada)', () => {
    const text = ['{"cortad', tokenCount('2026-10-08T03:00:00.000Z', limits(10, 1)), '{"type":"response_item"}', tokenCount('2026-10-08T03:08:59.107Z', limits(66, 10)), ''].join('\n');
    const u = lastRateLimits(text)!;
    expect(u.fiveHour?.utilization).toBe(66);
    expect(u.fetchedAt).toBe(Date.parse('2026-10-08T03:08:59.107Z'));
  });

  describe('com pastas', () => {
    let tmp: ReturnType<typeof tempDir>;
    beforeEach(() => (tmp = tempDir()));
    afterEach(() => tmp.cleanup());

    const rollout = (home: string, day: string, lines: string[]) => {
      const dir = join(home, 'sessions', ...day.split('/'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `rollout-${day.replace(/\//g, '-')}.jsonl`), lines.join('\n') + '\n');
    };

    it('acha ~/.codex e as contas do Orca, e mostra o uso no cartão do Codex', () => {
      const main = join(tmp.dir, '.codex');
      const orcaHome = join(tmp.dir, 'Library', 'Application Support', 'orca', 'codex-accounts', 'abc', 'home');
      rollout(main, '2026/10/05', [tokenCount('2026-10-05T10:00:00.000Z', limits(30, 5, 2_100_000_000))]);
      rollout(orcaHome, '2026/10/08', [tokenCount('2026-10-08T10:00:00.000Z', limits(66, 10))]);
      expect(discoverCodexHomes(tmp.dir, {}).map((h) => h.label)).toEqual(['~/.codex', 'Orca 1']);

      const now = Date.parse('2026-10-08T10:10:00.000Z');
      const svc = new CodexUsageService({ home: tmp.dir, env: {}, now: () => now });
      svc.refresh();
      expect(svc.entries().map((e) => [e.home.label, e.usage.fiveHour?.utilization])).toEqual([
        ['Orca 1', 66],
        ['~/.codex', 30],
      ]);

      const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
      const w = new OrcaWatcher({ office, run: async () => '{}', now: () => now, codexUsage: () => svc.entries() });
      const accs = w.accounts(new Map());
      expect(accs.map((a) => [a.id, a.name, a.usageStatus, a.usage?.fiveHour?.utilization])).toEqual([
        ['orca:codex', 'Codex', 'ok', 66],
        ['orca:codex~~/.codex', 'Codex · ~/.codex', 'stale', 30],
      ]);
    });

    it('a mesma conta copiada em duas pastas (backfill do Orca) aparece uma vez só', () => {
      const orcaHome = join(tmp.dir, 'Library', 'Application Support', 'orca', 'codex-accounts', 'abc', 'home');
      rollout(join(tmp.dir, '.codex'), '2026/10/08', [tokenCount('2026-10-08T09:00:00.000Z', limits(60, 9))]);
      rollout(orcaHome, '2026/10/08', [tokenCount('2026-10-08T10:00:00.000Z', limits(66, 10))]);
      const svc = new CodexUsageService({ home: tmp.dir, env: {}, now: () => Date.parse('2026-10-08T10:10:00.000Z') });
      svc.refresh();
      expect(svc.entries().map((e) => [e.home.label, e.usage.fiveHour?.utilization])).toEqual([['Orca 1', 66]]);
    });
  });
});
