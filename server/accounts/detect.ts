// Detecção das contas do Claude Code (um config dir por conta) e dos seus metadados.
// Node puro e sem dependências: também é importado por scripts/docker-up.ts (via tsx) no host.
//
// Privacidade: do .claude.json lemos SOMENTE o e-mail e a organização do perfil da conta
// (oauthAccount.{emailAddress, organizationName}) e o cache de uso (cachedUsageUtilization);
// dos arquivos de shell, SOMENTE as linhas `alias X='... claude ...'`. Credenciais nunca são lidas
// e nada disso vai para o log.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface DetectedAccount {
  id: string;
  configDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: unknown;
}

/** Paleta fixa e bem distinta, atribuída na ordem estável das contas. */
export const ACCOUNT_COLORS = ['#f08a3c', '#4aa8e8', '#5cc97b', '#a77bf3', '#f06fa0'] as const;

const RC_FILES = ['.zshrc', '.bashrc', '.zprofile', '.bash_profile'];

/** Override vindo de CODETOWN_ACCOUNTS (o host passa os metadados prontos para o container). */
export interface AccountOverride {
  id?: string;
  configDir?: string;
  mountDir?: string;
  short?: string;
  name?: string;
  email?: string;
  organization?: string;
  plan?: string;
  color?: string;
  cachedUsage?: unknown;
}

export interface ClaudeAlias {
  /** Nome do alias, como digitado no shell (ex.: "d"). */
  name: string;
  /** Config dir absoluto do CLAUDE_CONFIG_DIR do alias; ausente = conta padrão ($HOME/.claude). */
  configDir?: string;
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expande `~`, `$HOME` e `${HOME}` e devolve o caminho absoluto sem barra final. */
export function expandHome(p: string, home: string): string {
  const expanded = p
    .trim()
    .replace(/^~(?=\/|$)/, home)
    .replace(/\$\{HOME\}|\$HOME\b/g, home);
  const abs = resolve(expanded);
  return abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isClaudeDir(p: string): boolean {
  return isDir(join(p, 'projects')) || isDir(join(p, 'sessions'));
}

export function isDefaultDir(dir: string, home: string): boolean {
  return resolve(dir) === resolve(home, '.claude');
}

export function parseAccountOverrides(raw: string | undefined): AccountOverride[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is AccountOverride => !!o && typeof o === 'object' && !Array.isArray(o));
  } catch {
    return [];
  }
}

/**
 * Config dirs observados. CODETOWN_CLAUDE_DIRS (lista separada por vírgula) substitui tudo;
 * senão: diretórios `$HOME/.claude*` com `projects/` ou `sessions/`, mais CLAUDE_CONFIG_DIR
 * (também aceita lista) e os `mountDir` de CODETOWN_ACCOUNTS que existirem.
 * Ordem estável: a conta padrão primeiro, depois alfabética.
 */
