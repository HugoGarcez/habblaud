// Roteador: confere e ajusta o plano que o planejador devolveu (ou que a pessoa editou), sem gastar tokens.
// - ids únicos e dependências válidas (só ações anteriores; o resto sai);
// - IA indisponível (sem CLI ou sem cota) troca pela primeira disponível na preferência do tipo da ação;
// - ações que escrevem rodam uma de cada vez, na ordem do plano: cada uma passa a depender da anterior que escreve
//   (todas trabalham no mesmo worktree do card);
// - no máximo MAX_ACTIONS ações.
// Cada ajuste vira uma nota que a página mostra.
import { ACTION_TYPES, AGENT_IDS, type ActionType, type AgentId, type AgentQuota, type PlanAction } from '../../shared/board';
import { tr } from '../../shared/i18n';
import { AGENT_NAMES } from './agents';

export const MAX_ACTIONS = 8;
export const TITLE_MAX = 120;
export const INSTRUCTIONS_MAX = 6_000;

/** Ordem de preferência das IAs por tipo de ação. */
export const TYPE_PREFS: Readonly<Record<ActionType, readonly AgentId[]>> = {
  analysis: ['antigravity', 'claude', 'codex', 'opencode'],
  implementation: ['codex', 'claude', 'opencode', 'antigravity'],
  tests: ['codex', 'claude', 'opencode', 'antigravity'],
  review: ['claude', 'codex', 'antigravity', 'opencode'],
  docs: ['antigravity', 'claude', 'codex', 'opencode'],
};

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Lê uma ação qualquer (do planejador ou da página) no formato do plano; undefined = sem título ou instruções. */
export function normalizeAction(raw: unknown, index: number): PlanAction | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const title = str(r.title, TITLE_MAX);
  const instructions = str(r.instructions, INSTRUCTIONS_MAX);
  if (!title || !instructions) return undefined;
  const type = ACTION_TYPES.includes(r.type as ActionType) ? (r.type as ActionType) : 'implementation';
  const agent = AGENT_IDS.includes(r.agent as AgentId) ? (r.agent as AgentId) : TYPE_PREFS[type][0];
  const id = str(r.id, 16).replace(/[^\w-]/g, '') || `a${index + 1}`;
  return {
    id,
    title,
    instructions,
    type,
    agent,
    writes: typeof r.writes === 'boolean' ? r.writes : type !== 'analysis' && type !== 'review',
    deps: Array.isArray(r.deps) ? r.deps.filter((d): d is string => typeof d === 'string') : [],
    reason: str(r.reason, 400),
  };
}

export function route(rawActions: readonly unknown[], quotas: readonly AgentQuota[]): { actions: PlanAction[]; notes: string[] } {
  const notes: string[] = [];
  const quota = new Map(quotas.map((q) => [q.agent, q]));
  const available = (a: AgentId) => !!quota.get(a)?.available;
  let list = rawActions.map(normalizeAction).filter((a): a is PlanAction => !!a);
  if (list.length > MAX_ACTIONS) {
    notes.push(tr('O plano tinha {0} ações; ficaram as {1} primeiras.', [list.length, MAX_ACTIONS]));
    list = list.slice(0, MAX_ACTIONS);
  }
  const seen = new Set<string>();
  let lastWriter: string | undefined;
  const actions = list.map((a, i) => {
    let id = a.id;
    while (seen.has(id)) id = `${a.id}-${i + 1}`;
    const deps = [...new Set(a.deps.filter((d) => seen.has(d)))];
    let agent = a.agent;
    if (!available(agent)) {
      const alt = TYPE_PREFS[a.type].find(available);
      if (alt) {
        notes.push(tr('"{0}": {1} {2}; vai com {3}.', [a.title, AGENT_NAMES[agent], quota.get(agent)?.reason ?? tr('indisponível'), AGENT_NAMES[alt]]));
        agent = alt;
      } else {
        notes.push(tr('"{0}": nenhuma IA disponível agora; a ação espera alguma ter cota.', [a.title]));
      }
    }
    if (a.writes && lastWriter && !deps.includes(lastWriter)) deps.push(lastWriter);
    if (a.writes) lastWriter = id;
    seen.add(id);
    return { ...a, id, deps, agent };
  });
  return { actions, notes };
}
