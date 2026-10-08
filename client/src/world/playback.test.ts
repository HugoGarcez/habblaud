import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { animScale, rebaseSnapshot } from './playback';

describe('timelapse no mundo', () => {
  it('fator de animação: ~raiz da velocidade, entre 1 e 16 (0 = pausado)', () => {
    expect(animScale(60)).toBe(6);
    expect(animScale(180)).toBe(10);
    expect(animScale(600)).toBe(16);
    expect(animScale(1)).toBe(1);
    expect(animScale(5000)).toBe(16);
    expect(animScale(0)).toBe(0);
    expect(animScale(Number.NaN)).toBe(0);
  });

  it('desloca para o relógio do mundo só o que ele compara com o "agora"', () => {
    const agent = {
      id: 'a',
      statusSince: 1_000,
      startedAt: 500,
      activity: { id: 'x', kind: 'read', icon: '📖', text: 't', at: 900 },
      recent: [],
      shells: [{ id: 'j', label: 'Build', startedAt: 800, background: true, kind: 'shell' }],
    } as unknown as AgentInfo;
    const snap = { rev: 1, serverTime: 2_000, rooms: [], agents: [agent], accounts: [], meta: { demo: false, sources: [], startedAt: 0, version: 't' } } as OfficeSnapshot;
    const out = rebaseSnapshot(snap, 10_000);
    expect(out.serverTime).toBe(12_000);
    expect(out.agents[0].statusSince).toBe(11_000);
    expect(out.agents[0].shells![0].startedAt).toBe(10_800);
    // Atividades e o snapshot original ficam como estão.
    expect(out.agents[0].activity!.at).toBe(900);
    expect(out.agents[0].startedAt).toBe(500);
    expect(agent.statusSince).toBe(1_000);
    expect(agent.shells![0].startedAt).toBe(800);
    expect(rebaseSnapshot(snap, 0)).toBe(snap);
  });
});