export function discoverClaudeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.CODETOWN_CLAUDE_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))];

  const found: string[] = [];
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.claude')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isClaudeDir(p)) found.push(p);
    }
  } catch {
    // $HOME ilegível (ex.: container sem home): segue com as outras fontes
  }
  for (const p of splitList(env.CLAUDE_CONFIG_DIR)) {
    const abs = expandHome(p, home);
    if (isDir(abs)) found.push(abs);
  }
  for (const o of parseAccountOverrides(env.CODETOWN_ACCOUNTS)) {
    if (typeof o.mountDir === 'string' && isClaudeDir(o.mountDir)) found.push(expandHome(o.mountDir, home));
  }
  const unique = [...new Set(found.map((p) => expandHome(p, home)))];
  return unique.sort((a, b) => {
    const da = isDefaultDir(a, home) ? 0 : 1;
    const db = isDefaultDir(b, home) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
}

const ALIAS_RE = /^\s*alias\s+([A-Za-z0-9_][A-Za-z0-9_.-]*)=(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\s*(?:#.*)?$/;
const INVOKES_CLAUDE = /(?:^|[\s;&|(])(?:[\w.~/-]*\/)?claude(?=$|[\s;&|)])/;
const CONFIG_DIR_RE = /\bCLAUDE_CONFIG_DIR=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/;

/**
 * Extrai os aliases de shell que invocam o `claude`. Considera SOMENTE linhas
 * `alias NOME='...'` (ou com aspas duplas); qualquer outra linha é ignorada.
 */
export function parseClaudeAliases(text: string, home: string): ClaudeAlias[] {
  const out: ClaudeAlias[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = ALIAS_RE.exec(line);
    if (!m) continue;
    const body = m[2] ?? m[3]?.replace(/\\(.)/g, '$1') ?? '';
    if (!INVOKES_CLAUDE.test(body)) continue;
    const dir = CONFIG_DIR_RE.exec(body);
    const raw = dir ? (dir[1] ?? dir[2] ?? dir[3]) : undefined;
    out.push(raw ? { name: m[1], configDir: expandHome(raw, home) } : { name: m[1] });
  }
  return out;
}

/** Lê os aliases do `claude` dos arquivos de inicialização do shell do usuário. */
export function readShellAliases(home: string): ClaudeAlias[] {
  const out: ClaudeAlias[] = [];
  for (const f of RC_FILES) {
    try {
      out.push(...parseClaudeAliases(readFileSync(join(home, f), 'utf8'), home));
    } catch {
      // arquivo inexistente/ilegível
    }
  }
  return out;
}

/** Escolhe o atalho de cada conta: o alias mais curto (até 3 caracteres); empate = o primeiro declarado. */
export function shortcutsByDir(aliases: ClaudeAlias[], home: string): Map<string, string> {
  const best = new Map<string, string>();
  const defaultDir = resolve(home, '.claude');
  for (const a of aliases) {
    if (a.name.length > 3) continue;
    const dir = a.configDir ?? defaultDir;
    const cur = best.get(dir);
    if (cur === undefined || a.name.length < cur.length) best.set(dir, a.name);
  }
  return new Map([...best].map(([dir, name]) => [dir, name.toUpperCase()]));
}

interface GlobalConfigInfo {
  email?: string;
  organization?: string;
  cachedUsage?: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Nome de organização que vale exibir. Contas pessoais recebem um nome gerado automaticamente
 * ("<e-mail>'s Organization"), que não diz nada e ainda aparece em inglês: fica de fora.
 */
export function meaningfulOrganization(organization: string | undefined, email: string | undefined): string | undefined {
  if (!organization) return undefined;
  const generic = /^(.+?)['’]s organi[sz]ation$/i.exec(organization.trim());
  if (generic && (!email || generic[1].trim().toLowerCase() === email.trim().toLowerCase() || generic[1].includes('@'))) return undefined;
  return organization;
}

/**
 * Lê do config global do Claude Code ($HOME/.claude.json para a conta padrão, <dir>/.claude.json
 * para as demais) apenas a identificação da conta e o cache de uso.
 */
export function readGlobalConfig(dir: string, home: string): GlobalConfigInfo {
  const candidates = isDefaultDir(dir, home) ? [join(home, '.claude.json'), join(dir, '.claude.json')] : [join(dir, '.claude.json')];
  let fallback: GlobalConfigInfo | undefined;
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const profile = j.oauthAccount && typeof j.oauthAccount === 'object' ? (j.oauthAccount as Record<string, unknown>) : undefined;
      const cache = j.cachedUsageUtilization && typeof j.cachedUsageUtilization === 'object' ? j.cachedUsageUtilization : undefined;
      const email = str(profile?.emailAddress);
      const info: GlobalConfigInfo = {
        email,
        organization: meaningfulOrganization(str(profile?.organizationName), email),
        cachedUsage: cache,
      };
      if (profile) return info;
      fallback ??= info;
    } catch {
      // JSON inválido (sendo gravado?): tenta o próximo candidato
    }
  }
  return fallback ?? {};
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return (
    overrides.find((o) => o.id === id) ??
    overrides.find((o) => norm(o.mountDir) === dir) ??
    overrides.find((o) => norm(o.configDir) === dir)
  );
}

/** Ids das contas (basename do dir), desambiguados se dois dirs tiverem o mesmo nome. */
export function accountIds(dirs: string[]): string[] {
  const seen = new Map<string, number>();
  return dirs.map((d) => {
    const base = basename(d) || d;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/**
 * Uma conta por config dir, NA MESMA ORDEM de `dirs`.
 * `configDir` é o caminho para exibição (no Docker, o do host, vindo de CODETOWN_ACCOUNTS).
 */
export function detectAccounts(dirs: string[], opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = parseAccountOverrides(env.CODETOWN_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home), home);
  const ids = accountIds(dirs);

  const partial = dirs.map((dir, i) => {
    const id = ids[i];
    const ov = matchOverride(overrides, id, resolve(dir), home);
    const cfg = readGlobalConfig(dir, home);
    return { dir, id, ov, cfg, short: str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir)) };
  });

  // Contas sem atalho detectado recebem A, B, C... (sem colidir com os atalhos já usados).
  const used = new Set(partial.map((p) => p.short).filter((s): s is string => !!s));
  let next = 0;
  const fallbackShort = () => {
    for (; next < 26; next++) {
      const letter = String.fromCharCode(65 + next);
      if (!used.has(letter)) {
        used.add(letter);
        return letter;
      }
    }
    return '?';
  };

  return partial.map((p, i) => {
    const short = p.short ?? fallbackShort();
    const acc: DetectedAccount = {
      id: p.id,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? `Conta ${short}`,
      color: str(p.ov?.color) ?? ACCOUNT_COLORS[i % ACCOUNT_COLORS.length],
    };
    const email = str(p.ov?.email) ?? p.cfg.email;
    const organization = meaningfulOrganization(str(p.ov?.organization) ?? p.cfg.organization, email);
    const plan = str(p.ov?.plan);
    const cachedUsage = p.ov?.cachedUsage ?? p.cfg.cachedUsage;
    if (email) acc.email = email;
    if (organization) acc.organization = organization;
    if (plan) acc.plan = plan;
    if (cachedUsage !== undefined) acc.cachedUsage = cachedUsage;
    return acc;
  });
}
