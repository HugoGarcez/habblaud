// Fontes dos cards: issues do GitHub (gh) e do Linear (orca linear): listar e criar.
//
// GitHub: `gh issue list --repo dono/repo --state all` (as abertas e as fechadas nas últimas 2 semanas). Aberta vai
// para o Backlog, a não ser que tenha uma label `promp:*` (GITHUB_COLUMN_LABELS); fechada vai para Concluído.
// Linear: `orca linear list-issues --team <key>`. Tipo do estado → coluna: backlog/unstarted = Backlog, started =
// Em execução (ou Revisão, se o nome do estado fala em revisão), completed = Concluído; cancelado e duplicado ficam
// de fora.
import { randomUUID } from 'node:crypto';
import { GITHUB_COLUMN_LABELS, kindFromLabels, type BoardCard, type BoardColumn, type CardKind, type LinearTeam, type NewCard } from '../../shared/board';
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

/** Label de cada tipo na fonte (as padrão do GitHub e do Linear); `issue` não leva label. */
export const KIND_LABELS: Readonly<Record<'github' | 'linear', Partial<Record<CardKind, string>>>> = {
  github: { fix: 'bug', feature: 'enhancement' },
  linear: { fix: 'Bug', feature: 'Feature' },
};

/** A label pedida não existe no repositório/time: cria sem ela (o tipo ainda vale no card devolvido). */
function isMissingLabel(err: unknown): boolean {
  return err instanceof CliError && /label/i.test(err.message) && /not found|could not|invalid|unknown|no label|não/i.test(err.message);
}

async function withLabelFallback<T>(label: string | undefined, run: (label: string | undefined) => Promise<T>): Promise<T> {
  try {
    return await run(label);
  } catch (err) {
    if (label && isMissingLabel(err)) return run(undefined);
    throw err;
  }
}

/** `gh issue create` devolve a URL da issue nova (última linha). */
export function parseIssueUrl(stdout: string): { url: string; number: number } {
  const url = stdout.trim().split('\n').pop()?.trim() ?? '';
  const m = /\/issues\/(\d+)$/.exec(url);
  if (!m) throw new CliError('o gh não devolveu o endereço da issue');
  return { url, number: Number(m[1]) };
}

export async function createGithub(exec: Exec, gh: string, repo: string, card: NewCard, now = Date.now()): Promise<BoardCard> {
  const label = KIND_LABELS.github[card.kind];
  const { url, number } = await withLabelFallback(label, async (l) =>
    parseIssueUrl(await exec(gh, ['issue', 'create', '--repo', repo, '--title', card.title, '--body', card.body, ...(l ? ['--label', l] : [])], { timeoutMs: 30_000 })),
  );
  return { id: `github:${number}`, source: 'github', ref: `#${number}`, title: card.title, body: clip(card.body), url, kind: card.kind, column: 'backlog', labels: label ? [label] : [], state: 'open', updatedAt: now };
}

export async function createLinear(exec: Exec, orca: string, team: string, card: NewCard, now = Date.now()): Promise<BoardCard> {
  const label = KIND_LABELS.linear[card.kind];
  // --write-id: se a resposta se perder, repetir com o mesmo id não cria outra issue.
  const writeId = randomUUID();
  const r = await withLabelFallback(label, async (l) =>
    orcaResult<{ issue?: LinearIssue } & Partial<LinearIssue>>(
      await exec(orca, ['linear', 'create', '--team', team, '--title', card.title, '--body', card.body, '--write-id', writeId, ...(l ? ['--label', l] : []), '--json'], { timeoutMs: 30_000 }),
    ),
  );
  const issue = (r.issue ?? r) as Partial<LinearIssue>;
  if (!issue.identifier || !issue.url) throw new CliError('o Linear não devolveu a issue criada');
  return {
    id: `linear:${issue.identifier}`,
    source: 'linear',
    ref: issue.identifier,
    title: issue.title ?? card.title,
    body: clip(card.body),
    url: issue.url,
    kind: card.kind,
    column: linearColumn(issue.state) ?? 'backlog',
    labels: label ? [label] : [],
    state: issue.state?.name ?? '',
    updatedAt: now,
  };
}

