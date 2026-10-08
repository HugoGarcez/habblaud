// Instalador do mod (scripts/mod-install.ts): funções puras e o comando inteiro contra um CLI FALSO do Claude
// Code, com HOME e contas FALSOS em pastas temporárias (nunca chama o `claude` de verdade nem toca em ~/.claude*).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modHint } from '../../scripts/docker-up';
import { hookCommand, hookEntry } from '../../scripts/hooks-install';
import {
  accountEnv,
  cliMessage,
  cliSteps,
  describeStatus,
  MOD_PLUGIN,
  parseArgs,
  parseJsonOutput,
  parseMarketplaceList,
  parsePluginList,
  parseVersion,
  PERMISSIONS_PLUGIN,
  planInstall,
  planMigration,
  planUninstall,
  planUpdate,
  run,
  updateInstalledMods,
  verifyInstall,
  versionAtLeast,
  type AccountState,
  type ClaudeResult,
  type ClaudeRunner,
  type PluginInfo,
  type RunOptions,
} from '../../scripts/mod-install';
import { wrapCommand } from '../../scripts/statusline-install';
import { tempDir } from './fixtures';

const ROOT = '/repo/codetown';
const same = (a: string, b: string) => a === b;
const plugin = (id: string, extra: Partial<PluginInfo> = {}): PluginInfo => ({ id, version: '0.2.0', scope: 'user', enabled: true, errors: [], ...extra });
const stateOf = (plugins: PluginInfo[] = [], path: string | null = ROOT): AccountState => ({
  marketplace: path ? { name: 'codetown', source: 'directory', path } : undefined,
  plugins,
});
const argsOf = (plan: ReturnType<typeof planInstall>) => cliSteps(plan).map((s) => s.args.join(' '));

// Saídas reais do `claude plugin list --json` e `claude plugin marketplace list --json` (Claude Code 2.1.293),
// copiadas de um CLAUDE_CONFIG_DIR temporário com um marketplace de brinquedo.
const REAL_PLUGIN_LIST = `[
  {
    "id": "codetown@codetown",
    "version": "0.2.0",
    "scope": "user",
    "enabled": true,
    "installPath": "/tmp/t/cfg/plugins/cache/codetown/codetown/0.2.0",
    "readFromFolder": "/tmp/t/mkt/mod/codetown",
    "folderVersion": "0.3.0",
    "installedAt": "2026-10-08T10:36:58.924Z",
    "lastUpdated": "2026-10-08T10:36:58.924Z",
    "projectEnabled": false
  },
  {
    "id": "codetown-permissoes@codetown",
    "version": "0.2.0",
    "scope": "user",
    "enabled": false,
    "installPath": "/tmp/t/cfg/plugins/cache/codetown/codetown-permissoes/0.2.0",
    "errors": ["Marketplace codetown failed to load: cache-miss"],
    "errorDetails": [{ "type": "marketplace-load-failed", "marketplace": "codetown" }],
    "projectEnabled": false
  }
]`;
const REAL_MARKETPLACE_LIST = `[
  {
    "name": "codetown",
    "source": "directory",
    "path": "/tmp/t/mkt",
    "installLocation": "/tmp/t/mkt"
  }
]`;

