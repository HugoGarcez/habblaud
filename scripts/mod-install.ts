// Instala (ou remove) o mod do CodeTown no Claude Code de cada conta. Roda no HOST, com tsx:
//
//   npm run mod:install      # marketplace "codetown" (esta pasta) + plugins codetown e codetown-permissoes
//   npm run mod:uninstall    # tira os dois plugins e o marketplace de cada conta
//   npm run mod:status       # por conta: marketplace, plugins (e versões) e restos do jeito antigo
//   (opções: --sem-permissoes, --conta <pasta>, --dry-run, --claude <comando>)
//
// Tudo passa pelo CLI do próprio Claude Code (`claude plugin ...`), rodado uma vez por conta com o
// CLAUDE_CONFIG_DIR daquela conta, como faz o atalho do shell (`alias d='CLAUDE_CONFIG_DIR=... claude'`). Assim
// quem grava os registros (enabledPlugins e extraKnownMarketplaces no settings.json, <conta>/plugins/*.json) é o
// Claude Code, no formato que ele conhece: este script não edita esses campos.
//
// O marketplace é ESTA pasta (.claude-plugin/marketplace.json na raiz do repositório), adicionado como diretório
// local: o Claude Code carrega os plugins direto de mod/codetown e mod/codetown-permissoes, sem copiar. Depois de
// um `git pull`, sessões novas (ou /reload-plugins) já rodam o código novo; o `claude plugin update` acerta a
// versão registrada (o `npm run docker:up` faz isso sozinho para quem já instalou).
//
// Migração do jeito antigo: o mod grava o uso no mesmo arquivo do tap de statusline (usage:install) e o plugin
// de permissões faz o mesmo que o settings hook PermissionRequest (hooks:install). Na instalação, cada um sai do
// settings.json da conta (com backup), pelas funções dos instaladores antigos, para não ficarem dois capturando
// o uso nem dois respondendo o mesmo pedido. Com --sem-permissoes, o hook antigo fica como está.
//
// Status (e o plano de cada conta): vem de `claude plugin list --json` e `claude plugin marketplace list --json`,
// saídas documentadas que já resolvem escopo, ligado/desligado e CLAUDE_CODE_PLUGIN_CACHE_DIR. Os arquivos
// <conta>/plugins/installed_plugins.json e known_marketplaces.json são internos do Claude Code e podem mudar de
// formato (o primeiro já está na versão 2).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverClaudeDirs, expandHome, isDefaultDir } from '../server/accounts/detect';
import { DEFAULT_PORT, installedHook, planUninstall as planHookUninstall } from './hooks-install';
import {
  formatAge,
  isTapCommand,
  planUninstall as planTapUninstall,
  readSettings,
  tildify,
  usageDirOf,
  writeSettings,
  type Settings,
} from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Nome do marketplace em .claude-plugin/marketplace.json (contrato com mod/). */
export const MARKETPLACE = 'codetown';
/** O mod: uso do plano, aviso de "precisa de você" no terminal e /codetown. */
export const MOD_PLUGIN = `codetown@${MARKETPLACE}`;
/** O settings hook PermissionRequest de responder pelo escritório, empacotado como plugin. */
export const PERMISSIONS_PLUGIN = `codetown-permissoes@${MARKETPLACE}`;
/** Primeira versão do Claude Code (terminal) que carrega mods. */
export const MIN_CLAUDE_VERSION = '2.1.287';
/** Os plugins vão sempre para o escopo do usuário: valem em todos os projetos da conta. */
const SCOPE = 'user';
/** Tempo máximo de cada chamada ao CLI (o add/update de um diretório local leva poucos segundos). */
const CLI_TIMEOUT_MS = 120_000;

const USAGE = `Uso: npm run mod:<install|uninstall|status> [-- opções]

  install     instala o mod do CodeTown no Claude Code de cada conta (marketplace desta pasta + plugins)
              e tira o tap de statusline e o hook de permissão antigos, que o mod substitui
  uninstall   tira os plugins e o marketplace do CodeTown de cada conta
  status      mostra, por conta, o marketplace, os plugins (e versões) e o que sobrou do jeito antigo

Opções:
  --sem-permissoes   não instala o plugin de responder permissões pelo escritório (e mantém o hook antigo)
  --conta <pasta>    só esta conta (ex.: --conta ~/.claude-conta2); pode repetir
  --dry-run          mostra o que faria, sem instalar nem gravar nada
  --claude <cmd>     comando do Claude Code (padrão: claude, do PATH)
  -h, --help         mostra esta ajuda

Precisa do Claude Code ${MIN_CLAUDE_VERSION} ou mais novo. Em versões anteriores, use o jeito antigo:
npm run usage:install (uso ao vivo) e npm run hooks:install (responder permissões).

Contas: as mesmas do servidor (~/.claude* com projects/ ou sessions/, CLAUDE_CONFIG_DIR ou
CODETOWN_CLAUDE_DIRS). Uso capturado em CODETOWN_USAGE_DIR (padrão ~/.codetown/usage).`;

