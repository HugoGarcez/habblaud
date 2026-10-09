import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Activity } from '../../shared/types';
import { NAME_POOL } from '../../shared/names';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { NameStore } from './names';
import { DONE_GRACE_MS, Office, OFFLINE_GRACE_MS, SNAPSHOT_RECENT } from './office';
import { normalizeCwd, roomDisplayNames, SlotAllocator } from './rooms';

setQuiet(true);

describe('SlotAllocator', () => {
  it('menor slot livre, estável enquanto a sala existe', () => {
    const s = new SlotAllocator(30_000);
    s.sync(['a', 'b', 'c'], 0);
    expect(['a', 'b', 'c'].map((id) => s.slotOf(id))).toEqual([0, 1, 2]);
    s.sync(['c', 'a', 'b'], 1);
    expect(s.slotOf('c')).toBe(2);
  });

  it('slot liberado só volta a ser usado depois do cooldown', () => {
    const s = new SlotAllocator(30_000);
    s.sync(['a', 'b'], 0);
    s.sync(['b'], 1_000);
    s.sync(['b', 'c'], 2_000);
    expect(s.slotOf('c')).toBe(2);
    s.sync(['b', 'c', 'd'], 31_000);
    expect(s.slotOf('d')).toBe(0);
  });
});

describe('salas', () => {
  it('normaliza o cwd', () => {
    expect(normalizeCwd('/a//b/')).toBe('/a/b');
    expect(normalizeCwd('/')).toBe('/');
  });

  it('desambigua basenames repetidos com o diretório pai', () => {
    const names = roomDisplayNames(
      new Map([
        ['1', '/p/empresa/applications/app'],
        ['2', '/p/outro/app'],
        ['3', '/p/habblaud'],
      ]),
    );
    expect([...names.values()]).toEqual(['applications/app', 'outro/app', 'habblaud']);
  });
});

describe('NameStore', () => {
  it('nomes únicos entre os presentes e persistidos entre reinícios', () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 'dados', 'names.json');
      const a = new NameStore(file);
      const used = new Set<string>();
      const first = a.assign('sess-1', used);
      used.add(first.name);
      const second = a.assign('sess-2', used);
      expect(second.name).not.toBe(first.name);
      expect(NAME_POOL.some((p) => p.name === first.name && p.look === first.look)).toBe(true);
      a.flush();
      expect(JSON.parse(readFileSync(file, 'utf8')).names['sess-1'].name).toBe(first.name);

      const b = new NameStore(file);
      b.load();
      expect(b.assign('sess-1', new Set()).name).toBe(first.name);
      // Se o nome persistido colidir com alguém presente, escolhe outro.
      expect(b.assign('sess-1', new Set([first.name])).name).not.toBe(first.name);
    } finally {
      tmp.cleanup();
    }
  });
});

function makeOffice() {
  let clock = 1_000_000;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: clock,
    accounts: (s) => [{ id: 'acc', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '/x', sessions: s.get('acc') ?? 0, usageStatus: 'disabled' }],
    sources: () => [],
    accountName: () => 'Conta C',
    now: () => clock,
  });
  return { office, advance: (ms: number) => (clock += ms), now: () => clock };
}

const act = (id: string, at: number, kind: Activity['kind'] = 'read'): Activity => ({ id, at, kind, icon: '📖', text: 'Lendo x' });