describe('mod-install.ts (funções puras)', () => {
  it('versão do Claude Code: lê "2.1.293 (Claude Code)" e compara com o mínimo', () => {
    expect(parseVersion('2.1.293 (Claude Code)')).toEqual([2, 1, 293]);
    expect(parseVersion('Claude Code')).toBeUndefined();
    expect(versionAtLeast('2.1.293', '2.1.287')).toBe(true);
    expect(versionAtLeast('2.1.287', '2.1.287')).toBe(true);
    expect(versionAtLeast('2.1.286', '2.1.287')).toBe(false);
    expect(versionAtLeast('2.0.999', '2.1.287')).toBe(false);
    expect(versionAtLeast('2.2.0', '2.1.287')).toBe(true);
    expect(versionAtLeast('3.0.0', '2.1.287')).toBe(true);
    expect(versionAtLeast('x', '2.1.287')).toBe(false);
  });

  it('JSON da saída do CLI, com tolerância a avisos antes e à linha de resultado no fim', () => {
    expect(parseJsonOutput('[1, 2]\n')).toEqual([1, 2]);
    expect(parseJsonOutput('Aviso: algo\n[\n  {"id": "a"}\n]')).toEqual([{ id: 'a' }]);
    expect(parseJsonOutput('Installing…\n{"command":"install","outcome":"ok"}')).toEqual({ command: 'install', outcome: 'ok' });
    expect(parseJsonOutput('\x1b[32m[]\x1b[0m')).toEqual([]);
    expect(parseJsonOutput('nada aqui')).toBeUndefined();
    expect(parseJsonOutput('')).toBeUndefined();
  });

  it('lista de plugins e de marketplaces no formato real do CLI', () => {
    expect(parsePluginList(REAL_PLUGIN_LIST)).toEqual([
      { id: MOD_PLUGIN, version: '0.2.0', scope: 'user', enabled: true, readFromFolder: '/tmp/t/mkt/mod/codetown', folderVersion: '0.3.0', errors: [] },
      { id: PERMISSIONS_PLUGIN, version: '0.2.0', scope: 'user', enabled: false, readFromFolder: undefined, folderVersion: undefined, errors: ['Marketplace codetown failed to load: cache-miss'] },
    ]);
    // `--available` devolve um objeto; itens sem id são ignorados; lixo = undefined (não "nada instalado").
    expect(parsePluginList(JSON.stringify({ installed: [{ id: 'x@y' }, { version: '1' }], available: [] }))).toEqual([
      { id: 'x@y', version: undefined, scope: undefined, enabled: true, readFromFolder: undefined, folderVersion: undefined, errors: [] },
    ]);
    expect(parsePluginList('[]')).toEqual([]);
    expect(parsePluginList('No plugins installed.')).toBeUndefined();
    expect(parseMarketplaceList(REAL_MARKETPLACE_LIST)).toEqual([{ name: 'codetown', source: 'directory', path: '/tmp/t/mkt' }]);
    expect(parseMarketplaceList('[{"name":"oficial","source":"github","repo":"a/b","installLocation":"/x"}]')).toEqual([{ name: 'oficial', source: 'github' }]);
    expect(parseMarketplaceList('{}')).toBeUndefined();
  });

  it('ambiente por conta: a padrão roda sem CLAUDE_CONFIG_DIR (mesmo herdado); as outras, com a pasta delas', () => {
    const env = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-conta2' };
    expect(accountEnv(env, '/h/.claude', '/h')).toEqual({ PATH: '/bin' });
    expect(accountEnv(env, '/h/.claude-conta2', '/h')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-conta2' });
    expect(accountEnv({ PATH: '/bin' }, '/h/.claude-x', '/h')).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/h/.claude-x' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/h/.claude-conta2');
  });

  it('install: do zero adiciona o marketplace e os dois plugins (escopo user); --sem-permissoes só o mod', () => {
    const base = { root: ROOT, version: '0.2.0', sameDir: same };
    const all = planInstall(stateOf([], null), { ...base, permissions: true });
    expect(argsOf(all)).toEqual([
      `plugin marketplace add ${ROOT}`,
      `plugin install ${MOD_PLUGIN} --scope user`,
      `plugin install ${PERMISSIONS_PLUGIN} --scope user`,
    ]);
    expect(all.plugins).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN]);
    const solo = planInstall(stateOf([], null), { ...base, permissions: false });
    expect(argsOf(solo)).toEqual([`plugin marketplace add ${ROOT}`, `plugin install ${MOD_PLUGIN} --scope user`]);
    expect(solo.notes).toEqual([]);
  });

  it('install: já instalado relê o catálogo e nada mais; desligado religa; versão diferente atualiza', () => {
    const base = { root: ROOT, version: '0.2.0', permissions: true, sameDir: same };
    const ok = planInstall(stateOf([plugin(MOD_PLUGIN), plugin(PERMISSIONS_PLUGIN)]), base);
    expect(argsOf(ok)).toEqual(['plugin marketplace update codetown']);
    expect(ok.items.filter((i) => 'unchanged' in i)).toEqual([{ unchanged: 'codetown: já instalado na versão 0.2.0' }, { unchanged: 'codetown-permissoes: já instalado na versão 0.2.0' }]);
    const mixed = planInstall(stateOf([plugin(MOD_PLUGIN, { enabled: false }), plugin(PERMISSIONS_PLUGIN, { version: '0.1.0' })]), base);
    expect(argsOf(mixed)).toEqual([
      'plugin marketplace update codetown',
      `plugin enable ${MOD_PLUGIN} --scope user`,
      `plugin update ${PERMISSIONS_PLUGIN} --scope user`,
    ]);
    expect(cliSteps(mixed)[2].message).toBe('codetown-permissoes: atualizado de 0.1.0 para 0.2.0');
    // Instalado só no escopo de um projeto: o do usuário ainda falta.
    expect(argsOf(planInstall(stateOf([plugin(MOD_PLUGIN, { scope: 'project' })]), { ...base, permissions: false }))).toContain(`plugin install ${MOD_PLUGIN} --scope user`);
  });

  it('install: marketplace de outra pasta passa a apontar para esta; --sem-permissoes mantém (e atualiza) o de permissões', () => {
    const moved = planInstall(stateOf([plugin(MOD_PLUGIN)], '/antigo/codetown'), { root: ROOT, version: '0.2.0', permissions: false, sameDir: same });
    expect(argsOf(moved)).toEqual([`plugin marketplace add ${ROOT}`]);
    expect(cliSteps(moved)[0].message).toContain('antes: /antigo/codetown');
    const keep = planInstall(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' }), plugin(PERMISSIONS_PLUGIN)]), { root: ROOT, version: '0.3.0', permissions: false, sameDir: same });
    expect(argsOf(keep)).toEqual(['plugin marketplace update codetown', `plugin update ${PERMISSIONS_PLUGIN} --scope user`]);
    expect(keep.plugins).toEqual([MOD_PLUGIN, PERMISSIONS_PLUGIN]);
    expect(keep.notes[0]).toMatch(/continua.*claude plugin uninstall codetown-permissoes@codetown/);
  });

  it('uninstall: tira só o que existe, na ordem plugins → marketplace', () => {
    expect(argsOf(planUninstall(stateOf([plugin(MOD_PLUGIN), plugin(PERMISSIONS_PLUGIN)])))).toEqual([
      `plugin uninstall ${MOD_PLUGIN} --scope user`,
      `plugin uninstall ${PERMISSIONS_PLUGIN} --scope user`,
      'plugin marketplace remove codetown',
    ]);
    const none = planUninstall(stateOf([], null));
    expect(cliSteps(none)).toEqual([]);
    expect(none.items).toHaveLength(3);
  });

  describe('migração do jeito antigo', () => {
    const tap = wrapCommand('node', '/repo/codetown/scripts/statusline-tap.mjs', 'npx -y ccstatusline');
    const hook = hookEntry(hookCommand('node', '/repo/codetown/scripts/permission-hook.mjs', { port: 4747, timeoutS: 300 }), { port: 4747, timeoutS: 300 });
    const mine = { type: 'command', command: 'meu-hook' };
    const settings = {
      model: 'opus',
      statusLine: { type: 'command', command: tap, padding: 0 },
      hooks: { PermissionRequest: [{ matcher: '*', hooks: [mine, hook] }], Stop: [{ hooks: [mine] }] },
      enabledPlugins: { [MOD_PLUGIN]: true },
    };

    it('com os dois plugins instalados: devolve o statusline original e tira só o hook do CodeTown, numa gravação', () => {
      const m = planMigration(settings, { modInstalled: true, permissionsInstalled: true, permissions: true });
      expect(m.settings).toEqual({
        model: 'opus',
        statusLine: { type: 'command', command: 'npx -y ccstatusline', padding: 0 },
        hooks: { PermissionRequest: [{ matcher: '*', hooks: [mine] }], Stop: [{ hooks: [mine] }] },
        enabledPlugins: { [MOD_PLUGIN]: true },
      });
      expect(m.done).toHaveLength(2);
      expect(m.done[0]).toContain('restaurado: npx -y ccstatusline');
    });

    it('--sem-permissoes mantém o hook; plugin que não ficou instalado não leva o antigo embora', () => {
      const semPerm = planMigration(settings, { modInstalled: true, permissionsInstalled: false, permissions: false });
      expect((semPerm.settings?.hooks as Record<string, unknown>).PermissionRequest).toEqual(settings.hooks.PermissionRequest);
      expect(semPerm.kept).toEqual(['hook de permissão antigo mantido (--sem-permissoes)']);
      const falhou = planMigration(settings, { modInstalled: false, permissionsInstalled: false, permissions: true });
      expect(falhou.settings).toBeUndefined();
      expect(falhou.kept).toHaveLength(2);
      // Nada do jeito antigo: nada a fazer.
      expect(planMigration({ model: 'opus' }, { modInstalled: true, permissionsInstalled: true, permissions: true })).toEqual({ done: [], kept: [], warnings: [] });
    });

    it('formato inesperado: avisa e não mexe', () => {
      const m = planMigration({ statusLine: { type: 'command', command: 'echo statusline-tap.mjs quebrado' } }, { modInstalled: true, permissionsInstalled: true, permissions: true });
      expect(m.settings).toBeUndefined();
      expect(m.warnings[0]).toMatch(/usage:uninstall/);
    });
  });

  it('docker:up: atualiza só o que já está instalado e só a partir desta pasta', () => {
    const o = { root: ROOT, version: '0.3.0', sameDir: same };
    expect(planUpdate(stateOf([]), o)).toEqual({ action: 'none', installed: false });
    expect(planUpdate(stateOf([plugin(MOD_PLUGIN, { version: '0.3.0' })]), o)).toEqual({ action: 'none', installed: true });
    const up = planUpdate(stateOf([plugin(MOD_PLUGIN), plugin(PERMISSIONS_PLUGIN, { version: '0.3.0' })]), o);
    expect(up.action === 'update' && up.steps.map((s) => s.args.join(' '))).toEqual(['plugin marketplace update codetown', `plugin update ${MOD_PLUGIN} --scope user`]);
    const elsewhere = planUpdate(stateOf([plugin(MOD_PLUGIN)], '/outro/clone'), o);
    expect(elsewhere.action === 'warn' && elsewhere.message).toMatch(/outra pasta \(\/outro\/clone\).*npm run mod:install/);
    expect(planUpdate(stateOf([plugin(MOD_PLUGIN)], null), o).action).toBe('warn');
    // A dica do fim do docker:up só aparece quando ninguém instalou (e dá para saber).
    expect(modHint({ installed: false, unavailable: false }).join('\n')).toMatch(/npm run mod:install.*2\.1\.287\+[\s\S]*usage:install e npm run hooks:install/);
    expect(modHint({ installed: true, unavailable: false })).toEqual([]);
    expect(modHint({ installed: false, unavailable: true })).toEqual([]);
  });

  it('conferência depois de instalar, mensagem de falha do CLI e status', () => {
    const after = stateOf([plugin(MOD_PLUGIN, { version: '0.1.0' }), plugin(PERMISSIONS_PLUGIN, { enabled: false, errors: ['boom'] })]);
    expect(verifyInstall(after, [MOD_PLUGIN, PERMISSIONS_PLUGIN, 'outro@codetown'], '0.2.0')).toEqual([
      'codetown: o Claude Code registra a versão 0.1.0, não a 0.2.0 (o manifesto em mod/ está com outra versão?)',
      `codetown-permissoes: instalado, mas desligado (claude plugin enable ${PERMISSIONS_PLUGIN})`,
      'codetown-permissoes: boom',
      'outro: não aparece instalado na lista do Claude Code',
    ]);
    expect(cliMessage({ code: 1, stdout: 'Installing…\n', stderr: '\x1b[31m✘ Failed to install plugin "x": not found\x1b[0m\n' })).toBe('Installing… · Failed to install plugin "x": not found');
    expect(cliMessage({ code: null, stdout: '', stderr: '', error: 'sem claude' })).toBe('sem claude');
    expect(cliMessage({ code: 2, stdout: '', stderr: '' })).toBe('saiu com código 2');

    const tap = wrapCommand('node', '/r/scripts/statusline-tap.mjs', 'ccstatusline');
    const lines = describeStatus(stateOf([plugin(MOD_PLUGIN, { version: '0.1.0', folderVersion: '0.2.0', readFromFolder: '/h/x' })]), { statusLine: { command: tap }, disableAllHooks: true }, { root: ROOT, version: '0.2.0', home: '/h', sameDir: same });
    expect(lines).toEqual([
      'marketplace codetown: esta pasta',
      'codetown: instalado, ligado, versão 0.1.0 (esta pasta: 0.2.0; npm run mod:install ou npm run docker:up atualiza), carrega 0.2.0 de ~/x',
      'codetown-permissoes: não instalado',
      '! tap de statusline antigo ainda instalado junto com o mod: npm run mod:install tira (ou npm run usage:uninstall)',
      '! disableAllHooks está ligado no settings.json desta conta: nenhum mod (nem hook) roda',
    ]);
  });

  it('parseArgs', () => {
    expect(parseArgs(['install'])).toEqual({ command: 'install', dryRun: false, permissions: true, accounts: [], claudeCmd: undefined });
    expect(parseArgs(['install', '--sem-permissoes', '--conta', '~/.claude-conta2', '--conta', '/x', '--dry-run', '--claude', '/opt/claude'])).toEqual({
      command: 'install',
      dryRun: true,
      permissions: false,
      accounts: ['~/.claude-conta2', '/x'],
      claudeCmd: '/opt/claude',
    });
    expect(parseArgs(['-h'])).toBe('help');
    expect(() => parseArgs([])).toThrow(/install, uninstall ou status/);
    expect(() => parseArgs(['install', '--conta'])).toThrow(/--conta/);
    expect(() => parseArgs(['install', '--xyz'])).toThrow(/opção desconhecida/);
  });
});

