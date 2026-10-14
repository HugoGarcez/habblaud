// Fontes dos cards: issues do GitHub (gh) e do Linear (orca linear). Só leitura nesta fase.
//
// GitHub: `gh issue list --repo dono/repo --state all` (as abertas e as fechadas nas últimas 2 semanas). Aberta vai
// para o Backlog, a não ser que tenha uma label `promp:*` (GITHUB_COLUMN_LABELS); fechada vai para Concluído.
// Linear: `orca linear list-issues --team <key>`. Tipo do estado → coluna: backlog/unstarted = Backlog, started =
// Em execução (ou Revisão, se o nome do estado fala em revisão), completed = Concluído; cancelado e duplicado ficam
// de fora.
import { GITHUB_COLUMN_LABELS, kindFromLabels, type BoardCard, type BoardColumn, type LinearTeam } from '../../shared/board';
import { CliError, orcaResult, type Exec } from './cli';

/** Quanto tempo uma issue fechada continua na coluna Concluído. */
export const DONE_KEEP_MS = 14 * 24 * 3_600_000;
export const LIST_LIMIT = 200;
const BODY_MAX = 600;

function clip(s: unknown): string {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX - 1)}…` : t;
}

function time(s: unknown): number {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : 0;
}

interface GhIssue {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: string;
  labels?: { name: string }[];
  updatedAt?: string;
  closedAt?: string | null;
}

export function githubCard(i: GhIssue): BoardCard {
  const labels = (i.labels ?? []).map((l) => l.name);
  const open = i.state.toUpperCase() === 'OPEN';
  let column: BoardColumn = open ? 'backlog' : 'done';
  if (open) for (const l of labels) column = GITHUB_COLUMN_LABELS[l] ?? column;
  return {
    id: `github:${i.number}`,
    source: 'github',
    ref: `#${i.number}`,
    title: i.title,
    body: clip(i.body),
    url: i.url,
    kind: kindFromLabels(labels),
    column,
    labels: labels.filter((l) => !(l in GITHUB_COLUMN_LABELS)),
    state: open ? 'open' : 'closed',
    updatedAt: time(i.updatedAt),
  };
}

export async function listGithub(exec: Exec, gh: string, repo: string, now = Date.now()): Promise<BoardCard[]> {
  const out = await exec(gh, ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', String(LIST_LIMIT), '--json', 'number,title,body,url,state,labels,updatedAt,closedAt']);
  let issues: GhIssue[];
  try {
    issues = JSON.parse(out);
  } catch {
    throw new CliError('resposta do gh ilegível');
  }
  return issues.filter((i) => i.state.toUpperCase() === 'OPEN' || now - time(i.closedAt ?? i.updatedAt) < DONE_KEEP_MS).map(githubCard);
}

interface LinearIssue {
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  state?: { name?: string; type?: string } | null;
  labels?: ({ name?: string } | string)[];
  updatedAt?: string;
  completedAt?: string | null;
}

/** Coluna de um estado do Linear; undefined = não aparece (cancelado, duplicado). */
export function linearColumn(state: LinearIssue['state']): BoardColumn | undefined {
  const type = state?.type ?? 'unstarted';
  const name = (state?.name ?? '').toLowerCase();
  if (type === 'canceled' || type === 'duplicate') return undefined;
  if (type === 'completed') return 'done';
  if (type === 'started') return /review|revis/.test(name) ? 'review' : 'running';
  return 'backlog';
}

export function linearCard(i: LinearIssue): BoardCard | undefined {
  const column = linearColumn(i.state);
  if (!column) return undefined;
  const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
  return {
    id: `linear:${i.identifier}`,
    source: 'linear',
    ref: i.identifier,
    title: i.title,
    body: clip(i.description),
    url: i.url,
    kind: kindFromLabels(labels),
    column,
    labels,
    state: i.state?.name ?? '',
    updatedAt: time(i.updatedAt),
  };
}

export async function listLinear(exec: Exec, orca: string, team: string, now = Date.now()): Promise<BoardCard[]> {
  const out = await exec(orca, ['linear', 'list-issues', '--team', team, '--limit', String(LIST_LIMIT), '--order-by', 'updatedAt', '--json']);
  const r = orcaResult<{ issues: LinearIssue[] }>(out);
  const cards: BoardCard[] = [];
  for (const i of r.issues ?? []) {
    const c = linearCard(i);
    if (!c) continue;
    if (c.column === 'done' && now - time(i.completedAt ?? i.updatedAt) >= DONE_KEEP_MS) continue;
    cards.push(c);
  }
  return cards;
}

export async function listLinearTeams(exec: Exec, orca: string): Promise<LinearTeam[]> {
  const r = orcaResult<{ teams: { key: string; name: string }[] }>(await exec(orca, ['linear', 'team', 'list', '--json']));
  return (r.teams ?? []).map((t) => ({ key: t.key, name: t.name }));
}