/** Comentário numa issue (o plano aprovado, depois o andamento). `ref`: "#12" ou "PRO-3". */
export async function commentIssue(exec: Exec, bins: { gh?: string; orca: string }, target: { source: 'github' | 'linear'; repo?: string; ref: string }, body: string): Promise<void> {
  if (target.source === 'github') {
    if (!bins.gh || !target.repo) throw new CliError('sem gh ou repositório');
    await exec(bins.gh, ['issue', 'comment', target.ref.replace(/^#/, ''), '--repo', target.repo, '--body', body], { timeoutMs: 30_000 });
  } else {
    orcaResult(await exec(bins.orca, ['linear', 'comment', 'add', target.ref, '--body', body, '--write-id', randomUUID(), '--json'], { timeoutMs: 30_000 }));
  }
}

/** Texto completo de uma issue (o card só guarda o começo da descrição): para editar. */
export interface IssueDetails {
  title: string;
  body: string;
  labels: string[];
}

export async function issueDetails(exec: Exec, bins: { gh?: string; orca: string }, target: { source: 'github' | 'linear'; repo?: string; ref: string }): Promise<IssueDetails> {
  if (target.source === 'github') {
    if (!bins.gh || !target.repo) throw new CliError('sem gh ou repositório');
    const out = await exec(bins.gh, ['issue', 'view', target.ref.replace(/^#/, ''), '--repo', target.repo, '--json', 'title,body,labels']);
    let d: { title?: string; body?: string; labels?: { name: string }[] };
    try {
      d = JSON.parse(out);
    } catch {
      throw new CliError('resposta do gh ilegível');
    }
    return { title: d.title ?? '', body: d.body ?? '', labels: (d.labels ?? []).map((l) => l.name) };
  }
  const r = orcaResult<{ issue?: LinearIssue } & Partial<LinearIssue>>(await exec(bins.orca, ['linear', 'issue', target.ref, '--json']));
  const i = (r.issue ?? r) as Partial<LinearIssue>;
  const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
  return { title: i.title ?? '', body: i.description ?? '', labels };
}

/**
 * Atualiza título, descrição e tipo de uma issue. O tipo troca a label de tipo (bug/enhancement no GitHub, Bug/Feature
 * no Linear) e mantém as outras labels. Label de tipo que não existe na fonte fica de fora (como na criação).
 */
export async function updateIssue(
  exec: Exec,
  bins: { gh?: string; orca: string },
  target: { source: 'github' | 'linear'; repo?: string; ref: string },
  edit: NewCard,
  current: IssueDetails,
): Promise<void> {
  const kindLabels = Object.values(KIND_LABELS[target.source]).map((l) => l!.toLowerCase());
  const wanted = KIND_LABELS[target.source][edit.kind];
  const others = current.labels.filter((l) => !kindLabels.includes(l.toLowerCase()));
  if (target.source === 'github') {
    if (!bins.gh || !target.repo) throw new CliError('sem gh ou repositório');
    const remove = current.labels.filter((l) => kindLabels.includes(l.toLowerCase()) && l !== wanted);
    const args = ['issue', 'edit', target.ref.replace(/^#/, ''), '--repo', target.repo, '--title', edit.title, '--body', edit.body];
    await withLabelFallback(wanted && !current.labels.includes(wanted) ? wanted : undefined, (add) =>
      exec(bins.gh!, [...args, ...(add ? ['--add-label', add] : []), ...remove.flatMap((l) => ['--remove-label', l])], { timeoutMs: 30_000 }),
    );
    return;
  }
  const labels = wanted ? [...others, wanted] : others;
  await withLabelFallback(wanted, async (l) =>
    orcaResult(
      await exec(
        bins.orca,
        ['linear', 'save-issue', target.ref, '--title', edit.title, '--description', edit.body, ...(l ? labels : others).flatMap((x) => ['--label', x]), '--write-id', randomUUID(), '--json'],
        { timeoutMs: 30_000 },
      ),
    ),
  );
}