// ---------------------------------------------------------------------------------------------
// CLI falso: guarda marketplace e plugins por CLAUDE_CONFIG_DIR, como o de verdade
// ---------------------------------------------------------------------------------------------

interface FakeAccount {
  marketplace?: string;
  plugins: Map<string, { version: string; enabled: boolean }>;
}

class FakeClaude {
  version = '2.1.293 (Claude Code)';
  /** Versão dos manifestos em mod/ (o que install/update registram). */
  folderVersion = '0.2.0';
  missing = false;
  fail?: (args: string[]) => boolean;
  calls: Array<{ args: string[]; configDir: string }> = [];
  accounts = new Map<string, FakeAccount>();

  constructor(private home: string) {}

  account(configDir: string): FakeAccount {
    let a = this.accounts.get(configDir);
    if (!a) this.accounts.set(configDir, (a = { plugins: new Map() }));
    return a;
  }

  get mutating(): string[] {
    return this.calls.filter((c) => !c.args.includes('--json') && c.args[0] !== '--version').map((c) => c.args.join(' '));
  }

  runner: ClaudeRunner = (args, env): ClaudeResult => {
    const configDir = env.CLAUDE_CONFIG_DIR ?? join(this.home, '.claude');
    this.calls.push({ args, configDir });
    if (this.missing) return { code: null, stdout: '', stderr: '', error: 'o comando "claude" não foi encontrado no PATH' };
    if (this.fail?.(args)) return { code: 1, stdout: '', stderr: '✘ Failed: boom\n' };
    const ok = (stdout = 'ok\n'): ClaudeResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr: string): ClaudeResult => ({ code: 1, stdout: '', stderr });
    const a = this.account(configDir);
    const cmd = args.join(' ');
    if (cmd === '--version') return ok(`${this.version}\n`);
    if (cmd === 'plugin marketplace list --json') return ok(JSON.stringify(a.marketplace ? [{ name: 'codetown', source: 'directory', path: a.marketplace, installLocation: a.marketplace }] : []));
    if (cmd === 'plugin list --json') {
      return ok(JSON.stringify([...a.plugins].map(([id, p]) => ({ id, version: p.version, scope: 'user', enabled: p.enabled, installPath: '/cache', readFromFolder: `${a.marketplace}/mod`, folderVersion: this.folderVersion }))));
    }
    const [, sub, third, fourth] = args;
    if (sub === 'marketplace') {
      if (third === 'add') {
        a.marketplace = fourth;
        return ok('✔ Successfully added marketplace: codetown\n');
      }
      if (!a.marketplace) return no("✘ Marketplace 'codetown' not found\n");
      if (third === 'update') return ok();
      if (third === 'remove') {
        a.marketplace = undefined;
        a.plugins.clear();
        return ok();
      }
    }
    if (sub === 'install') {
      if (!a.marketplace) return no(`✘ Plugin "${third}" not found in any marketplace\n`);
      a.plugins.set(third, { version: this.folderVersion, enabled: true });
      return ok();
    }
    const p = a.plugins.get(third);
    if (!p) return no(`✘ Plugin "${third}" not found in installed plugins\n`);
    if (sub === 'enable') p.enabled = true;
    else if (sub === 'update') p.version = this.folderVersion;
    else if (sub === 'uninstall') a.plugins.delete(third);
    else return no(`comando desconhecido: ${cmd}`);
    return ok();
  };
}

