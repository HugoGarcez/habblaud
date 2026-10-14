// Planejador: um Claude Code só de leitura (`claude -p`, ferramentas Read/Grep/Glob) olha o repositório e quebra o
// card em ações, sugerindo a IA de cada uma pela tabela de perfis e cotas (agents.ts). A resposta vem em JSON pelo
// --json-schema (campo `structured_output`); o roteador (router.ts) confere e ajusta depois.
//
// Roda na conta do Claude com mais folga (CLAUDE_CONFIG_DIR), na pasta do projeto, sem as configurações do usuário
// (--setting-sources project: sem hooks nem plugins pessoais, o que também deixa a chamada bem mais rápida) e sem
// servidores MCP. Modelo: HABBLAUD_PLANNER_MODEL (padrão sonnet).
import { ACTION_TYPES, AGENT_IDS, type AgentQuota, type BoardCard, type BoardProject } from '../../shared/board';
import { CliError, type Exec } from './cli';
import { MAX_ACTIONS } from './router';

export const PLANNER_TIMEOUT_MS = 6 * 60_000;
export const DEFAULT_PLANNER_MODEL = 'sonnet';

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Resumo do plano em 1 a 3 frases.' },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_ACTIONS,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'a1, a2...' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'Instruções completas e autocontidas para o agente.' },
          type: { type: 'string', enum: [...ACTION_TYPES] },
          agent: { type: 'string', enum: [...AGENT_IDS] },
          writes: { type: 'boolean', description: 'A ação muda arquivos do repositório.' },
          deps: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string', description: 'Por que esta IA, em uma frase.' },
        },
        required: ['id', 'title', 'instructions', 'type', 'agent', 'writes', 'deps', 'reason'],
      },
    },
  },
  required: ['summary', 'actions'],
} as const;

function quotaLine(q: AgentQuota): string {
  const usage = [q.fiveHour !== undefined ? `5h ${q.fiveHour}%` : '', q.sevenDay !== undefined ? `semana ${q.sevenDay}%` : ''].filter(Boolean).join(', ') || 'sem números';
  return `| ${q.agent} | ${q.strengths} | ${usage}${q.stale ? ' (antigo)' : ''} | ${q.available ? 'sim' : `não (${q.reason})`} |`;
}

const KIND_TEXT = { issue: 'tarefa', feature: 'funcionalidade nova', fix: 'correção de bug' } as const;

export function plannerPrompt(project: BoardProject, card: BoardCard, quotas: readonly AgentQuota[]): string {
  return [
    `Você é o planejador do Promp IA, que distribui trabalho de programação entre várias IAs. Projeto: "${project.name}"${project.github ? ` (GitHub ${project.github})` : ''}, na pasta atual.`,
    '',
    `Card ${card.ref} (${KIND_TEXT[card.kind]}): ${card.title}`,
    card.body ? `Descrição:\n${card.body}` : 'Sem descrição.',
    '',
    'IAs que podem receber ações (use só as disponíveis; prefira a que tem mais folga quando duas servem):',
    '| agent | bom em | uso | disponível |',
    '|---|---|---|---|',
    ...quotas.map(quotaLine),
    '',
    'Como planejar:',
    '- Olhe o repositório o suficiente para entender onde mexer (Read, Grep, Glob). NÃO altere nada.',
    `- Quebre o card em 1 a ${MAX_ACTIONS} ações. Tarefa simples = poucas ações; não invente trabalho.`,
    '- Cada ação vai para um agente que NÃO vê este plano nem as outras ações: as instruções precisam ser completas (arquivos, o que mudar, como conferir).',
    '- Todas as ações trabalham na mesma cópia do repositório (um worktree só do card); as que escrevem rodam uma de cada vez, na ordem.',
    '- Use deps para ordem real (ex.: testes depois da implementação). Marque writes=false em análise e revisão.',
    '- Se fizer sentido, termine com uma revisão por uma IA diferente da que implementou.',
    '- Não inclua ações de commit, push ou abrir PR: o Promp IA faz isso no fim.',
    '- Escreva títulos, instruções e motivos em português.',
  ].join('\n');
}

export interface PlannerRun {
  claude: string;
  cwd: string;
  /** Pasta da conta do Claude (CLAUDE_CONFIG_DIR). */
  configDir?: string;
  model: string;
  exec: Exec;
  env?: NodeJS.ProcessEnv;
}

/** Roda o planejador e devolve o JSON cru (summary + actions); o roteador confere. */
export async function runPlanner(run: PlannerRun, prompt: string): Promise<{ summary: string; actions: unknown[] }> {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(PLAN_SCHEMA),
    '--model',
    run.model,
    '--allowedTools',
    'Read,Grep,Glob',
    '--disallowedTools',
    'Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch,Task',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--no-session-persistence',
  ];
  const out = await run.exec(run.claude, args, {
    timeoutMs: PLANNER_TIMEOUT_MS,
    cwd: run.cwd,
    env: { ...(run.env ?? process.env), ...(run.configDir ? { CLAUDE_CONFIG_DIR: run.configDir } : {}) },
  });
  let d: { is_error?: boolean; result?: string; structured_output?: { summary?: unknown; actions?: unknown } };
  try {
    d = JSON.parse(out);
  } catch {
    throw new CliError('resposta do planejador ilegível');
  }
  if (d.is_error) throw new CliError(String(d.result ?? 'o planejador falhou').slice(0, 300));
  let plan = d.structured_output;
  if (!plan && typeof d.result === 'string') {
    try {
      plan = JSON.parse(d.result);
    } catch {
      // sem JSON no texto
    }
  }
  if (!plan || !Array.isArray(plan.actions)) throw new CliError('o planejador não devolveu um plano');
  return { summary: typeof plan.summary === 'string' ? plan.summary.trim().slice(0, 1_000) : '', actions: plan.actions };
}
