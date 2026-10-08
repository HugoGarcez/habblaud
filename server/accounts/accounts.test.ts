import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { accountIds, discoverClaudeDirs, detectAccounts, parseClaudeAliases, shortcutsByDir } from './detect';
import { AccountsService } from './service';
import { rollover, STALE_AFTER_MS, usageFromCache, usageFromWindows, UsageStore } from './usage';

setQuiet(true);

const H = '/Users/fulano';

describe('aliases de shell', () => {
  it('só linhas alias que invocam o claude; CLAUDE_CONFIG_DIR expandido', () => {
    const rc = [
      'export OPENAI_API_KEY="sk-segredo"',
      "alias ll='ls -la'",
      "alias claude2='CLAUDE_CONFIG_DIR=\"$HOME/.claude-conta2\" claude --permission-mode auto'",
      "alias c='claude --permission-mode auto'",
      "alias f='claude --permission-mode auto --agent frinus'",
      "alias d='CLAUDE_CONFIG_DIR=\"$HOME/.claude-conta2\" claude --permission-mode auto'",
      'alias e="CLAUDE_CONFIG_DIR=~/.claude-trabalho/ claude"',
      "alias sq='claude-squad'",
      "  # alias x='claude'",
      "alias w='cd ~/.claude && ls'",
    ].join('\n');
    expect(parseClaudeAliases(rc, H)).toEqual([
      { name: 'claude2', configDir: `${H}/.claude-conta2` },
      { name: 'c' },
      { name: 'f' },
      { name: 'd', configDir: `${H}/.claude-conta2` },
      { name: 'e', configDir: `${H}/.claude-trabalho` },
    ]);
  });

  it('prefere o alias mais curto (empate: o primeiro) e usa maiúscula', () => {
    const m = shortcutsByDir(
      [{ name: 'claude2', configDir: `${H}/.claude-conta2` }, { name: 'c' }, { name: 'f' }, { name: 'd', configDir: `${H}/.claude-conta2` }],
      H,
    );
    expect(m.get(`${H}/.claude`)).toBe('C');
    expect(m.get(`${H}/.claude-conta2`)).toBe('D');
  });

  it('ids desambiguados quando dois dirs têm o mesmo basename', () => {
    expect(accountIds(['/a/.claude', '/b/.claude', '/c/.claude-x'])).toEqual(['.claude', '.claude~2', '.claude-x']);
  });
});

describe('detecção de contas', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  beforeEach(() => {
    tmp = tempDir();
    home = tmp.dir;
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude-conta2', 'sessions'), { recursive: true });
    mkdirSync(join(home, '.claude-vazio'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), '{}');
    writeFileSync(
      join(home, '.zshrc'),
      "alias c='claude'\nalias d='CLAUDE_CONFIG_DIR=\"$HOME/.claude-conta2\" claude'\nexport TOKEN=nao-leia\n",
    );
  });
  afterEach(() => tmp.cleanup());

  it('descobre $HOME/.claude* com projects/ ou sessions/, padrão primeiro', () => {
    expect(discoverClaudeDirs({}, home)).toEqual([join(home, '.claude'), join(home, '.claude-conta2')]);
    const extra = join(home, 'outra');
    mkdirSync(extra);
    expect(discoverClaudeDirs({ CLAUDE_CONFIG_DIR: extra }, home)).toContain(extra);
    expect(discoverClaudeDirs({ HABBLAUD_CLAUDE_DIRS: ' /x/a , ~/b ' }, home)).toEqual(['/x/a', join(home, 'b')]);
  });

  it('lê só os campos permitidos do .claude.json, atalhos e cores', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@empresa.com', organizationName: 'Empresa', displayName: 'A', billingType: 'x', accountUuid: 'nao' },
        mcpServers: { s: { env: { SECRET: 'nao-pode-vazar' } } },
      }),
    );
    writeFileSync(
      join(home, '.claude-conta2', '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'b@pessoal.com' },
        cachedUsageUtilization: { fetchedAtMs: 1000, utilization: { five_hour: { utilization: 10, resets_at: null } } },
      }),
    );
    const accs = detectAccounts([join(home, '.claude'), join(home, '.claude-conta2'), join(home, '.claude-vazio')], { home, env: {} });
    expect(accs).toEqual([
      { id: '.claude', configDir: join(home, '.claude'), short: 'C', name: 'Conta C', color: '#f08a3c', email: 'a@empresa.com', organization: 'Empresa' },
      {
        id: '.claude-conta2',
        configDir: join(home, '.claude-conta2'),
        short: 'D',
        name: 'Conta D',
        color: '#4aa8e8',
        email: 'b@pessoal.com',
        cachedUsage: { fetchedAtMs: 1000, utilization: { five_hour: { utilization: 10, resets_at: null } } },
      },
      { id: '.claude-vazio', configDir: join(home, '.claude-vazio'), short: 'A', name: 'Conta A', color: '#5cc97b' },
    ]);
    expect(JSON.stringify(accs)).not.toContain('nao-pode-vazar');
  });

  it('HABBLAUD_ACCOUNTS (Docker) sobrepõe metadados casando por id ou mountDir', () => {
    const env = {
      HABBLAUD_ACCOUNTS: JSON.stringify([
        { id: '.claude', configDir: '/Users/x/.claude', mountDir: join(home, '.claude'), short: 'C', email: 'host@x.com', plan: 'Max', color: '#000000' },
        { mountDir: join(home, '.claude-conta2'), configDir: '/Users/x/.claude-conta2', short: 'D', name: 'Pessoal', cachedUsage: { fetchedAtMs: 5 } },
      ]),
    };
    const accs = detectAccounts([join(home, '.claude'), join(home, '.claude-conta2')], { home: '/nenhum', env });
    expect(accs[0]).toMatchObject({ id: '.claude', configDir: '/Users/x/.claude', short: 'C', name: 'Conta C', email: 'host@x.com', plan: 'Max', color: '#000000' });
    expect(accs[1]).toMatchObject({ id: '.claude-conta2', configDir: '/Users/x/.claude-conta2', short: 'D', name: 'Pessoal', cachedUsage: { fetchedAtMs: 5 } });
  });
});

