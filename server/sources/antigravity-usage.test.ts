import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { AntigravityUsageService, groupLabel, parseAgyUsage } from './antigravity-usage';
import { OrcaWatcher } from './orca';

setQuiet(true);

// Saída de `agy -p /usage --output-format json` (encurtada).
const OUTPUT = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  usage: { total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5866398215293884, reset_time: '2026-10-10T17:57:32Z' },
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.9911084771156311, reset_time: '2026-10-09T03:17:46Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.060644399374723434, reset_time: '2026-10-13T21:20:28Z' },
            { id: '3p-5h', window: '5h', remaining_fraction: 1, reset_time: '2026-10-09T03:35:52Z' },
          ],
        },
      ],
    },
  },
});

describe('cotas do Antigravity', () => {
  it('nomes dos grupos', () => {
    expect(groupLabel('Gemini Models')).toBe('Gemini');
    expect(groupLabel('Claude and GPT models')).toBe('Claude/GPT');
  });

  it('cota restante -> percentual usado, por grupo', () => {
    const list = parseAgyUsage(JSON.parse(OUTPUT), 7);
    expect(list.map((e) => [e.label, e.usage.fiveHour?.utilization, e.usage.sevenDay?.utilization])).toEqual([
      ['Gemini', 1, 41],
      ['Claude/GPT', 0, 94],
    ]);
    expect(list[0].usage.sevenDay?.resetsAt).toBe(Date.parse('2026-10-10T17:57:32Z'));
    expect(parseAgyUsage({ status: 'ERROR' }, 7)).toEqual([]);
  });

  it('um cartão por grupo, o primeiro no cartão dos agentes do Antigravity; erro mantém os últimos números', async () => {
    const now = Date.parse('2026-10-08T22:40:00Z');
    let out = OUTPUT;
    const svc = new AntigravityUsageService({ run: async () => out, now: () => now });
    await svc.refresh();
    out = 'não é json';
    await svc.refresh();
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
    const w = new OrcaWatcher({ office, run: async () => '{}', now: () => now, usage: () => svc.entries() });
    expect(w.accounts(new Map()).map((a) => [a.id, a.name, a.usageStatus, a.usage?.sevenDay?.utilization])).toEqual([
      ['orca:antigravity', 'Antigravity · Gemini', 'ok', 41],
      ['orca:antigravity~Claude/GPT', 'Antigravity · Claude/GPT', 'ok', 94],
    ]);
  });
});