// ---------------------------------------------------------------------------------------------
// O CLI do Claude Code (injetável: os testes nunca chamam o de verdade)
// ---------------------------------------------------------------------------------------------

export interface ClaudeResult {
  /** Código de saída (null se nem chegou a rodar ou foi morto). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Falha ao iniciar o processo (ex.: `claude` fora do PATH). */
  error?: string;
}

/** Roda `claude <args>` com o ambiente dado (o CLAUDE_CONFIG_DIR da conta vem nele). */
export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => ClaudeResult;

/** O runner de verdade. stdin fechado: nada fica esperando uma resposta no terminal. */
export function makeClaudeRunner(cmd = 'claude'): ClaudeRunner {
  return (args, env) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT' ? `o comando "${cmd}" não foi encontrado no PATH` : code === 'ETIMEDOUT' ? `"${cmd} ${args.join(' ')}" não terminou em ${CLI_TIMEOUT_MS / 1000} s` : r.error.message;
      return { code: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error };
    }
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

/**
 * Ambiente do CLI para uma conta. A conta padrão (~/.claude) roda SEM CLAUDE_CONFIG_DIR, como o `claude` puro:
 * com a variável apontando para ~/.claude, o Claude Code passaria a usar ~/.claude/.claude.json em vez de
 * ~/.claude.json. E a variável herdada (ex.: rodando de dentro de uma sessão da outra conta) nunca vaza.
 */
export function accountEnv(env: NodeJS.ProcessEnv, dir: string, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (isDefaultDir(dir, home)) delete out.CLAUDE_CONFIG_DIR;
  else out.CLAUDE_CONFIG_DIR = dir;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/mod-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** "2.1.293 (Claude Code)" → [2, 1, 293]. */
export function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Sem códigos de cor do terminal. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * JSON da saída do CLI, com tolerância: a saída inteira, ou a partir da primeira linha que abre um JSON (avisos
 * antes dele), ou só a última linha (formato de resultado do `--json` das ações). undefined se nada servir.
 */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripAnsi(stdout).trim();
  if (!text) return undefined;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(text);
  if (whole !== undefined) return whole;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*[[{]/.test(l));
  if (start > 0) {
    const fromStart = tryParse(lines.slice(start).join('\n'));
    if (fromStart !== undefined) return fromStart;
  }
  return tryParse(lines[lines.length - 1]);
}

/** Uma instalação de plugin, como `claude plugin list --json` mostra (só o que usamos). */
export interface PluginInfo {
  id: string;
  version?: string;
  scope?: string;
  enabled: boolean;
  /** Pasta de onde carrega, quando lido no lugar a partir de um marketplace local (Claude Code 2.1.289+). */
  readFromFolder?: string;
  /** Versão do manifesto nessa pasta (pode ser mais nova que a registrada). */
  folderVersion?: string;
  errors: string[];
}

/** Lista de plugins instalados; aceita o array ou o objeto de `--available` ({installed: [...]}). */
export function parsePluginList(stdout: string): PluginInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  const list = Array.isArray(raw) ? raw : rec(raw) && Array.isArray(rec(raw)!.installed) ? (rec(raw)!.installed as unknown[]) : undefined;
  if (!list) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const out: PluginInfo[] = [];
  for (const item of list) {
    const r = rec(item);
    const id = str(r?.id);
    if (!r || !id) continue;
    out.push({
      id,
      version: str(r.version),
      scope: str(r.scope),
      enabled: r.enabled !== false,
      readFromFolder: str(r.readFromFolder),
      folderVersion: str(r.folderVersion),
      errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string') : [],
    });
  }
  return out;
}

export interface MarketplaceInfo {
  name: string;
  source?: string;
  /** Pasta (marketplaces de diretório ou arquivo local). */
  path?: string;
}

export function parseMarketplaceList(stdout: string): MarketplaceInfo[] | undefined {
  const raw = parseJsonOutput(stdout);
  if (!Array.isArray(raw)) return undefined;
  const out: MarketplaceInfo[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || typeof r.name !== 'string') continue;
    const m: MarketplaceInfo = { name: r.name };
    if (typeof r.source === 'string') m.source = r.source;
    const path = typeof r.path === 'string' ? r.path : typeof r.installLocation === 'string' && r.source === 'directory' ? r.installLocation : undefined;
    if (path) m.path = path;
    out.push(m);
  }
  return out;
}

/** O que uma conta tem do CodeTown no Claude Code. */
export interface AccountState {
  marketplace?: MarketplaceInfo;
  plugins: PluginInfo[];
}

/** A instalação de `id` no escopo do usuário (o único que este script gerencia). */
export function userInstall(state: AccountState, id: string): PluginInfo | undefined {
  return state.plugins.find((p) => p.id === id && (p.scope === SCOPE || p.scope === undefined));
}

