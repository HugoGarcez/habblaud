import { describe, expect, it } from 'vitest';
import type { AgentId } from '../../shared/board';
import { agentQuotas } from './agents';
import { parseOrcaLimits } from './orca-limits';
import { substitute } from './router';

const ALL = new Set<AgentId>(['claude', 'codex', 'antigravity', 'opencode']);

const rateLimits = {
  claude: { status: 'ok', session: { usedPercent: 2 }, weekly: { usedPercent: 21 } },
  codex: { status: 'unavailable', error: 'Not signed in to Codex', session: null, weekly: null },
  antigravity: { status: 'ok', session: null, weekly: { usedPercent: 100 } },
  opencodeGo: { status: 'unavailable', error: 'No OpenCode Go API key', session: null, weekly: null },
};

describe('cotas do Orca', () => {
  it('lê o rateLimits por IA; OpenCode sem a assinatura Go fica de fora', () => {
    expect(parseOrcaLimits({ rateLimits })).toEqual({
      claude: { status: 'ok', fiveHour: 2, sevenDay: 21 },
      codex: { status: 'unavailable', error: 'Not signed in to Codex' },
      antigravity: { status: 'ok', sevenDay: 100 },
    });
    expect(parseOrcaLimits(undefined)).toEqual({});
  });

  it('junta com as contas do escritório: vale o maior uso; a que o Orca não consegue usar sai', () => {
    const q = Object.fromEntries(agentQuotas([], ALL, parseOrcaLimits({ rateLimits })).map((x) => [x.agent, x]));
    expect(q.claude).toMatchObject({ available: true, fiveHour: 2, sevenDay: 21 });
    expect(q.codex).toMatchObject({ available: false, reason: expect.stringMatching(/Orca não consegue usar: Not signed in/) });
    expect(q.antigravity).toMatchObject({ available: false, reason: 'sem cota agora', sevenDay: 100 });
    expect(q.opencode.available).toBe(true);
  });

  it('o plano troca a IA indisponível pela equivalente do tipo', () => {
    const quotas = agentQuotas([], ALL, parseOrcaLimits({ rateLimits }));
    const { actions, notes } = substitute(
      [
        { id: 'a1', title: 'Analisar', instructions: 'x', type: 'analysis', agent: 'antigravity', writes: false, deps: [], reason: '' },
        { id: 'a2', title: 'Implementar', instructions: 'x', type: 'implementation', agent: 'codex', writes: true, deps: [], reason: '' },
        { id: 'a3', title: 'Revisar', instructions: 'x', type: 'review', agent: 'claude', writes: false, deps: [], reason: '' },
      ],
      quotas,
    );
    expect(actions.map((a) => a.agent)).toEqual(['claude', 'claude', 'claude']);
    expect(notes).toHaveLength(2);
  });
});
