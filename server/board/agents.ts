// As IAs que o quadro pode pôr para trabalhar e a cota de cada uma, a partir das contas do escritório (o mesmo uso de
// 5 h e semanal da barra superior):
//   claude      contas do Claude Code (provider ausente)
//   codex       contas do Codex (provider 'codex', inclusive as do Orca)
//   antigravity cartões "orca:antigravity…" (cotas do `agy /usage`)
//   opencode    sem números de uso (só precisa estar instalado)
// Uma IA está disponível quando a CLI existe e a conta com mais folga tem 5 h abaixo de 90% e semana abaixo de 95%
// (e não está "sem cota").
import type { AccountInfo } from '../../shared/types';
import { AGENT_IDS, type AgentId, type AgentQuota } from '../../shared/board';
import { tr } from '../../shared/i18n';

export const FIVE_HOUR_LIMIT = 90;
export const SEVEN_DAY_LIMIT = 95;

export const AGENT_NAMES: Readonly<Record<AgentId, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity (Gemini)',
  opencode: 'OpenCode',
};

export function agentStrengths(a: AgentId): string {
  switch (a) {
    case 'claude':
      return tr('Arquitetura, interface, revisão de código e tarefas ambíguas ou com muitas decisões.');
    case 'codex':
      return tr('Implementação direta, refatoração, testes e correções bem definidas.');
    case 'antigravity':
      return tr('Análise de muito contexto, documentação, pesquisa e leitura de código grande.');
    case 'opencode':
      return tr('Tarefas pequenas e mecânicas: renomear, ajustar configuração, formatar.');
  }
}

/** A IA dona de uma conta do escritório; undefined = conta de outra coisa (OpenCode do Orca sem uso...). */
export function agentOfAccount(a: Pick<AccountInfo, 'id' | 'provider'>): AgentId | undefined {
  if (a.provider === 'codex') return 'codex';
  if (a.id.startsWith('orca:antigravity')) return 'antigravity';
  if (a.id.startsWith('orca:opencode')) return 'opencode';
  if (a.id.startsWith('orca:')) return undefined;
  return 'claude';
}

/** Uso que importa de uma conta: o maior entre 5 h e semana (undefined = sem números). */
function load(a: AccountInfo): number | undefined {
  const u = a.usage;
  if (!u) return undefined;
  if (u.noQuota) return 100;
  const xs = [u.fiveHour?.utilization, u.sevenDay?.utilization].filter((x): x is number => typeof x === 'number');
  return xs.length ? Math.max(...xs) : undefined;
}

function blocked(a: AccountInfo): boolean {
  const u = a.usage;
  if (!u) return false;
  return !!u.noQuota || (u.fiveHour?.utilization ?? 0) >= FIVE_HOUR_LIMIT || (u.sevenDay?.utilization ?? 0) >= SEVEN_DAY_LIMIT;
}

/**
 * Situação de cada IA. `installed`: as CLIs presentes neste computador. Sem conta com números, a IA instalada conta
 * como disponível (não dá para saber a cota).
 */
export function agentQuotas(accounts: readonly AccountInfo[], installed: ReadonlySet<AgentId>): AgentQuota[] {
  return AGENT_IDS.map((agent) => {
    const mine = accounts.filter((a) => agentOfAccount(a) === agent && a.usage);
    // A conta com mais folga (sem números conta como folga desconhecida, depois das com números).
    const best = [...mine].sort((a, b) => Number(blocked(a)) - Number(blocked(b)) || (load(a) ?? 0) - (load(b) ?? 0))[0];
    const q: AgentQuota = { agent, name: AGENT_NAMES[agent], installed: installed.has(agent), available: false, strengths: agentStrengths(agent) };
    if (best?.usage) {
      if (best.usage.fiveHour) q.fiveHour = Math.round(best.usage.fiveHour.utilization);
      if (best.usage.sevenDay) q.sevenDay = Math.round(best.usage.sevenDay.utilization);
      if (best.usageStatus === 'stale') q.stale = true;
    }
    if (!q.installed) q.reason = tr('não instalada neste computador');
    else if (best && blocked(best)) q.reason = best.usage?.noQuota ? tr('sem cota agora') : tr('cota quase no fim');
    q.available = q.installed && !q.reason;
    return q;
  });
}

/** Conta do Claude com mais folga (o planejador roda nela); undefined = nenhuma disponível. */
export function bestClaudeAccount(accounts: readonly AccountInfo[]): AccountInfo | undefined {
  return accounts
    .filter((a) => agentOfAccount(a) === 'claude' && !blocked(a))
    .sort((a, b) => (load(a) ?? 0) - (load(b) ?? 0))[0];
}