/** Uma chamada ao CLI, com a frase que conta o que ela faz. */
export interface CliStep {
  args: string[];
  /** "codetown: instalado" (vira ✓, ~ ou ✗ na saída). */
  message: string;
  /** Plugin que depende deste passo (falhou = não conta como instalado). */
  plugin?: string;
}

/** Item do plano, na ordem da saída: uma chamada ao CLI ou algo que já está certo (vira "="). */
export type PlanItem = CliStep | { unchanged: string };

export interface InstallPlan {
  items: PlanItem[];
  /** Avisos que não impedem a instalação. */
  notes: string[];
  /** Plugins que ficam instalados se todos os passos derem certo. */
  plugins: string[];
}

/** Só as chamadas ao CLI de um plano. */
export function cliSteps(plan: InstallPlan): CliStep[] {
  return plan.items.filter((i): i is CliStep => 'args' in i);
}

export interface PlanOptions {
  /** Raiz do repositório (onde está .claude-plugin/marketplace.json). */
  root: string;
  /** Versão do package.json (= versão dos plugins). */
  version: string;
  /** Instalar também o plugin de permissões. */
  permissions: boolean;
  /** Compara pastas (padrão: caminho real). */
  sameDir?: (a: string, b: string) => boolean;
}

/** Mesma pasta, resolvendo symlinks quando der. */
export function sameDir(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(a) === real(b);
}

const shortName = (id: string) => id.split('@')[0];

/**
 * Passos de instalação de uma conta, a partir do que ela já tem. O marketplace é adicionado (ou, se já existe,
 * tem o catálogo relido; se apontava para outra pasta, passa a apontar para esta). Cada plugin é instalado,
 * religado (se estava desligado) ou atualizado (se a versão registrada difere da do package.json).
 */
export function planInstall(state: AccountState, o: PlanOptions): InstallPlan {
  const same = o.sameDir ?? sameDir;
  const plan: InstallPlan = { items: [], notes: [], plugins: [] };
  const m = state.marketplace;
  if (!m) {
    plan.items.push({ args: ['plugin', 'marketplace', 'add', o.root], message: `marketplace ${MARKETPLACE}: adicionado (esta pasta)` });
  } else if (m.path && same(m.path, o.root)) {
    plan.items.push({ args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: `marketplace ${MARKETPLACE}: catálogo relido desta pasta` });
  } else {
    // Outra pasta (o CodeTown mudou de lugar) ou outra origem: o add com a mesma chave só troca a origem e
    // mantém os plugins instalados.
    plan.items.push({
      args: ['plugin', 'marketplace', 'add', o.root],
      message: `marketplace ${MARKETPLACE}: passou a apontar para esta pasta (antes: ${m.path ?? m.source ?? 'outra origem'})`,
    });
  }
  const wanted = o.permissions ? [MOD_PLUGIN, PERMISSIONS_PLUGIN] : [MOD_PLUGIN];
  for (const id of wanted) {
    const name = shortName(id);
    const cur = userInstall(state, id);
    if (!cur) {
      plan.items.push({ args: ['plugin', 'install', id, '--scope', SCOPE], message: `${name}: instalado`, plugin: id });
      plan.plugins.push(id);
      continue;
    }
    plan.plugins.push(id);
    let touched = false;
    if (!cur.enabled) {
      plan.items.push({ args: ['plugin', 'enable', id, '--scope', SCOPE], message: `${name}: religado (estava desligado)`, plugin: id });
      touched = true;
    }
    if (cur.version !== o.version) {
      plan.items.push({ args: ['plugin', 'update', id, '--scope', SCOPE], message: `${name}: atualizado de ${cur.version ?? '?'} para ${o.version}`, plugin: id });
      touched = true;
    }
    if (!touched) plan.items.push({ unchanged: `${name}: já instalado na versão ${o.version}` });
  }
  // Com --sem-permissoes, um plugin de permissões já instalado continua (e acompanha a versão do mod).
  const perm = !o.permissions ? userInstall(state, PERMISSIONS_PLUGIN) : undefined;
  if (perm) {
    if (perm.version !== o.version) {
      plan.items.push({
        args: ['plugin', 'update', PERMISSIONS_PLUGIN, '--scope', SCOPE],
        message: `${shortName(PERMISSIONS_PLUGIN)}: atualizado de ${perm.version ?? '?'} para ${o.version}`,
        plugin: PERMISSIONS_PLUGIN,
      });
    }
    plan.plugins.push(PERMISSIONS_PLUGIN);
    plan.notes.push(
      `${shortName(PERMISSIONS_PLUGIN)} já estava instalado e continua (--sem-permissoes não o remove; para tirar: claude plugin uninstall ${PERMISSIONS_PLUGIN})`,
    );
  }
  return plan;
}

/**
 * Passos de remoção: os plugins do escopo do usuário e o marketplace, só o que existir. (Tirar o marketplace já
 * desinstalaria o que veio dele, mas um passo por plugin deixa claro, na saída, o que saiu.)
 */
