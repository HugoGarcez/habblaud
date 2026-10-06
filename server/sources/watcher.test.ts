// Integração: registro + transcript + subagentes em um config dir temporário.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { appendLines, L, tempDir, writeLines } from '../test/fixtures';
import { ClaudeWatcher, encodeCwd } from './watcher';

setQuiet(true);

const CWD = '/projetos/loja';

function setup(opts: { tailBytes?: number } = {}) {
  const tmp = tempDir();
  const home = tmp.dir;
  const dir = join(home, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({
    dirs: [dir],
    home,
    env: {},
    now,
    onChange: () => late.office?.markDirty(),
  });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const alive = new Set<number>();
  const watcher = new ClaudeWatcher({ accounts, office, inDocker: false, now, isAlive: (pid) => alive.has(pid), watch: false, tailBytes: opts.tailBytes });
  const notices: Notice[] = [];

  const ctx = {
    tmp,
    dir,
    office,
    watcher,
    advance(ms: number) {
      clock += ms;
    },
    now,
    openSession(pid: number, sessionId: string, extra: Record<string, unknown> = {}) {
      alive.add(pid);
      writeFileSync(
        join(dir, 'sessions', `${pid}.json`),
        JSON.stringify({ pid, sessionId, cwd: CWD, startedAt: clock - 60_000, kind: 'interactive', status: 'busy', ...extra }),
      );
    },
    closeSession(pid: number) {
      alive.delete(pid);
      rmSync(join(dir, 'sessions', `${pid}.json`));
    },
    transcript(sessionId: string) {
      return join(dir, 'projects', encodeCwd(CWD), `${sessionId}.jsonl`);
    },
    subFile(sessionId: string, agentId: string, meta: Record<string, unknown>, lines: string[], runId?: string) {
      const base = join(dir, 'projects', encodeCwd(CWD), sessionId, 'subagents', ...(runId ? ['workflows', runId] : []));
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, `agent-${agentId}.meta.json`), JSON.stringify(meta));
      const path = join(base, `agent-${agentId}.jsonl`);
      writeLines(path, lines);
      return path;
    },
    poll() {
      watcher.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    notices,
  };
  return ctx;
}

type Ctx = ReturnType<typeof setup>;