describe('mod-install.ts (CLI falso, HOME falso)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let root: string;
  let usageDir: string;
  let out: string[];
  let fake: FakeClaude;
  const tap = wrapCommand('node', '/x/codetown/scripts/statusline-tap.mjs', 'npx -y ccstatusline');
  const hook = hookEntry(hookCommand('node', '/x/codetown/scripts/permission-hook.mjs', { port: 4747, timeoutS: 300 }), { port: 4747, timeoutS: 300 });
  const original = {
    model: 'opus',
    statusLine: { type: 'command', command: tap },
    hooks: { PermissionRequest: [{ matcher: '*', hooks: [hook] }], Stop: [{ hooks: [{ type: 'command', command: 'say pronto' }] }] },
  };

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    root = join(tmp.dir, 'codetown');
    usageDir = join(tmp.dir, 'usage');
    out = [];
    fake = new FakeClaude(home);
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-conta2', 'sessions'), { recursive: true });
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{"name":"codetown","plugins":[]}');
    writeFileSync(join(home, '.claude', 'settings.json'), `${JSON.stringify(original, null, 2)}\n`);
  });
  afterEach(() => tmp.cleanup());

  // CLAUDE_CONFIG_DIR herdado, como quando o comando roda de dentro de uma sessão da conta 2.
  const exec = (command: RunOptions['command'], extra: Partial<RunOptions> = {}, health?: { permissions?: boolean }) =>
    run(
      { command, dryRun: false, permissions: true, accounts: [], ...extra },
      {
        env: { HOME: home, PATH: '/usr/bin', CODETOWN_USAGE_DIR: usageDir, CLAUDE_CONFIG_DIR: join(home, '.claude-conta2') },
        home,
        now: new Date(2026, 9, 8, 9, 30, 0),
        root,
        version: '0.2.0',
        claude: fake.runner,
        out: (l) => out.push(l),
        // Nunca consulta a porta de verdade.
        health: async () => health,
      },
    );
  const read = (acc: string) => JSON.parse(readFileSync(join(home, acc, 'settings.json'), 'utf8'));
  const installed = (acc: string) => Object.fromEntries(fake.account(join(home, acc)).plugins);

  it('install: as duas contas, cada uma com a sua pasta; migra o tap e o hook com backup; de novo = nada a fazer', async () => {
    expect(await exec('install')).toBe(0);
    for (const acc of ['.claude', '.claude-conta2']) {
      expect(fake.account(join(home, acc)).marketplace).toBe(root);
      expect(installed(acc)).toEqual({ [MOD_PLUGIN]: { version: '0.2.0', enabled: true }, [PERMISSIONS_PLUGIN]: { version: '0.2.0', enabled: true } });
    }
    // A conta padrão nunca recebe o CLAUDE_CONFIG_DIR herdado da outra.
    expect(fake.accounts.size).toBe(2);
    expect(fake.calls.filter((c) => c.args[1] === 'install' && c.args[2] === MOD_PLUGIN).map((c) => c.configDir)).toEqual([join(home, '.claude'), join(home, '.claude-conta2')]);
    expect(read('.claude')).toEqual({ model: 'opus', statusLine: { type: 'command', command: 'npx -y ccstatusline' }, hooks: { Stop: original.hooks.Stop } });
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json.codetown-backup-20261008-093000'), 'utf8'))).toEqual(original);
    // Conta sem nada do jeito antigo: o settings.json nem é criado.
    expect(existsSync(join(home, '.claude-conta2', 'settings.json'))).toBe(false);
    expect(existsSync(usageDir)).toBe(true);
    const text = out.join('\n');
    expect(text).toContain('tap de statusline antigo removido');
    expect(text).toContain('hook de permissão antigo removido');
    expect(text).toContain('/reload-plugins');

    out = [];
    fake.calls = [];
    expect(await exec('install')).toBe(0);
    expect(fake.mutating).toEqual(['plugin marketplace update codetown', 'plugin marketplace update codetown']);
    expect(out.join('\n')).toContain('codetown: já instalado na versão 0.2.0');
    expect(readdirSync(join(home, '.claude')).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it('--sem-permissoes: só o mod; o hook antigo fica; --conta limita a uma conta', async () => {
    expect(await exec('install', { permissions: false, accounts: [join(home, '.claude')] })).toBe(0);
    expect(installed('.claude')).toEqual({ [MOD_PLUGIN]: { version: '0.2.0', enabled: true } });
    expect(fake.calls.filter((c) => c.args[0] === 'plugin' && c.configDir === join(home, '.claude-conta2'))).toEqual([]);
    const s = read('.claude');
    expect(s.statusLine).toEqual({ type: 'command', command: 'npx -y ccstatusline' });
    expect(s.hooks.PermissionRequest).toEqual(original.hooks.PermissionRequest);
    expect(out.join('\n')).toContain('hook de permissão antigo mantido (--sem-permissoes)');
    await expect(exec('install', { accounts: [join(home, 'nao-existe')] })).rejects.toThrow(/pasta não encontrada/);
  });

  it('Claude Code antigo: explica, sugere o jeito antigo e não mexe em nada', async () => {
    fake.version = '2.1.286 (Claude Code)';
    expect(await exec('install')).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('precisa do Claude Code 2.1.287 ou mais novo, e este é o 2.1.286');
    expect(text).toContain('npm run usage:install');
    expect(text).toContain('npm run hooks:install');
    expect(fake.mutating).toEqual([]);
    expect(read('.claude')).toEqual(original);
    expect(existsSync(usageDir)).toBe(false);
  });

  it('sem o claude no PATH, ou sem o marketplace nesta pasta: erro claro, nada alterado', async () => {
    fake.missing = true;
    expect(await exec('install')).toBe(1);
    expect(out.join('\n')).toContain('não foi encontrado no PATH');
    fake.missing = false;
    out = [];
    fake.calls = [];
    rmSync(join(root, '.claude-plugin', 'marketplace.json'));
    expect(await exec('install')).toBe(1);
    expect(out.join('\n')).toContain('.claude-plugin/marketplace.json');
    expect(fake.calls).toEqual([]);
    expect(read('.claude')).toEqual(original);
  });

  it('--dry-run: só consulta (listas), não instala, não grava nem cria a pasta do uso', async () => {
    expect(await exec('install', { dryRun: true })).toBe(0);
    expect(fake.mutating).toEqual([]);
    expect(read('.claude')).toEqual(original);
    expect(existsSync(usageDir)).toBe(false);
    const text = out.join('\n');
    expect(text).toContain(`~ marketplace codetown: adicionado (esta pasta) (simulação: claude plugin marketplace add ${root})`);
    expect(text).toContain('~ tap de statusline antigo removido');
  });

  it('falha do CLI: a conta para ali, sai com erro e o jeito antigo continua (não fica sem nenhum dos dois)', async () => {
    fake.fail = (args) => args[1] === 'install' && args[2] === MOD_PLUGIN;
    expect(await exec('install', { accounts: [join(home, '.claude')] })).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('✗ codetown: falhou (Failed: boom)');
    expect(fake.mutating).toEqual([`plugin marketplace add ${root}`, `plugin install ${MOD_PLUGIN} --scope user`]);
    expect(read('.claude')).toEqual(original);
    expect(text).toContain('tap de statusline antigo mantido');
    expect(text).not.toContain('Pronto.');
  });

  it('status e uninstall', async () => {
    await exec('install', { permissions: false });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(original));
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(join(usageDir, '.claude.json'), JSON.stringify({ fetchedAt: new Date(2026, 9, 8, 9, 25, 0).getTime(), source: 'mod' }));
    out = [];
    expect(await exec('status')).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Claude Code 2.1.293 · CodeTown 0.2.0');
    expect(text).toMatch(/• \.claude \(~\/\.claude\)\n {4}marketplace codetown: esta pasta\n {4}codetown: instalado, ligado, versão 0.2.0\n {4}codetown-permissoes: não instalado/);
    expect(text).toContain('! tap de statusline antigo ainda instalado junto com o mod');
    expect(text).toContain('hook de permissão antigo instalado (jeito antigo');
    expect(text).toContain('último uso capturado há 5 min (pelo mod)');
    expect(text).toContain('CodeTown em http://127.0.0.1:4747: fora do ar');
    out = [];
    await exec('status', {}, { permissions: true });
    expect(out.join('\n')).toContain('CodeTown em http://127.0.0.1:4747: no ar e respondendo pedidos de permissão');
    expect(fake.mutating).toEqual([`plugin marketplace add ${root}`, `plugin install ${MOD_PLUGIN} --scope user`, `plugin marketplace add ${root}`, `plugin install ${MOD_PLUGIN} --scope user`]);

    out = [];
    fake.calls = [];
    expect(await exec('uninstall')).toBe(0);
    expect(fake.mutating).toEqual([
      `plugin uninstall ${MOD_PLUGIN} --scope user`,
      'plugin marketplace remove codetown',
      `plugin uninstall ${MOD_PLUGIN} --scope user`,
      'plugin marketplace remove codetown',
    ]);
    expect(installed('.claude')).toEqual({});
    expect(fake.account(join(home, '.claude')).marketplace).toBeUndefined();
    // O desinstalador não mexe no settings.json (o tap e o hook antigos são do usage/hooks:uninstall).
    expect(read('.claude')).toEqual(original);
    expect(out.join('\n')).toContain('npm run usage:install e npm run hooks:install');
    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(out.join('\n')).toContain('= marketplace codetown: não estava adicionado');
  });

  it('docker:up: atualiza para a versão nova só quem tem o mod; nunca instala; nunca lança', async () => {
    const accounts = [
      { dir: join(home, '.claude'), label: 'Conta C' },
      { dir: join(home, '.claude-conta2'), label: 'Conta D' },
    ];
    const ctx = { env: { HOME: home }, home, root, claude: fake.runner };
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.2.0' })).toEqual({ installed: false, unavailable: false, lines: [] });
    expect(fake.mutating).toEqual([]);

    await exec('install', { accounts: [join(home, '.claude-conta2')] });
    fake.calls = [];
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.2.0' })).toEqual({ installed: true, unavailable: false, lines: [] });
    expect(fake.mutating).toEqual([]);

    // git pull: os manifestos em mod/ e o package.json passam para 0.3.0.
    fake.folderVersion = '0.3.0';
    const res = updateInstalledMods(accounts, { ...ctx, version: '0.3.0' });
    expect(res.lines).toEqual([{ level: 'info', text: 'Mod atualizado para 0.3.0 na Conta D; sessões abertas: /reload-plugins' }]);
    expect(fake.mutating).toEqual(['plugin marketplace update codetown', `plugin update ${MOD_PLUGIN} --scope user`, `plugin update ${PERMISSIONS_PLUGIN} --scope user`]);
    expect(installed('.claude-conta2')[MOD_PLUGIN]).toEqual({ version: '0.3.0', enabled: true });
    expect(installed('.claude')).toEqual({});

    // O update "dá certo" mas a versão não muda (manifesto atrasado): aviso, não "atualizado".
    const stuck = updateInstalledMods(accounts, { ...ctx, version: '0.4.0' });
    expect(stuck.lines[0].level).toBe('warn');
    expect(stuck.lines[0].text).toMatch(/Conta D: codetown: o Claude Code registra a versão 0.3.0, não a 0.4.0/);

    // Sem o claude, ou com o runner lançando: um aviso só e nada de exceção.
    fake.missing = true;
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.4.0' })).toEqual({
      installed: false,
      unavailable: true,
      lines: [{ level: 'warn', text: 'não consegui consultar o Claude Code (o comando "claude" não foi encontrado no PATH); o mod não foi conferido.' }],
    });
    const boom: ClaudeRunner = () => {
      throw new Error('explodiu');
    };
    expect(updateInstalledMods(accounts, { ...ctx, version: '0.4.0', claude: boom }).unavailable).toBe(true);
  });
});