export function planUninstall(state: AccountState): InstallPlan {
  const plan: InstallPlan = { items: [], notes: [], plugins: [] };
  for (const id of [MOD_PLUGIN, PERMISSIONS_PLUGIN]) {
    const name = shortName(id);
    if (userInstall(state, id)) plan.items.push({ args: ['plugin', 'uninstall', id, '--scope', SCOPE], message: `${name}: removido`, plugin: id });
    else plan.items.push({ unchanged: `${name}: não estava instalado` });
  }
  if (state.marketplace) plan.items.push({ args: ['plugin', 'marketplace', 'remove', MARKETPLACE], message: `marketplace ${MARKETPLACE}: removido` });
  else plan.items.push({ unchanged: `marketplace ${MARKETPLACE}: não estava adicionado` });
  return plan;
}

export interface MigrationPlan {
  /** settings.json novo, se algo mudou. */
  settings?: Settings;
  /** O que foi tirado (vira ✓). */
  done: string[];
  /** O que ficou e por quê (vira "="). */
  kept: string[];
  /** Formatos que não dá para mexer com segurança (vira "!"). */
  warnings: string[];
}

/**
 * Tira do settings.json o que o mod substitui: o tap de statusline (se o mod ficou instalado) e o hook de
 * permissão antigo (se o plugin de permissões ficou instalado). Uma gravação só, para um backup só.
 */
export function planMigration(settings: Settings, o: { modInstalled: boolean; permissionsInstalled: boolean; permissions: boolean }): MigrationPlan {
  const out: MigrationPlan = { done: [], kept: [], warnings: [] };
  let next = settings;
  const sl = rec(settings.statusLine);
  if (sl && isTapCommand(sl.command)) {
    if (!o.modInstalled) out.kept.push('tap de statusline antigo mantido (o mod não ficou instalado)');
    else {
      const p = planTapUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(`tap de statusline antigo removido: o mod grava o uso no lugar dele (${p.message})`);
      } else if (p.action === 'skip') out.warnings.push(`tap de statusline antigo: ${p.message} (rode npm run usage:uninstall depois de conferir)`);
    }
  }
  if (installedHook(next)) {
    if (!o.permissions) out.kept.push('hook de permissão antigo mantido (--sem-permissoes)');
    else if (!o.permissionsInstalled) out.kept.push('hook de permissão antigo mantido (o plugin de permissões não ficou instalado)');
    else {
      const p = planHookUninstall(next);
      if (p.action === 'uninstall') {
        next = p.settings;
        out.done.push(`hook de permissão antigo removido: o plugin ${shortName(PERMISSIONS_PLUGIN)} responde no lugar dele`);
      } else if (p.action === 'skip') out.warnings.push(`hook de permissão antigo: ${p.message} (rode npm run hooks:uninstall depois de conferir)`);
    }
  }
  if (next !== settings) out.settings = next;
  return out;
}

/** Diferenças entre o que deveria ter ficado instalado e o que o Claude Code registra depois dos passos. */
export function verifyInstall(after: AccountState, plugins: string[], version: string): string[] {
  const out: string[] = [];
  for (const id of plugins) {
    const p = userInstall(after, id);
    const name = shortName(id);
    if (!p) out.push(`${name}: não aparece instalado na lista do Claude Code`);
    else if (!p.enabled) out.push(`${name}: instalado, mas desligado (claude plugin enable ${id})`);
    else if (p.version !== version) out.push(`${name}: o Claude Code registra a versão ${p.version ?? '?'}, não a ${version} (o manifesto em mod/ está com outra versão?)`);
    if (p?.errors.length) out.push(`${name}: ${p.errors.join('; ')}`);
  }
  return out;
}

/** Para o docker:up: atualiza só o que já está instalado, nunca instala. */
export type UpdatePlan =
  | { action: 'none'; installed: boolean }
  | { action: 'update'; steps: CliStep[] }
  | { action: 'warn'; message: string };

export function planUpdate(state: AccountState, o: { root: string; version: string; sameDir?: (a: string, b: string) => boolean }): UpdatePlan {
  const same = o.sameDir ?? sameDir;
  const installed = [MOD_PLUGIN, PERMISSIONS_PLUGIN].map((id) => userInstall(state, id)).filter((p): p is PluginInfo => !!p);
  if (!installed.length) return { action: 'none', installed: false };
  const stale = installed.filter((p) => p.version !== o.version);
  if (!stale.length) return { action: 'none', installed: true };
  // Marketplace de outra pasta (outro clone, pasta movida): atualizar dali não traria esta versão.
  const m = state.marketplace;
  if (!m) return { action: 'warn', message: `o mod está instalado, mas o marketplace ${MARKETPLACE} sumiu; rode npm run mod:install` };
  if (!m.path || !same(m.path, o.root)) {
    return { action: 'warn', message: `o mod vem de outra pasta (${m.path ?? m.source ?? '?'}), então não foi atualizado; para usar esta: npm run mod:install` };
  }
  return {
    action: 'update',
    steps: [
      { args: ['plugin', 'marketplace', 'update', MARKETPLACE], message: `marketplace ${MARKETPLACE}: catálogo relido` },
      ...stale.map((p) => ({ args: ['plugin', 'update', p.id, '--scope', SCOPE], message: `${shortName(p.id)}: ${p.version ?? '?'} → ${o.version}`, plugin: p.id })),
    ],
  };
}

