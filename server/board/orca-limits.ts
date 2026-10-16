// Cotas das IAs como o Orca as vê (`orca account list --json`, campo `rateLimits`): é o Orca quem põe os workers para
// rodar, então é a palavra dele que vale para saber se uma IA pode receber trabalho. Junta-se às contas do escritório
// em agentQuotas (agents.ts): vale o maior uso dos dois, e uma IA que o Orca diz não conseguir usar fica de fora.
//   claude → rateLimits.claude · codex → codex · antigravity → antigravity · opencode → opencodeGo (só com números:
//   o OpenCode também roda sem a assinatura Go).
import type { AgentId } from '../../shared/board';
import { orcaResult, type Exec } from './cli';

export interface OrcaLimit {
  /** ok = números válidos; unavailable = o Orca não tem como usar a IA (sem login, sem credenciais); error = falha ao ler. */
  status: 'ok' | 'unavailable' | 'error';
  fiveHour?: number;
  sevenDay?: number;
  error?: string;
}

export type OrcaLimits = Partial<Record<AgentId, OrcaLimit>>;

interface RawWindow {
  usedPercent?: unknown;
}

interface RawLimit {
  status?: unknown;
  error?: unknown;
  session?: RawWindow | null;
  weekly?: RawWindow | null;
  monthly?: RawWindow | null;
}

const PROVIDERS: Readonly<Record<AgentId, string>> = { claude: 'claude', codex: 'codex', antigravity: 'antigravity', opencode: 'opencodeGo' };

function pct(w: RawWindow | null | undefined): number | undefined {
  return typeof w?.usedPercent === 'number' && Number.isFinite(w.usedPercent) ? Math.round(w.usedPercent) : undefined;
}

export function parseOrcaLimits(result: unknown): OrcaLimits {
  const raw = ((result ?? {}) as { rateLimits?: Record<string, RawLimit | undefined> }).rateLimits ?? {};
  const out: OrcaLimits = {};
  for (const [agent, provider] of Object.entries(PROVIDERS) as [AgentId, string][]) {
    const r = raw[provider];
    if (!r || typeof r !== 'object') continue;
    const status = r.status === 'ok' ? 'ok' : r.status === 'unavailable' ? 'unavailable' : 'error';
    // OpenCode: sem a assinatura Go ele ainda roda (modelos grátis ou chave própria); só os números importam.
    if (agent === 'opencode' && status !== 'ok') continue;
    const limit: OrcaLimit = { status };
    const five = pct(r.session);
    const week = pct(r.weekly) ?? pct(r.monthly);
    if (five !== undefined) limit.fiveHour = five;
    if (week !== undefined) limit.sevenDay = week;
    if (typeof r.error === 'string' && r.error) limit.error = r.error.slice(0, 200);
    out[agent] = limit;
  }
  return out;
}

export async function fetchOrcaLimits(exec: Exec, orca: string): Promise<OrcaLimits> {
  return parseOrcaLimits(orcaResult(await exec(orca, ['account', 'list', '--json'], { timeoutMs: 45_000 })));
}
