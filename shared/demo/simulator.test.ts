import { describe, expect, it } from 'vitest';
import { DemoSimulator } from './simulator';

describe('DemoSimulator', () => {
  it('no ?mock=1 imita as contas C e D', () => {
    const sim = new DemoSimulator({ seed: 1 }, 1_000);
    expect(sim.snapshot(1_000).accounts.map((a) => [a.id, a.short])).toEqual([
      ['.claude', 'C'],
      ['.claude-conta2', 'D'],
    ]);
  });

  it('com idPrefix usa contas próprias e ids que não colidem com dados reais', () => {
    const sim = new DemoSimulator({ seed: 1, idPrefix: 'demo:', sessions: 5 }, 1_000);
    const snap = sim.snapshot(1_000);
    expect(snap.accounts.map((a) => [a.id, a.short, a.name])).toEqual([
      ['demo:.claude', 'X', 'Demo X'],
      ['demo:.claude-conta2', 'Y', 'Demo Y'],
    ]);
    expect(snap.agents.every((a) => a.id.startsWith('demo:') && a.account.startsWith('demo:'))).toBe(true);
    expect(snap.rooms.every((r) => r.id.startsWith('demo:'))).toBe(true);
  });

  it('ids de atividades não se repetem entre instâncias (religar o demo)', () => {
    const ids = new Set<string>();
    for (const start of [1_000, 2_000]) {
      const sim = new DemoSimulator({ seed: 7, idPrefix: 'demo:', speed: 20 }, start);
      for (let t = start; t < start + 60_000; t += 250) for (const f of sim.tick(t).feed) {
        expect(ids.has(f.id)).toBe(false);
        ids.add(f.id);
      }
    }
    expect(ids.size).toBeGreaterThan(10);
  });
});