/** Últimas linhas úteis da saída do CLI (para explicar uma falha). */
export function cliMessage(r: ClaudeResult): string {
  if (r.error) return r.error;
  const lines = stripAnsi(`${r.stdout}\n${r.stderr}`)
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s✘✔✗✓×]+/, '').trim())
    .filter(Boolean);
  return lines.slice(-2).join(' · ') || `saiu com código ${r.code ?? '?'}`;
}

/** Linhas do status de uma conta (sem o cabeçalho). */
export function describeStatus(state: AccountState, settings: Settings, o: { root: string; version: string; home: string; sameDir?: (a: string, b: string) => boolean }): string[] {
  const same = o.sameDir ?? sameDir;
  const lines: string[] = [];
  const m = state.marketplace;
  if (!m) lines.push(`marketplace ${MARKETPLACE}: não adicionado`);
  else if (m.path && same(m.path, o.root)) lines.push(`marketplace ${MARKETPLACE}: esta pasta`);
  else lines.push(`marketplace ${MARKETPLACE}: outra origem (${m.path ? tildify(m.path, o.home) : (m.source ?? '?')}); npm run mod:install aponta para esta pasta`);
  for (const id of [MOD_PLUGIN, PERMISSIONS_PLUGIN]) {
    const name = shortName(id);
    const all = state.plugins.filter((p) => p.id === id);
    if (!all.length) {
      lines.push(`${name}: não instalado`);
      continue;
    }
    for (const p of all) {
      const parts = [`instalado${p.scope && p.scope !== SCOPE ? ` (escopo ${p.scope})` : ''}`, p.enabled ? 'ligado' : 'desligado'];
      parts.push(`versão ${p.version ?? '?'}${p.version === o.version ? '' : ` (esta pasta: ${o.version}; npm run mod:install ou npm run docker:up atualiza)`}`);
      if (p.folderVersion && p.folderVersion !== p.version) parts.push(`carrega ${p.folderVersion} de ${tildify(p.readFromFolder ?? '?', o.home)}`);
      if (p.errors.length) parts.push(`erro: ${p.errors.join('; ')}`);
      lines.push(`${name}: ${parts.join(', ')}`);
    }
  }
  const sl = rec(settings.statusLine);
  const hook = installedHook(settings);
  const modOn = !!userInstall(state, MOD_PLUGIN);
  const permOn = !!userInstall(state, PERMISSIONS_PLUGIN);
  if (sl && isTapCommand(sl.command)) {
    lines.push(
      modOn
        ? '! tap de statusline antigo ainda instalado junto com o mod: npm run mod:install tira (ou npm run usage:uninstall)'
        : 'tap de statusline antigo instalado (jeito antigo; o mod o substitui)',
    );
  }
  if (hook) {
    lines.push(
      permOn
        ? '! hook de permissão antigo ainda no settings.json junto com o plugin: os dois respondem; npm run mod:install tira (ou npm run hooks:uninstall)'
        : 'hook de permissão antigo instalado (jeito antigo; o plugin de permissões o substitui)',
    );
  }
  if (settings.disableAllHooks === true) lines.push('! disableAllHooks está ligado no settings.json desta conta: nenhum mod (nem hook) roda');
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Efeitos (CLI do Claude Code e settings.json)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** false com --sem-permissoes. */
  permissions: boolean;
  /** --conta (vazio = todas as detectadas). */
  accounts: string[];
  claudeCmd?: string;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  /** Raiz do repositório (o marketplace). */
  root: string;
  /** Versão do package.json. */
  version: string;
  claude: ClaudeRunner;
  out: (line: string) => void;
  /** Consulta o /api/health do CodeTown no status (testes injetam um falso). */
  health?: (port: number) => Promise<{ permissions?: boolean } | undefined>;
}

class FatalError extends Error {}

async function fetchHealth(port: number): Promise<{ permissions?: boolean } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as { permissions?: boolean };
  } catch {
    return undefined;
  }
}

/** Porta do CodeTown (CODETOWN_PORT ou a padrão). */
function codetownPort(env: NodeJS.ProcessEnv): number {
  const p = Number.parseInt(env.CODETOWN_PORT ?? '', 10);
  return Number.isInteger(p) && p > 0 && p < 65_536 ? p : DEFAULT_PORT;
}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let permissions = true;
  let claudeCmd: string | undefined;
  const accounts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--sem-permissoes') permissions = false;
    else if (a === '--conta') {
      const dir = argv[++i];
      if (!dir) throw new FatalError('--conta precisa da pasta da conta (ex.: --conta ~/.claude-conta2).');
      accounts.push(dir);
    } else if (a === '--claude') {
      claudeCmd = argv[++i];
      if (!claudeCmd) throw new FatalError('--claude precisa de um comando ou caminho.');
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
  }
  if (!command) throw new FatalError(`diga o que fazer: install, uninstall ou status.\n\n${USAGE}`);
  return { command, dryRun, permissions, accounts, claudeCmd };
}