describe('uso (5h e semanal)', () => {
  const NOW = Date.parse('2026-10-06T12:00:00Z');
  const windows = {
    five_hour: { utilization: 42.5, resets_at: '2026-10-06T14:00:00.123+00:00' },
    seven_day: { utilization: 15, resets_at: '2026-10-09T23:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: null },
    extra_usage: { is_enabled: false },
  };

  it('normaliza as janelas no formato do Claude Code', () => {
    expect(usageFromWindows(windows, 'cache', NOW)).toEqual({
      source: 'cache',
      fetchedAt: NOW,
      fiveHour: { utilization: 42.5, resetsAt: Date.parse('2026-10-06T14:00:00.123Z') },
      sevenDay: { utilization: 15, resetsAt: Date.parse('2026-10-09T23:00:00Z') },
      sevenDaySonnet: { utilization: 3 },
    });
    expect(usageFromWindows({}, 'cache', NOW)).toBeUndefined();
  });

  it('cache: fetchedAtMs vira fetchedAt; antigo = stale; sem nada = disabled', () => {
    const store = new UsageStore();
    expect(store.view('x', NOW).status).toBe('disabled');
    store.set('x', usageFromCache({ fetchedAtMs: NOW - 5 * 60_000, utilization: windows })!);
    expect(store.view('x', NOW).status).toBe('ok');
    expect(store.view('x', NOW + STALE_AFTER_MS).status).toBe('stale');
  });

  it('janelas cujo reinício já passou ficam sem dados (nunca um 0% inventado)', () => {
    const u = usageFromWindows(windows, 'cache', NOW)!;
    // Antes do reinício da semana, mas depois do da sessão de 5h.
    const r = rollover(u, Date.parse('2026-10-06T15:00:00Z'));
    expect(r.fiveHour).toBeUndefined();
    expect(r.sevenDay).toEqual({ utilization: 15, resetsAt: Date.parse('2026-10-09T23:00:00Z') });
    // Sem horário de reinício: continua valendo.
    expect(r.sevenDaySonnet).toEqual({ utilization: 3 });
    const later = rollover(u, Date.parse('2026-10-10T00:00:00Z'));
    expect(later.fiveHour).toBeUndefined();
    expect(later.sevenDay).toBeUndefined();
    expect(later).toMatchObject({ source: 'cache', fetchedAt: NOW });
    // O original não é alterado.
    expect(u.fiveHour?.utilization).toBe(42.5);
  });

  it('vale a fonte com números mais recentes; limpar uma fonte devolve a outra', () => {
    const store = new UsageStore();
    store.set('x', usageFromWindows(windows, 'cache', NOW - 3_600_000)!);
    store.set('x', usageFromWindows({ ...windows, five_hour: { utilization: 77, resets_at: null } }, 'statusline', NOW - 60_000)!);
    expect(store.view('x', NOW)).toMatchObject({ status: 'ok', usage: { source: 'statusline', fiveHour: { utilization: 77 } } });
    expect(store.clear('x', 'statusline')).toBe(true);
    expect(store.view('x', NOW)).toMatchObject({ status: 'stale', usage: { source: 'cache' } });
  });

  it('AccountsService lê o cache do /usage do .claude.json da conta', () => {
    const tmp = tempDir();
    try {
      const dir = join(tmp.dir, '.claude-conta2');
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      let changes = 0;
      const svc = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => changes++, now: () => NOW });
      expect(svc.list(new Map())[0].usageStatus).toBe('disabled');
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: NOW - 60_000, utilization: windows } }));
      svc.refresh();
      const info = svc.list(new Map([['.claude-conta2', 3]]))[0];
      expect(info).toMatchObject({ id: '.claude-conta2', sessions: 3, usageStatus: 'ok', usage: { source: 'cache', fiveHour: { utilization: 42.5 } } });
      expect(changes).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });
});
