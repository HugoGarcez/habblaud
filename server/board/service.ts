// Quadro de tarefas dos projetos do Orca (ver shared/board.ts). Projetos: `orca project list` + `orca repo list`
// (caminho e GitHub do origin). Cards: GitHub ou Linear, conforme a configuração do projeto (store.ts); sem
// configuração, o GitHub quando o origin é do GitHub, senão o Linear quando há um time só.
//
// Tudo com cache curto: a página pede de novo ao abrir o quadro e a cada ~30 s enquanto ele está aberto.
import type { BoardIndex, BoardProject, BoardProjectConfig, BoardView, LinearTeam } from '../../shared/board';
import { tr } from '../../shared/i18n';
import { errMsg } from '../log';
import { CliError, execCli, orcaResult, type Exec } from './cli';
import { listGithub, listLinear, listLinearTeams } from './providers';
import type { BoardStore } from './store';

export const PROJECTS_TTL_MS = 60_000;
export const TEAMS_TTL_MS = 5 * 60_000;
export const VIEW_TTL_MS = 20_000;

export interface BoardServiceOptions {
  store: BoardStore;
  orca: string;
  /** Sem gh, projetos do GitHub mostram o aviso. */
  gh?: string;
  /** git (para ler o origin de cada repositório); padrão: `git` do PATH. */
  git?: string;
  exec?: Exec;
  now?: () => number;
}

interface OrcaProject {
  id: string;
  displayName: string;
  sourceRepoIds?: string[];
  providerIdentity?: { provider?: string; owner?: string; repo?: string } | null;
  gitRemoteIdentity?: { canonicalKey?: string } | null;
}

interface OrcaRepo {
  id: string;
  path?: string;
  displayName?: string;
}

interface Cached<T> {
  at: number;
  value: T;
}

/** "dono/repo" de uma URL do GitHub (https ou ssh); undefined para outros servidores. */
export function parseGithubUrl(url: string | undefined): string | undefined {
  const m = url ? /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim()) : null;
  return m?.[1];
}

/**
 * "dono/repo" do GitHub: o `origin` do repositório (`originUrl`, lido do git) vale mais que o do Orca, que pode
 * apontar outro remote (ex.: o upstream de um fork).
 */
export function githubRepoOf(p: OrcaProject, originUrl?: string): string | undefined {
  const origin = parseGithubUrl(originUrl);
  if (origin) return origin;
  const key = p.gitRemoteIdentity?.canonicalKey;
  const m = key ? /^github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i.exec(key) : null;
  if (m) return m[1];
  const id = p.providerIdentity;
  if (id?.provider === 'github' && id.owner && id.repo) return `${id.owner}/${id.repo}`;
  return undefined;
}

export class BoardService {
  private readonly exec: Exec;
  private readonly now: () => number;
  private projectsCache?: Cached<Omit<BoardProject, 'source' | 'linearTeam'>[]>;
  private teamsCache?: Cached<LinearTeam[] | null>;
  private views = new Map<string, Cached<BoardView>>();

  constructor(private readonly opts: BoardServiceOptions) {
    this.exec = opts.exec ?? execCli;
    this.now = opts.now ?? Date.now;
  }

  async index(): Promise<BoardIndex> {
    const [raw, teams] = await Promise.all([this.rawProjects(), this.linearTeams()]);
    return { projects: raw.map((p) => this.withConfig(p, teams ?? [])), linearTeams: teams ?? [], linear: teams !== null };
  }

  async view(projectId: string, refresh = false): Promise<BoardView | undefined> {
    const cached = this.views.get(projectId);
    if (!refresh && cached && this.now() - cached.at < VIEW_TTL_MS) return cached.value;
    const index = await this.index();
    const project = index.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const view: BoardView = { project, cards: [], fetchedAt: this.now() };
    try {
      if (project.source === 'github') {
        if (!project.github) view.error = tr('Este projeto não tem um repositório do GitHub (origin): escolha o Linear.');
        else if (!this.opts.gh) view.error = tr('A CLI do GitHub (gh) não foi encontrada neste computador.');
        else view.cards = await listGithub(this.exec, this.opts.gh, project.github, this.now());
      } else if (project.source === 'linear') {
        if (!project.linearTeam) view.error = tr('Escolha o time do Linear deste projeto.');
        else view.cards = await listLinear(this.exec, this.opts.orca, project.linearTeam, this.now());
      } else {
        view.error = tr('Escolha de onde vêm as tarefas deste projeto: GitHub ou Linear.');
      }
    } catch (err) {
      view.error = describeError(err, project.source);
    }
    view.cards.sort((a, b) => b.updatedAt - a.updatedAt);
    this.views.set(projectId, { at: this.now(), value: view });
    return view;
  }