/** Versão do package.json da raiz. */
export function readPackageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version) throw new FatalError(`package.json sem "version" em ${root}`);
  return pkg.version;
}

/** Marketplace e plugins de uma conta, pelo CLI (ou o motivo de não conseguir). */
export function readAccountState(claude: ClaudeRunner, env: NodeJS.ProcessEnv): AccountState | { error: string } {
  const mr = claude(['plugin', 'marketplace', 'list', '--json'], env);
  if (mr.error || mr.code !== 0) return { error: `não consegui listar os marketplaces (${cliMessage(mr)})` };
  const markets = parseMarketplaceList(mr.stdout);
  if (!markets) return { error: 'não entendi a lista de marketplaces do Claude Code' };
  const pr = claude(['plugin', 'list', '--json'], env);
  if (pr.error || pr.code !== 0) return { error: `não consegui listar os plugins (${cliMessage(pr)})` };
  const plugins = parsePluginList(pr.stdout);
  if (!plugins) return { error: 'não entendi a lista de plugins do Claude Code' };
  return { marketplace: markets.find((m) => m.name === MARKETPLACE), plugins };
}

/** Pastas das contas: as de --conta (que precisam existir) ou as detectadas. */
function accountDirs(opts: RunOptions, env: NodeJS.ProcessEnv, home: string): string[] {
  if (!opts.accounts.length) return discoverClaudeDirs(env, home);
  return [...new Set(opts.accounts.map((a) => expandHome(a, home)))].map((dir) => {
    let ok = false;
    try {
      ok = statSync(dir).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new FatalError(`--conta ${dir}: pasta não encontrada.`);
    return dir;
  });
}

/** Último uso capturado (pelo mod ou pelo tap) de uma conta, para o status. */
function lastCapture(dir: string, env: NodeJS.ProcessEnv, home: string, now: Date): string {
  const file = join(usageDirOf(env, home), `${basename(dir)}.json`);
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Rec;
    const at = typeof j.fetchedAt === 'number' ? j.fetchedAt : statSync(file).mtimeMs;
    return `último uso capturado há ${formatAge(now.getTime() - at)} (${j.source === 'mod' ? 'pelo mod' : 'pelo tap de statusline'})`;
  } catch {
    return 'nenhum uso capturado ainda (chega depois da próxima resposta numa sessão aberta desta conta)';
  }
}

