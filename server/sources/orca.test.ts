import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { describeOrcaTool, isPresent, orcaStatus, OrcaWatcher, parseLivePanes, parseWorktreePs } from './orca';

setQuiet(true);

const ps = (agents: Array<Record<string, unknown>>, path = '/projetos/app') =>
  JSON.stringify({ ok: true, result: { worktrees: [{ path, branch: 'refs/heads/main', isArchived: false, agents }] } });
const terms = (...panes: string[]) =>
  JSON.stringify({ ok: true, result: { terminals: panes.map((p) => ({ tabId: p.split(':')[0], leafId: p.split(':')[1], orphaned: false })) } });

describe('Orca: leitura da CLI', () => {
  it('achata os agentes de cada worktree, com o caminho e a branch', () => {
    const list = parseWorktreePs(JSON.parse(ps([{ paneKey: 't:l', agentType: 'codex', state: 'working', prompt: 'oi', toolName: 'shell', toolInput: 'npm test', updatedAt: 5 }])));
    expect(list).toEqual([{ paneKey: 't:l', agentType: 'codex', state: 'working', cwd: '/projetos/app', branch: 'main', prompt: 'oi', toolName: 'shell', toolInput: 'npm test', updatedAt: 5 }]);
  });

  it('paneKey dos terminais vivos = tabId:leafId', () => {
    expect([...parseLivePanes(JSON.parse(terms('a:b', 'c:d')))]).toEqual(['a:b', 'c:d']);
  });

  it('mapeia os estados', () => {
    expect(orcaStatus({ state: 'working' })).toEqual({ status: 'working' });
    expect(orcaStatus({ state: 'blocked', toolName: 'shell' })).toEqual({ status: 'waiting', waitingFor: 'aprovar shell' });
    expect(orcaStatus({ state: 'waiting' }).status).toBe('waiting');
    expect(orcaStatus({ state: 'done' })).toEqual({ status: 'idle' });
    expect(orcaStatus({ state: 'error' })).toEqual({ status: 'idle' });
  });

  it('só entra quem tem o terminal aberto; parado, só se mexeu há pouco', () => {
    const live = new Set(['a:b']);
    const base = { paneKey: 'a:b', agentType: 'codex', cwd: '/x' };
    expect(isPresent({ ...base, state: 'working' }, live, 10_000, 1_000)).toBe(true);
    expect(isPresent({ ...base, state: 'working', paneKey: 'z:z' }, live, 10_000, 1_000)).toBe(false);
    expect(isPresent({ ...base, state: 'done', updatedAt: 9_500 }, live, 10_000, 1_000)).toBe(true);
    expect(isPresent({ ...base, state: 'done', updatedAt: 1 }, live, 10_000, 1_000)).toBe(false);
  });

  it('traduz as ferramentas dos outros agentes', () => {
    expect(describeOrcaTool('shell', 'npm test').kind).toBe('test');
    expect(describeOrcaTool('read_file', '/a/b.ts').text).toBe('Lendo b.ts');
    expect(describeOrcaTool('apply_patch', '*** Begin Patch\n*** Update File: src/x.ts\n').text).toBe('Editando x.ts');
    expect(describeOrcaTool('Bash', 'git status').kind).toBe('git');
  });
});

describe('OrcaWatcher', () => {
  function setup() {
    let now = 1_000_000;
    const office = new Office({
      names: new NameStore(null),
      version: 't',
      startedAt: 0,
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      now: () => now,
    });
    const out = { ps: ps([]), terms: terms() };
    const w = new OrcaWatcher({ office, run: async (args) => (args[0] === 'worktree' ? out.ps : out.terms), now: () => now });
    return { office, w, out, advance: (ms: number) => (now += ms), at: () => now };
  }

  it('codex chega, trabalha, termina e vai embora quando o terminal fecha; claude é ignorado', async () => {
    const { office, w, out, at } = setup();
    out.ps = ps([
      { paneKey: 'a:b', agentType: 'codex', state: 'working', prompt: 'corrige o bug', toolName: 'shell', toolInput: 'npm test', updatedAt: at() },
      { paneKey: 'c:d', agentType: 'claude', state: 'working', updatedAt: at() },
    ]);
    out.terms = terms('a:b', 'c:d');
    await w.poll();
    const a = office.get('orca:a:b')!;
    expect(a.status).toBe('working');
    expect(a.account).toBe('orca:codex');
    expect(a.role).toBe('Codex');
    expect(a.roomId).toBe('/projetos/app');
    expect(a.activity?.kind).toBe('test');
    expect(office.has('orca:c:d')).toBe(false);
    expect(w.accounts(new Map([['orca:codex', 1]]))).toMatchObject([{ id: 'orca:codex', name: 'Codex', short: 'CX', sessions: 1 }]);

    out.ps = ps([{ paneKey: 'a:b', agentType: 'codex', state: 'done', prompt: 'corrige o bug', updatedAt: at() }]);
    await w.poll();
    expect(office.get('orca:a:b')!.status).toBe('idle');

    out.terms = terms();
    await w.poll();
    expect(office.get('orca:a:b')!.status).toBe('offline');
  });

  it('pedido de permissão vira "precisa de você"', async () => {
    const { office, w, out, at } = setup();
    out.ps = ps([{ paneKey: 'a:b', agentType: 'opencode', state: 'blocked', toolName: 'bash', updatedAt: at() }]);
    out.terms = terms('a:b');
    await w.poll();
    expect(office.get('orca:a:b')).toMatchObject({ status: 'waiting', waitingFor: 'aprovar bash' });
  });

  it('CLI com erro: fonte marcada como falha, sem derrubar nada', async () => {
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
    const w = new OrcaWatcher({ office, run: async () => Promise.reject(new Error('sem orca')) });
    await w.poll();
    expect(w.sources()).toMatchObject([{ label: 'orca', ok: false, error: 'sem orca' }]);
  });
});