  async setConfig(projectId: string, config: BoardProjectConfig): Promise<BoardProject | undefined> {
    const raw = (await this.rawProjects()).find((p) => p.id === projectId);
    if (!raw) return undefined;
    this.opts.store.setConfig(projectId, config);
    this.views.delete(projectId);
    return this.withConfig(raw, (await this.linearTeams()) ?? []);
  }

  private withConfig(p: Omit<BoardProject, 'source' | 'linearTeam'>, teams: LinearTeam[]): BoardProject {
    const saved = this.opts.store.config(p.id);
    if (saved) return { ...p, source: saved.source, ...(saved.linearTeam ? { linearTeam: saved.linearTeam } : {}) };
    if (p.github) return { ...p, source: 'github' };
    if (teams.length === 1) return { ...p, source: 'linear', linearTeam: teams[0].key };
    return { ...p, source: null };
  }

  private async rawProjects(): Promise<Omit<BoardProject, 'source' | 'linearTeam'>[]> {
    if (this.projectsCache && this.now() - this.projectsCache.at < PROJECTS_TTL_MS) return this.projectsCache.value;
    const [projects, repos] = await Promise.all([
      this.exec(this.opts.orca, ['project', 'list', '--json']).then((o) => orcaResult<{ projects: OrcaProject[] }>(o).projects ?? []),
      this.exec(this.opts.orca, ['repo', 'list', '--json']).then((o) => {
        const r = orcaResult<{ repos?: OrcaRepo[] } | OrcaRepo[]>(o);
        return Array.isArray(r) ? r : (r.repos ?? []);
      }),
    ]);
    const repoById = new Map(repos.map((r) => [r.id, r]));
    const value = (
      await Promise.all(
        projects.map(async (p) => {
          const repo = (p.sourceRepoIds ?? []).map((id) => repoById.get(id)).find(Boolean);
          const origin = repo?.path ? await this.originUrl(repo.path) : undefined;
          const github = githubRepoOf(p, origin);
          return { id: p.id, name: p.displayName, ...(repo?.path ? { path: repo.path } : {}), ...(github ? { github } : {}) };
        }),
      )
    ).sort((a, b) => a.name.localeCompare(b.name));
    this.projectsCache = { at: this.now(), value };
    return value;
  }

  private async originUrl(path: string): Promise<string | undefined> {
    try {
      return (await this.exec(this.opts.git ?? 'git', ['-C', path, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })).trim();
    } catch {
      return undefined;
    }
  }

  /** Times do Linear; null = Linear não conectado no Orca (ou fora do ar). */
  private async linearTeams(): Promise<LinearTeam[] | null> {
    if (this.teamsCache && this.now() - this.teamsCache.at < TEAMS_TTL_MS) return this.teamsCache.value;
    let value: LinearTeam[] | null;
    try {
      value = await listLinearTeams(this.exec, this.opts.orca);
    } catch {
      value = null;
    }
    this.teamsCache = { at: this.now(), value };
    return value;
  }
}

function describeError(err: unknown, source: BoardProject['source']): string {
  const msg = err instanceof CliError ? err.message : errMsg(err);
  if (source === 'github' && /disabled issues/i.test(msg)) return tr('As issues estão desligadas neste repositório do GitHub: ligue nas configurações do repositório ou escolha o Linear.');
  if (source === 'github' && /auth|login/i.test(msg)) return tr('O gh não está logado: rode gh auth login no computador.');
  return source === 'github' ? tr('O GitHub não respondeu: {0}', [msg]) : tr('O Linear não respondeu: {0}', [msg]);
}