/** Executa o comando para todas as contas. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const dirs = accountDirs(opts, env, home);
  if (!dirs.length) {
    out('Nenhuma conta do Claude Code encontrada (~/.claude* com projects/ ou sessions/). Use --conta <pasta> ou CODETOWN_CLAUDE_DIRS.');
    return 1;
  }
  const manifest = join(ctx.root, '.claude-plugin', 'marketplace.json');
  if (opts.command === 'install' && !existsSync(manifest)) {
    out(`Não achei ${tildify(manifest, home)}: esta pasta não tem o mod (versão antiga do CodeTown? rode git pull).`);
    return 1;
  }

  // Uma versão só: todas as contas usam o mesmo executável, só muda o CLAUDE_CONFIG_DIR.
  const vr = ctx.claude(['--version'], env);
  if (vr.error) {
    out(`Não consegui rodar o Claude Code: ${vr.error}.`);
    out('Instale o Claude Code (https://code.claude.com) ou diga onde ele está: npm run mod:<comando> -- --claude <caminho>');
    return 1;
  }
  const cliVersion = parseVersion(vr.stdout) ? parseVersion(vr.stdout)!.join('.') : undefined;
  if (opts.command === 'install') {
    if (!cliVersion) out(`! Não entendi a versão do Claude Code ("${cliMessage(vr)}"); sigo assim mesmo.`);
    else if (!versionAtLeast(cliVersion, MIN_CLAUDE_VERSION)) {
      out(`O mod precisa do Claude Code ${MIN_CLAUDE_VERSION} ou mais novo, e este é o ${cliVersion}.`);
      out('Atualize o Claude Code (claude update) e rode de novo. Ou use o jeito antigo, que funciona em versões anteriores:');
      out('  npm run usage:install    # uso de 5h/semanal ao vivo (tap de statusline)');
      out('  npm run hooks:install    # responder pedidos de permissão pelo escritório');
      return 1;
    }
  }
  if (opts.command === 'status') {
    out(`Claude Code ${cliVersion ?? '(versão desconhecida)'}${cliVersion && !versionAtLeast(cliVersion, MIN_CLAUDE_VERSION) ? ` — o mod precisa do ${MIN_CLAUDE_VERSION}+` : ''} · CodeTown ${ctx.version} em ${tildify(ctx.root, home)}`);
  }

  // O mod grava o uso em ~/.codetown/usage, mas não cria a pasta (o docker:up também a monta no container).
  if (opts.command === 'install' && !opts.dryRun) {
    const usageDir = usageDirOf(env, home);
    try {
      if (!existsSync(usageDir)) {
        mkdirSync(usageDir, { recursive: true, mode: 0o700 });
        out(`✓ pasta do uso criada: ${tildify(usageDir, home)}`);
      }
    } catch (err) {
      out(`! não consegui criar ${tildify(usageDir, home)} (${(err as Error).message}); o uso ao vivo não vai ser gravado`);
    }
  }

  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const label = `${basename(dir)} (${tildify(dir, home)})`;
    const cenv = accountEnv(env, dir, home);
    const state = readAccountState(ctx.claude, cenv);
    const file = join(dir, 'settings.json');
    if (opts.command === 'status') {
      out(`• ${label}`);
      const read = readSettings(file);
      const settings = 'error' in read ? {} : read.settings;
      if ('error' in read) out(`    ✗ settings.json: ${read.error}`);
      if ('error' in state) {
        out(`    ✗ ${state.error}`);
        failures++;
      } else for (const l of describeStatus(state, settings, { root: ctx.root, version: ctx.version, home })) out(`    ${l}`);
      out(`    ${lastCapture(dir, env, home, ctx.now)}`);
      continue;
    }

    out(`${label}:`);
    if ('error' in state) {
      out(`  ✗ ${state.error}`);
      failures++;
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(state, { root: ctx.root, version: ctx.version, permissions: opts.permissions }) : planUninstall(state);
    const failed = new Set<string>();
    let broken = false;
    for (const item of plan.items) {
      if (!('args' in item)) {
        out(`  = ${item.unchanged}`);
        continue;
      }
      if (opts.dryRun) {
        out(`  ~ ${item.message} (simulação: claude ${item.args.join(' ')})`);
        continue;
      }
      // Na instalação, depois de uma falha os passos seguintes desta conta não rodam (sem marketplace não há
      // plugin). Na remoção, segue: o que der para tirar, sai.
      if (broken && opts.command === 'install') {
        if (item.plugin) failed.add(item.plugin);
        continue;
      }
      const r = ctx.claude(item.args, cenv);
      if (!r.error && r.code === 0) {
        out(`  ✓ ${item.message}`);
        changed++;
      } else {
        out(`  ✗ ${item.message.split(':')[0]}: falhou (${cliMessage(r)})`);
        if (item.plugin) failed.add(item.plugin);
        broken = true;
      }
    }
    if (broken) failures++;
    for (const n of plan.notes) out(`  ! ${n}`);
    if (opts.command !== 'install') continue;

    // Confere com o próprio Claude Code o que ficou instalado (um update sem efeito também sai com 0) e decide a
    // migração por isso. Na simulação (ou se a lista falhar), vale o plano menos o que deu erro.
    let ok = (id: string) => plan.plugins.includes(id) && !failed.has(id);
    if (!opts.dryRun) {
      const after = readAccountState(ctx.claude, cenv);
      if (!('error' in after)) {
        for (const w of verifyInstall(after, plan.plugins, ctx.version)) out(`  ! ${w}`);
        ok = (id: string) => userInstall(after, id)?.enabled === true;
      }
    }

    // Migração: lê o settings.json DEPOIS do CLI (ele também grava ali: enabledPlugins, marketplaces).
    const read = readSettings(file);
    if ('error' in read) {
      out(`  ✗ settings.json: ${read.error}; o tap e o hook antigos não foram conferidos`);
      failures++;
      continue;
    }
    const mig = planMigration(read.settings, { modInstalled: ok(MOD_PLUGIN), permissionsInstalled: ok(PERMISSIONS_PLUGIN), permissions: opts.permissions });
    for (const k of mig.kept) out(`  = ${k}`);
    for (const w of mig.warnings) out(`  ! ${w}`);
    if (read.settings.disableAllHooks === true) out('  ! disableAllHooks está ligado no settings.json desta conta: o mod não roda até você desligar');
    if (!mig.settings) continue;
    if (opts.dryRun) {
      for (const d of mig.done) out(`  ~ ${d} (simulação: nada gravado)`);
      continue;
    }
    try {
      const backup = writeSettings(file, mig.settings, read.raw, ctx.now);
      for (const d of mig.done) out(`  ✓ ${d}`);
      if (backup) out(`    backup do settings.json em ${tildify(backup, home)}`);
      changed++;
    } catch (err) {
      out(`  ✗ não consegui gravar o settings.json (${(err as Error).message}); o tap e o hook antigos continuam`);
      failures++;
    }
  }

  if (opts.command === 'install' && !opts.dryRun && !failures) {
    out('');
    out('Pronto. Sessões novas do Claude Code já carregam o mod; nas que já estão abertas, rode /reload-plugins (ou');
    out('reabra a sessão). O uso de 5h/semanal chega ao CodeTown depois da próxima resposta de cada sessão.');
    out('Para conferir: npm run mod:status · Para desfazer: npm run mod:uninstall');
  }
  if (opts.command === 'uninstall' && !opts.dryRun && changed) {
    out('');
    out('Pronto. Sessões já abertas continuam com o mod até /reload-plugins (ou até reabrir a sessão).');
    out('Para voltar ao jeito antigo (Claude Code anterior ao 2.1.287): npm run usage:install e npm run hooks:install');
  }
  if (opts.command === 'status') {
    // O mod e o plugin de permissões só falam com o CodeTown local: diz se ele está lá para responder.
    const port = codetownPort(env);
    const health = await (ctx.health ?? fetchHealth)(port);
    const at = `CodeTown em http://127.0.0.1:${port}`;
    if (!health) out(`${at}: fora do ar (o mod segue gravando o uso; os pedidos de permissão ficam só no terminal).`);
    else if (health.permissions) out(`${at}: no ar e respondendo pedidos de permissão (com alguma página aberta).`);
    else out(`${at}: no ar, mas responder pelo escritório está desligado (porta exposta na rede ou CODETOWN_TERMINAL=0).`);
  }
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Para o docker:up: atualiza o mod de quem já instalou
// ---------------------------------------------------------------------------------------------

export interface ModUpdateContext {
  env: NodeJS.ProcessEnv;
  home: string;
  root: string;
  version: string;
  claude: ClaudeRunner;
}

export interface ModUpdateResult {
  /** Alguma conta tem o mod (ou o plugin de permissões) instalado. */
  installed: boolean;
  /** Não deu para consultar o Claude Code em nenhuma conta (ex.: `claude` fora do PATH). */
  unavailable: boolean;
  lines: Array<{ level: 'info' | 'warn'; text: string }>;
}