describe('ClaudeWatcher', () => {
  let c: Ctx;
  beforeEach(() => {
    c = setup();
  });
  afterEach(() => {
    c.watcher.stop();
    c.tmp.cleanup();
  });

  function bootWithSession(pid = 100, sid = 'sess-a') {
    writeLines(c.transcript(sid), [
      L.raw('ai-title', { aiTitle: 'Carrinho de compras' }),
      L.prompt('Arruma o total do carrinho', { at: c.now() - 5000 }),
      L.assistant([L.tool('r1', 'Read', { file_path: `${CWD}/src/Cart.tsx` })], { at: c.now() - 4000 }),
    ]);
    c.openSession(pid, sid);
    c.watcher.boot();
    c.notices.push(...c.office.commit().notices);
    return `.claude:${pid}`;
  }

  it('boot: sessão aberta vira agente principal com sala, título e atividade, sem avisos', () => {
    const id = bootWithSession();
    const snap = c.office.commit().snapshot;
    expect(snap.rooms).toHaveLength(1);
    expect(snap.rooms[0]).toMatchObject({ id: CWD, name: 'loja', slot: 0 });
    const a = c.agent(id)!;
    expect(a).toMatchObject({ kind: 'main', status: 'working', title: 'Carrinho de compras', role: 'Agente principal', account: '.claude', roomId: CWD });
    expect(a.activity?.text).toBe('Lendo Cart.tsx');
    expect(snap.accounts[0]).toMatchObject({ id: '.claude', short: 'A', sessions: 1 });
    expect(c.notices).toEqual([]);
    expect(c.office.recentFeed(10).map((f) => f.activity.kind)).toEqual(['prompt', 'read']);
  });

  it('acompanha appends do transcript e o status do registro', () => {
    const id = bootWithSession();
    appendLines(c.transcript('sess-a'), [L.assistant([L.tool('e1', 'Edit', { file_path: `${CWD}/src/Cart.tsx` })])]);
    c.poll();
    expect(c.agent(id)!.activity?.text).toBe('Editando Cart.tsx');
    c.openSession(100, 'sess-a', { status: 'waiting', waitingFor: 'permission' });
    c.poll();
    expect(c.agent(id)).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    expect(c.notices.at(-1)?.text).toMatch(/^✋ .+ precisa de você em loja: aprovar uma permissão$/);
    c.openSession(100, 'sess-a', { status: 'busy' });
    c.poll();
    c.openSession(100, 'sess-a', { status: 'idle' });
    c.poll();
    const a = c.agent(id)!;
    expect(a.status).toBe('idle');
    expect(a.activity?.kind).toBe('done');
    expect(c.notices.at(-1)).toMatchObject({ level: 'success', text: `✅ ${a.name} concluiu em loja` });
  });

  it('subagente em primeiro plano: entra, trabalha e entrega ao concluir', () => {
    const mainId = bootWithSession();
    appendLines(c.transcript('sess-a'), [L.assistant([L.tool('toolu_f', 'Agent', { description: 'Mapear arquivos', subagent_type: 'Explore', prompt: 'x' })])]);
    c.subFile('sess-a', 'f1', { agentType: 'Explore', description: 'Mapear arquivos', toolUseId: 'toolu_f', spawnDepth: 1, requestShape: 'foreground' }, [
      L.prompt('Mapeie os arquivos do carrinho', { agentId: 'f1' }),
      L.assistant([L.tool('g1', 'Grep', { pattern: 'useCart' })], { agentId: 'f1' }),
    ]);
    c.poll();
    const sub = c.agent('sess-a:f1')!;
    const main = c.agent(mainId)!;
    expect(sub).toMatchObject({ kind: 'sub', parentId: mainId, role: 'Explore', title: 'Mapear arquivos', status: 'working', account: '.claude', roomId: CWD });
    expect(sub.background).toBeUndefined();
    expect(sub.name).not.toBe(main.name);
    expect(sub.activity?.text).toBe('Buscando “useCart”');
    expect(main.stats.subagents).toBe(1);

    appendLines(c.transcript('sess-a'), [L.result('toolu_f', 'achei', { toolUseResult: { status: 'completed', agentId: 'f1' } })]);
    c.poll();
    expect(c.agent('sess-a:f1')!.status).toBe('done');
    expect(c.notices.at(-1)?.text).toBe(`📦 ${sub.name} entregou “Mapear arquivos” para ${main.name}`);
    c.advance(26_000);
    c.poll();
    expect(c.agent('sess-a:f1')).toBeUndefined();
  });

  it('subagente em segundo plano: o lançamento não conclui; a notificação sim', () => {
    bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('toolu_b', 'Agent', { description: 'Pesquisar API', subagent_type: 'general-purpose', run_in_background: true })]),
      L.result('toolu_b', 'lançado', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'b1' } }),
    ]);
    c.subFile('sess-a', 'b1', { agentType: 'general-purpose', description: 'Pesquisar API', toolUseId: 'toolu_b', requestShape: 'background' }, [
      L.prompt('Pesquise a API', { agentId: 'b1' }),
      L.assistant([L.tool('w1', 'WebSearch', { query: 'api pix' })], { agentId: 'b1' }),
    ]);
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent('sess-a:b1')).toMatchObject({ status: 'working', background: true });
    appendLines(c.transcript('sess-a'), [L.notification('toolu_b', 'completed', 'Achei a documentação')]);
    c.poll();
    expect(c.agent('sess-a:b1')!.status).toBe('done');
  });

  it('subagente conclui por end_turn + 5 s de silêncio', () => {
    bootWithSession();
    c.subFile('sess-a', 'e1', { agentType: 'Plan', description: 'Planejar', toolUseId: 'toolu_x' }, [
      L.prompt('Planeje', { agentId: 'e1' }),
      L.assistant([L.text('Plano pronto.')], { agentId: 'e1', stop: 'end_turn' }),
    ]);
    c.poll();
    expect(c.agent('sess-a:e1')!.status).toBe('working');
    c.advance(6_000);
    c.poll();
    expect(c.agent('sess-a:e1')!.status).toBe('done');
  });

  it('agentes de workflow: entram pela pasta workflows/ e saem com a notificação do workflow', () => {
    bootWithSession();
    appendLines(c.transcript('sess-a'), [
      L.assistant([L.tool('toolu_wf', 'Workflow', { scriptPath: '/x.js' })]),
      L.result('toolu_wf', 'ok', { toolUseResult: { status: 'async_launched', taskId: 'wt1', runId: 'wf_1' } }),
    ]);
    for (const [agentId, label] of [
      ['w1', 'backend'],
      ['w2', 'ui'],
    ]) {
      c.subFile('sess-a', agentId, { agentType: 'workflow-subagent', description: label, workflowPhase: 'Construção', spawnDepth: 1, requestShape: 'foreground' }, [
        L.prompt('Tarefa', { agentId }),
      ], 'wf_1');
    }
    c.poll();
    const subs = c.agents().filter((a) => a.kind === 'sub');
    expect(subs.map((s) => [s.role, s.title, s.status])).toEqual([
      ['Workflow', 'backend', 'working'],
      ['Workflow', 'ui', 'working'],
    ]);
    expect(c.agent('.claude:100')!.stats.subagents).toBe(2);
    // O journal do workflow registra o resultado de cada agente.
    writeLines(join(c.dir, 'projects', encodeCwd(CWD), 'sess-a', 'subagents', 'workflows', 'wf_1', 'journal.jsonl'), [
      JSON.stringify({ type: 'started', agentId: 'w1', label: 'backend' }),
      JSON.stringify({ type: 'result', agentId: 'w1', result: {} }),
    ]);
    c.poll();
    expect(c.agent('sess-a:w1')!.status).toBe('done');
    expect(c.agent('sess-a:w2')!.status).toBe('working');
    appendLines(c.transcript('sess-a'), [L.notification('toolu_wf', 'completed', 'Workflow concluído')]);
    c.poll();
    expect(c.agents().filter((a) => a.kind === 'sub').map((s) => s.status)).toEqual(['done', 'done']);
  });

  it('no boot só entram subagentes escritos nos últimos 90 s e não concluídos', () => {
    writeLines(c.transcript('sess-b'), [L.prompt('oi')]);
    const old = c.subFile('sess-b', 'old', { agentType: 'Explore', toolUseId: 't-old' }, [L.prompt('antigo', { agentId: 'old' })]);
    const past = (c.now() - 10 * 60_000) / 1000;
    utimesSync(old, past, past);
    c.subFile('sess-b', 'new', { agentType: 'Explore', toolUseId: 't-new' }, [L.prompt('novo', { agentId: 'new' })]);
    c.openSession(200, 'sess-b');
    c.watcher.boot();
    const subs = c.agents().filter((a) => a.kind === 'sub');
    expect(subs.map((s) => s.id)).toEqual(['sess-b:new']);
    // O antigo só volta se for escrito de novo.
    appendLines(old, [L.assistant([L.tool('z', 'Read', { file_path: '/a/b.ts' })], { agentId: 'old' })]);
    c.poll();
    expect(c.agent('sess-b:old')?.status).toBe('working');
  });

  it('no boot (reinício do servidor) volta quem está no meio de um comando longo, mesmo quieto há minutos', () => {
    writeLines(c.transcript('sess-r'), [L.prompt('oi')]);
    const quiet = (path: string, ms: number) => {
      const t = (c.now() - ms) / 1000;
      utimesSync(path, t, t);
    };
    // Bash aberto há 3 min (sem resultado ainda): continua trabalhando.
    const busy = c.subFile('sess-r', 'busy', { agentType: 'Explore', toolUseId: 't-busy' }, [
      L.prompt('roda a bateria', { agentId: 'busy', at: c.now() - 200_000 }),
      L.assistant([L.tool('b1', 'Bash', { command: 'npm test' })], { agentId: 'busy', at: c.now() - 180_000, stop: 'tool_use' }),
    ]);
    quiet(busy, 180_000);
    // Terminou há 3 min: fica de fora.
    const ended = c.subFile('sess-r', 'ended', { agentType: 'Explore', toolUseId: 't-ended' }, [
      L.assistant([L.text('pronto')], { agentId: 'ended', at: c.now() - 180_000, stop: 'end_turn' }),
    ]);
    quiet(ended, 180_000);
    // Ferramenta pendente há 12 min: passou do limite, fica de fora.
    const stuck = c.subFile('sess-r', 'stuck', { agentType: 'Explore', toolUseId: 't-stuck' }, [
      L.assistant([L.tool('s1', 'Bash', { command: 'sleep 999' })], { agentId: 'stuck', at: c.now() - 720_000, stop: 'tool_use' }),
    ]);
    quiet(stuck, 720_000);
    // Workflow: journal diz que começou e não terminou (sem ferramenta pendente, quieto há 100 s).
    const wf = c.subFile('sess-r', 'wf1', { agentType: 'workflow-subagent' }, [L.prompt('tarefa', { agentId: 'wf1', at: c.now() - 100_000 })], 'run-1');
    writeFileSync(join(wf, '..', 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'wf1', label: 'Revisor' })}\n`);
    quiet(wf, 100_000);
    c.openSession(400, 'sess-r');
    c.watcher.boot();
    const subs = c.agents().filter((a) => a.kind === 'sub');
    expect(subs.map((s) => s.id).sort()).toEqual(['sess-r:busy', 'sess-r:wf1']);
    expect(c.agent('sess-r:busy')).toMatchObject({ status: 'working', activity: { kind: 'test' } });
  });

  it('pergunta que já chega respondida vira "Recebeu a sua resposta"; aberta continua pergunta', () => {
    const id = bootWithSession(500, 'sess-q');
    const q = { questions: [{ question: 'Qual banco usar?', options: [] }] };
    appendLines(c.transcript('sess-q'), [
      L.assistant([L.tool('q1', 'AskUserQuestion', q)], { at: c.now() - 2_000, stop: 'tool_use' }),
      L.result('q1', 'Postgres', { at: c.now() - 1_000 }),
    ]);
    c.poll();
    expect(c.agent(id)!.activity).toMatchObject({ kind: 'ask', text: 'Recebeu a sua resposta', detail: 'Qual banco usar?' });
    appendLines(c.transcript('sess-q'), [L.assistant([L.tool('q2', 'AskUserQuestion', q)], { stop: 'tool_use' })]);
    c.poll();
    expect(c.agent(id)!.activity).toMatchObject({ kind: 'ask', text: 'Fazendo uma pergunta a você' });
  });

  it('sessão fechada: principal vai embora (offline), subagentes saem junto, sala some', () => {
    const id = bootWithSession();
    c.subFile('sess-a', 's1', { agentType: 'Explore', toolUseId: 't1' }, [L.prompt('x', { agentId: 's1' })]);
    c.poll();
    c.closeSession(100);
    c.poll();
    // Um sumiço instantâneo do registro não fecha a sessão...
    expect(c.agent(id)!.status).toBe('working');
    c.advance(2_000);
    c.poll();
    // ...mas um sumiço que persiste, sim.
    expect(c.agent(id)!.status).toBe('offline');
    expect(c.agent('sess-a:s1')!.status).toBe('done');
    expect(c.notices.at(-1)?.text).toMatch(/^🚪 .+ encerrou a sessão$/);
    c.advance(21_000);
    c.poll();
    const snap = c.office.commit().snapshot;
    expect(snap.agents).toEqual([]);
    expect(snap.rooms).toEqual([]);
  });

  it('PID morto com o arquivo ainda lá = sessão encerrada', () => {
    const id = bootWithSession();
    c.closeSession(100);
    writeFileSync(join(c.dir, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: 'sess-a', cwd: CWD, status: 'idle' }));
    c.poll();
    c.advance(2_000);
    c.poll();
    expect(c.agent(id)!.status).toBe('offline');
  });

  it('/clear: mesmo processo, sessão nova — mesmo personagem, tarefas zeradas', () => {
    writeLines(c.transcript('sess-a'), [L.assistant([L.tool('t', 'TodoWrite', { todos: [{ content: 'A', status: 'pending' }] })])]);
    c.openSession(100, 'sess-a');
    c.watcher.boot();
    const before = c.agent('.claude:100')!;
    expect(before.tasks).toHaveLength(1);
    writeLines(c.transcript('sess-c'), [L.prompt('Começando de novo')]);
    c.openSession(100, 'sess-c');
    c.poll();
    const after = c.agent('.claude:100')!;
    expect(after).toMatchObject({ name: before.name, sessionId: 'sess-c', tasks: [] });
    expect(after.recent.map((r) => r.kind)).toContain('compact');
    expect(after.activity?.kind).toBe('prompt');
  });

  it('sessão nova depois do boot gera aviso de chegada e de sala nova', () => {
    c.watcher.boot();
    writeLines(c.transcript('sess-n'), [L.prompt('Olá')]);
    c.openSession(300, 'sess-n', { agent: 'frinus' });
    c.poll();
    const a = c.agent('.claude:300')!;
    expect(a.role).toBe('Agente frinus');
    const texts = c.notices.map((n) => n.text);
    expect(texts).toContain('🏗️ Nova sala: loja');
    expect(texts).toContain(`👋 ${a.name} chegou em loja (Conta A)`);
  });
});

describe('ClaudeWatcher com transcript maior que a janela do boot', () => {
  it('a linha do tempo longa recebe as atividades do começo do arquivo (sem ir para o feed)', async () => {
    const c = setup({ tailBytes: 1_500 });
    try {
      const t0 = c.now() - 600_000;
      const lines = Array.from({ length: 30 }, (_, i) => L.assistant([L.tool(`r${i}`, 'Read', { file_path: `${CWD}/src/arquivo${i}.ts` })], { at: t0 + i * 1_000 }));
      writeLines(c.transcript('sess-h'), lines);
      c.openSession(600, 'sess-h');
      c.watcher.boot();
      const before = c.office.detail('.claude:600')!.history.length;
      expect(before).toBeLessThan(30);
      await c.watcher.idle();
      const history = c.office.detail('.claude:600')!.history;
      expect(history).toHaveLength(30);
      expect(history.map((a) => a.text)).toEqual(Array.from({ length: 30 }, (_, i) => `Lendo arquivo${i}.ts`));
      expect(c.office.recentFeed(100).filter((f) => f.agentId === '.claude:600')).toHaveLength(before);
    } finally {
      c.watcher.stop();
      c.tmp.cleanup();
    }
  });
});