describe('Office', () => {
  it('avisos com dedupe de 10 s e feed em lote', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/loja/', role: 'Agente principal', startedAt: now(), status: 'working' });
    const name = office.get('acc:1')!.name;
    office.addActivity('acc:1', act('a1', now()), true);
    let r = office.commit();
    expect(r.changed).toBe(true);
    expect(r.notices.map((n) => n.text)).toEqual(['🏗️ Nova sala: loja', `👋 ${name} chegou em loja (Conta C)`]);
    expect(r.feed.map((f) => f.id)).toEqual(['a1']);
    expect(r.snapshot.accounts[0].sessions).toBe(1);
    office.setStatus('acc:1', 'waiting', 'aprovar uma permissão');
    office.setStatus('acc:1', 'working');
    office.setStatus('acc:1', 'waiting', 'aprovar uma permissão');
    r = office.commit();
    expect(r.notices.filter((n) => n.level === 'alert')).toHaveLength(1);
    advance(11_000);
    office.setStatus('acc:1', 'working');
    office.setStatus('acc:1', 'waiting', 'aprovar uma permissão');
    expect(office.commit().notices.filter((n) => n.level === 'alert')).toHaveLength(1);
  });

  it('feed traz a conta do agente; snapshot leva só as últimas atividades (histórico completo no detalhe)', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    for (let i = 0; i < 20; i++) {
      advance(1_000);
      office.addActivity('acc:1', act(`a${i}`, now()), true);
    }
    const r = office.commit();
    expect(r.feed.every((f) => f.account === 'acc')).toBe(true);
    const snap = r.snapshot.agents[0];
    expect(snap.recent.map((a) => a.id)).toEqual(Array.from({ length: SNAPSHOT_RECENT }, (_, i) => `a${20 - SNAPSHOT_RECENT + i}`));
    expect(snap.activity?.id).toBe('a19');
    expect(office.detail('acc:1')!.history).toHaveLength(20);
    // Atividades antigas (começo do transcript) entram só no histórico, em ordem e sem duplicar.
    office.mergeHistory('acc:1', [act('velha-1', 10), act('velha-2', 20), act('a0', now())]);
    const h = office.detail('acc:1')!.history;
    expect(h.slice(0, 3).map((a) => a.id)).toEqual(['velha-1', 'velha-2', 'a0']);
    expect(h).toHaveLength(22);
    expect(office.commit().feed).toEqual([]);
  });

  it('boot com o agente esperando você: balão "Precisa de você" sem aviso nem feed', () => {
    const { office, now } = makeOffice();
    office.beginBoot();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'waiting', waitingFor: 'responder uma pergunta' });
    office.addActivity('acc:1', { ...act('w1', now()), kind: 'delegate', text: 'Orquestrando um workflow' }, true);
    office.endBoot();
    const r = office.commit();
    expect(r.snapshot.agents[0].activity).toMatchObject({ kind: 'wait', text: 'Precisa de você: responder uma pergunta' });
    expect(r.notices).toEqual([]);
    // O feed do boot vai para quem conectar (recentFeed), sem a espera sintetizada.
    expect(office.recentFeed(10).map((f) => f.id)).toEqual(['w1']);
    // Respondeu: volta a mostrar o que fazia.
    office.setStatus('acc:1', 'working');
    expect(office.get('acc:1')!.activity?.id).toBe('w1');
  });

  it('boot contado: várias fontes bootando, o escritório só fica pronto quando a última termina', () => {
    const { office, advance, now } = makeOffice();
    expect(office.isBooting()).toBe(false);
    office.beginBoot(); // fonte A (ex.: Claude Code)
    office.beginBoot(); // fonte B (ex.: Codex, assíncrona)
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', act('a-late', now() - 1_000), true);
    office.endBoot(); // A terminou, B ainda não
    expect(office.isBooting()).toBe(true);
    // Ainda bootando: nada de avisos nem de feed ao vivo; o que chega entra no feed do boot.
    office.addMain({ id: '.codex:t1', provider: 'codex', account: '.codex', sessionId: 't1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'waiting', waitingFor: 'aprovar um comando' });
    office.addActivity('.codex:t1', act('b-early', now() - 5_000), true);
    let r = office.commit();
    expect(r.notices).toEqual([]);
    expect(r.feed).toEqual([]);
    expect(office.recentFeed(10)).toEqual([]);
    office.endBoot(); // B terminou: pronto
    expect(office.isBooting()).toBe(false);
    // O feed das duas fontes sai em ordem cronológica; quem espera ganha o balão (sem aviso).
    expect(office.recentFeed(10).map((f) => f.id)).toEqual(['b-early', 'a-late']);
    r = office.commit();
    expect(r.notices).toEqual([]);
    expect(r.snapshot.agents.find((a) => a.id === '.codex:t1')?.activity).toMatchObject({ kind: 'wait' });
    expect(r.snapshot.agents.find((a) => a.id === '.codex:t1')?.provider).toBe('codex');
    expect(r.snapshot.agents.find((a) => a.id === 'acc:1')).not.toHaveProperty('provider');
    // endBoot a mais é ignorado (não deixa o contador negativo).
    office.endBoot();
    office.beginBoot();
    expect(office.isBooting()).toBe(true);
    office.endBoot();
    expect(office.isBooting()).toBe(false);
    // Depois do boot, avisos voltam.
    advance(1_000);
    office.setStatus('acc:1', 'waiting', 'aprovar uma permissão');
    expect(office.commit().notices.length).toBeGreaterThan(0);
  });

  it('subagente herda a ferramenta do principal', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: '.codex:t1', provider: 'codex', account: '.codex', sessionId: 't1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    expect(office.addSub({ id: '.codex:t2', parentId: '.codex:t1', sessionId: 't2', role: 'worker', background: false, startedAt: now() })).toBe(true);
    expect(office.get('.codex:t2')).toMatchObject({ provider: 'codex', account: '.codex', parentId: '.codex:t1' });
    // 'claude' explícito fica ausente (ausente = 'claude').
    office.addMain({ id: 'acc:9', provider: 'claude', account: 'acc', sessionId: 's9', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    expect(office.get('acc:9')).not.toHaveProperty('provider');
  });

  it('moveMain: o principal e os subagentes mudam de sala; a sala antiga vazia sai', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: '.codex:t1', provider: 'codex', account: '.codex', sessionId: 't1', cwd: 'Codex (sem projeto)', role: 'x', startedAt: now(), status: 'idle' });
    office.addSub({ id: '.codex:t2', parentId: '.codex:t1', sessionId: 't2', role: 'worker', background: false, startedAt: now() });
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/loja', role: 'x', startedAt: now(), status: 'idle' });
    office.moveMain('.codex:t1', '/p/loja/');
    const snap = office.commit().snapshot;
    expect(snap.agents.map((a) => [a.id, a.roomId])).toEqual([
      ['.codex:t1', '/p/loja'],
      ['.codex:t2', '/p/loja'],
      ['acc:1', '/p/loja'],
    ]);
    expect(snap.rooms.map((r) => r.id)).toEqual(['/p/loja']);
    // Subagente não muda sozinho; cwd vazio ou o mesmo não faz nada.
    office.moveMain('.codex:t2', '/p/outra');
    office.moveMain('.codex:t1', '');
    expect(office.get('.codex:t1')?.roomId).toBe('/p/loja');
  });

  it('rev só muda quando algo mudou', () => {
    const { office } = makeOffice();
    const r1 = office.commit();
    const r2 = office.commit();
    expect(r2.changed).toBe(false);
    expect(r2.snapshot.rev).toBe(r1.snapshot.rev);
  });

  it('"Concluiu" do transcript substitui o sintetizado pela mudança de status', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', act('a1', now()), true);
    advance(30_000);
    office.setStatus('acc:1', 'idle');
    const synth = office.get('acc:1')!.activity!;
    expect(synth).toMatchObject({ kind: 'done', durationMs: 30_000 });
    office.addActivity('acc:1', { ...act('real', now(), 'done'), text: 'Concluiu em 29s', durationMs: 29_000 }, true);
    const a = office.get('acc:1')!;
    expect(a.activity).toMatchObject({ id: synth.id, text: 'Concluiu em 29s' });
    expect(a.recent.filter((x) => x.kind === 'done')).toHaveLength(1);
  });

  it('ocupado com o balão ainda em "Concluiu" antigo: mostra que acompanha os subagentes (fora do feed)', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', { ...act('fim', now(), 'done'), text: 'Concluiu em 3s' }, true);
    office.commit();
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity!.id).toBe('fim');
    advance(20_000);
    office.addSub({ id: 's1:x', parentId: 'acc:1', sessionId: 's1', role: 'Workflow', background: false, startedAt: now() });
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity).toMatchObject({ kind: 'delegate', text: 'Acompanhando os subagentes' });
    expect(office.commit().feed).toEqual([]);
  });

  it('comando em primeiro plano pendente: o preenchimento "Pensando…" não cobre a espera pelo comando', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addActivity('acc:1', { ...act('fim', now(), 'done'), text: 'Concluiu em 3s' }, true);
    office.setShells('acc:1', [{ id: 'fg', label: 'Instalar as dependências', startedAt: now(), background: false, kind: 'shell' }]);
    advance(20_000);
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity!.id).toBe('fim');
    office.setShells('acc:1', []);
    expect(office.get('acc:1')!.shells).toBeUndefined();
    office.fillWorkingActivity('acc:1');
    expect(office.get('acc:1')!.activity!.text).toBe('Pensando…');
  });

  it('status shell: balão "Esperando o shell" no lugar do "Concluiu", aviso no máximo a cada 10 min; ShellDone com aviso', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/loja', role: 'x', startedAt: now(), status: 'working' });
    const name = office.get('acc:1')!.name;
    office.commit();
    const job = { id: 'b1', label: 'Build de produção', command: 'npm run build', startedAt: now(), background: true, kind: 'shell' as const };
    office.setShells('acc:1', [job, { ...job, id: 'b2', label: 'Migração', startedAt: now() + 5 }]);
    advance(1_000);
    office.setStatus('acc:1', 'shell');
    office.fillShellActivity('acc:1');
    expect(office.get('acc:1')!.activity).toMatchObject({ text: 'Esperando 2 shells: Build de produção', detail: 'npm run build', tool: 'ShellWait' });
    // O "Concluiu" do transcript chega depois: o balão continua na espera.
    advance(500);
    office.addActivity('acc:1', { ...act('fim', now(), 'done'), text: 'Concluiu em 3s' }, true);
    office.fillShellActivity('acc:1');
    expect(office.get('acc:1')!.activity!.tool).toBe('ShellWait');
    let r = office.commit();
    expect(r.notices.map((n) => n.text)).toEqual([`⏳ ${name} está esperando o shell em loja: Build de produção`]);
    expect(r.feed.map((f) => f.activity.text)).toEqual(['Esperando 2 shells: Build de produção', 'Concluiu em 3s']);
    expect(r.notices.some((n) => n.text.includes('concluiu'))).toBe(false);
    // Volta a trabalhar e a esperar dentro de 10 min: sem aviso repetido.
    office.setStatus('acc:1', 'working');
    advance(60_000);
    office.setStatus('acc:1', 'shell');
    expect(office.commit().notices).toEqual([]);
    // Fim de um dos shells.
    office.shellDone('acc:1', job, 'ok', now() + 1_000);
    r = office.commit();
    expect(r.snapshot.agents[0].activity).toMatchObject({ tool: 'ShellDone', text: 'Shell terminou: Build de produção (1min 3s)' });
    expect(r.notices.map((n) => [n.level, n.text])).toEqual([['success', `✅ ${name}: shell terminou em loja — Build de produção`]]);
    // Releitura não duplica; outro shell no mesmo segundo ainda avisa.
    office.shellDone('acc:1', job, 'ok', now() + 1_000);
    office.shellDone('acc:1', { ...job, id: 'b2', label: 'Migração' }, 'failed', now() + 1_000);
    r = office.commit();
    expect(r.notices.map((n) => [n.level, n.text])).toEqual([['warn', `❌ ${name}: shell falhou em loja — Migração`]]);
    expect(office.detail('acc:1')!.history.filter((a) => a.tool === 'ShellDone')).toHaveLength(2);
  });

  it('subagente: concluir ou fechar a sessão limpa os shells', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addSub({ id: 's1:x', parentId: 'acc:1', sessionId: 's1', role: 'Explore', background: false, startedAt: now() });
    const job = { id: 'fg', label: 'x', startedAt: now(), background: false, kind: 'shell' as const };
    office.setShells('acc:1', [job]);
    office.setShells('s1:x', [job]);
    office.completeSub('s1:x');
    expect(office.get('s1:x')!.shells).toBeUndefined();
    office.setShells('s1:x', [job]);
    expect(office.get('s1:x')!.shells).toBeUndefined();
    office.closeMain('acc:1');
    expect(office.get('acc:1')!.shells).toBeUndefined();
  });

  it('subagente concluído fica 25 s; principal offline fica 20 s e leva a sala junto', () => {
    const { office, advance, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'x', startedAt: now(), status: 'working' });
    office.addSub({ id: 's1:x', parentId: 'acc:1', sessionId: 's1', role: 'Explore', title: 'Mapear', background: false, startedAt: now() });
    office.addSub({ id: 's1:y', parentId: 'acc:1', sessionId: 's1', role: 'Plan', background: true, startedAt: now() });
    office.completeSub('s1:x');
    expect(office.commit().notices.at(-1)?.text).toMatch(/entregou “Mapear” para/);
    advance(DONE_GRACE_MS + 1);
    office.tick();
    expect(office.has('s1:x')).toBe(false);
    office.closeMain('acc:1');
    expect(office.get('s1:y')!.status).toBe('done');
    advance(OFFLINE_GRACE_MS + 1);
    office.tick();
    const snap = office.commit().snapshot;
    expect(snap.agents).toEqual([]);
    expect(snap.rooms).toEqual([]);
  });

  it('demo misturado: salas no mesmo alocador, contas próprias e liga/desliga', () => {
    const { office, now } = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/real', role: 'x', startedAt: now(), status: 'idle' });
    office.setDemo(true);
    const snap = office.commit().snapshot;
    expect(snap.meta.demo).toBe(true);
    const slots = snap.rooms.map((r) => r.slot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(snap.rooms.find((r) => r.id === '/p/real')!.slot).toBe(0);
    expect(snap.agents.some((a) => a.id.startsWith('demo:'))).toBe(true);
    expect(snap.accounts.map((a) => a.short)).toEqual(['C', 'X', 'Y']);
    const demoAgent = snap.agents.find((a) => a.id.startsWith('demo:'))!;
    expect(office.detail(demoAgent.id)?.agent.id).toBe(demoAgent.id);
    office.setDemo(false);
    const off = office.commit().snapshot;
    expect(off.meta.demo).toBe(false);
    expect(off.agents.map((a) => a.id)).toEqual(['acc:1']);
  });

  it('meta.terminal: só com o terminal ligado', () => {
    expect(makeOffice().office.commit().snapshot.meta.terminal).toBe(false);
    const deps = { names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined };
    expect(new Office({ ...deps, terminal: true }).commit().snapshot.meta.terminal).toBe(true);
    expect(new Office({ ...deps, terminal: false }).commit().snapshot.meta.terminal).toBe(false);
  });

  it('canMessage: só principais presentes que o registro de mensagens vê conectados; meta.messages com o recurso ligado', () => {
    const reach = new Set<string>();
    const deps = { names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined };
    const office = new Office({ ...deps, messages: () => reach });
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/a', role: 'Agente principal', startedAt: 0, status: 'idle' });
    office.addMain({ id: 'acc:2', account: 'acc', sessionId: 's2', cwd: '/p/a', role: 'Agente principal', startedAt: 0, status: 'working' });
    office.addSub({ id: 's1:sub', parentId: 'acc:1', sessionId: 's1', role: 'Explore', background: false, startedAt: 0 });
    reach.add('acc:1').add('s1:sub');
    office.markDirty();
    const snap = office.commit().snapshot;
    expect(snap.meta.messages).toBe(true);
    expect(snap.agents.filter((a) => a.canMessage).map((a) => a.id)).toEqual(['acc:1']);
    // Quem encerrou a sessão não recebe, mesmo que o registro ainda não tenha notado.
    office.closeMain('acc:1');
    expect(office.commit().snapshot.agents.filter((a) => a.canMessage)).toEqual([]);
    // Sem o registro (recurso desligado): meta.messages falso e os principais do demo também não recebem.
    const off = new Office(deps);
    off.setDemo(true);
    const offSnap = off.commit().snapshot;
    expect(offSnap.meta.messages).toBe(false);
    expect(offSnap.agents.some((a) => a.canMessage)).toBe(false);
    const on = new Office({ ...deps, messages: () => new Set() });
    on.setDemo(true);
    expect(on.commit().snapshot.agents.filter((a) => a.canMessage).every((a) => a.kind === 'main' && a.id.startsWith('demo:'))).toBe(true);
    expect(on.commit().snapshot.agents.some((a) => a.canMessage)).toBe(true);
  });
});