/**
 * Para cada conta com o mod instalado numa versão diferente da do package.json: relê o catálogo e atualiza os
 * plugins instalados. Nunca instala nada e nunca lança: qualquer falha vira um aviso.
 */
export function updateInstalledMods(accounts: Array<{ dir: string; label: string }>, ctx: ModUpdateContext): ModUpdateResult {
  const res: ModUpdateResult = { installed: false, unavailable: false, lines: [] };
  if (!accounts.length) return res;
  // Um runner que nunca lança: qualquer exceção vira uma falha comum (o docker:up não pode cair por isso).
  const claude: ClaudeRunner = (args, env) => {
    try {
      return ctx.claude(args, env);
    } catch (err) {
      return { code: null, stdout: '', stderr: '', error: (err as Error).message };
    }
  };
  // Sem o CLI, a mesma falha se repetiria em todas as contas: confere uma vez e avisa uma vez.
  const probe = claude(['--version'], ctx.env);
  if (probe.error || probe.code !== 0) {
    res.unavailable = true;
    res.lines.push({ level: 'warn', text: `não consegui consultar o Claude Code (${cliMessage(probe)}); o mod não foi conferido.` });
    return res;
  }
  for (const { dir, label } of accounts) {
    const env = accountEnv(ctx.env, dir, ctx.home);
    const state = readAccountState(claude, env);
    if ('error' in state) {
      res.lines.push({ level: 'warn', text: `mod na ${label}: ${state.error}` });
      continue;
    }
    const plan = planUpdate(state, { root: ctx.root, version: ctx.version });
    if (plan.action === 'none') {
      if (plan.installed) res.installed = true;
      continue;
    }
    res.installed = true;
    if (plan.action === 'warn') {
      res.lines.push({ level: 'warn', text: `mod na ${label}: ${plan.message}` });
      continue;
    }
    let failed: string | undefined;
    for (const step of plan.steps) {
      const r = claude(step.args, env);
      if (r.error || r.code !== 0) {
        failed = `${step.message.split(':')[0]} (${cliMessage(r)})`;
        break;
      }
    }
    if (failed) {
      res.lines.push({ level: 'warn', text: `não consegui atualizar o mod na ${label}: ${failed}. Tente: npm run mod:install` });
      continue;
    }
    // Só diz "atualizado" se o Claude Code passou mesmo a registrar a versão nova.
    const after = readAccountState(claude, env);
    const ids = plan.steps.flatMap((s) => (s.plugin ? [s.plugin] : []));
    const issues = 'error' in after ? [after.error] : verifyInstall(after, ids, ctx.version);
    if (issues.length) res.lines.push({ level: 'warn', text: `mod na ${label}: ${issues.join('; ')}` });
    else res.lines.push({ level: 'info', text: `Mod atualizado para ${ctx.version} na ${label}; sessões abertas: /reload-plugins` });
  }
  return res;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    now: new Date(),
    root: ROOT,
    version: readPackageVersion(ROOT),
    claude: makeClaudeRunner(parsed.claudeCmd),
    out: (l) => console.log(l),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[mod] Erro: ${err.message}` : `[mod] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
