// Pedidos de permissão fictícios do demo: aparecem na espera, respondem pelo escritório (aprovar, recusar,
// devolver ao terminal) e somem quando a espera acaba sozinha.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../hash';
import { demoPermission } from './permission';
import { DemoSimulator } from './simulator';

describe('demoPermission', () => {
  it('monta pedidos completos (título, resumo, argumentos) com prazo', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed < 40; seed++) {
      const p = demoPermission(`p${seed}`, { files: ['src/app.ts'], commands: ['npm test'] }, mulberry32(seed), 1_000);
      kinds.add(p.tool);
      expect(p).toMatchObject({ id: `p${seed}`, createdAt: 1_000 });
      expect(p.expiresAt).toBeGreaterThan(1_000);
      expect(p.title).toMatch(/^(Bash|Edit|WebFetch)\(/);
      expect(p.input).toBeTruthy();
      expect(p.text).toBeTruthy();
      if (p.tool === 'Bash') expect(p.suggestions).toEqual([{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }]);
    }
    expect(kinds).toEqual(new Set(['Bash', 'Edit', 'WebFetch']));
  });
});

describe('DemoSimulator: pedidos de permissão', () => {
  const start = 10_000;

  it('forcePermission: o agente espera com o pedido; aprovar retoma o trabalho e registra a atividade', () => {
    const sim = new DemoSimulator({ seed: 4, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start)!;
    let a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    const p = a.permission!;
    expect(p.id.startsWith('demo:perm-')).toBe(true);
    expect(sim.decidePermission('outro', { behavior: 'allow' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'allow', suggestion: 0 }, start + 1)).toBe(true);
    a = sim.snapshot(start + 1).agents.find((x) => x.id === id)!;
    expect(a.status).toBe('working');
    expect(a.permission).toBeUndefined();
    expect(a.recent.map((r) => r.text)).toContain('Aprovado no CodeTown (sempre permitir)');
    expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 2)).toBe(false);
  });

  it('recusar retoma com a atividade de recusa; terminal só tira o pedido (a espera continua um pouco)', () => {
    const sim = new DemoSimulator({ seed: 5 }, start);
    const a1 = sim.forcePermission(start)!;
    const p1 = sim.snapshot(start).agents.find((x) => x.id === a1)!.permission!;
    sim.decidePermission(p1.id, { behavior: 'deny', message: 'agora não' }, start + 1);
    const after = sim.snapshot(start + 1).agents.find((x) => x.id === a1)!;
    expect(after.status).toBe('working');
    expect(after.recent.at(-1)).toMatchObject({ icon: '🚫', text: 'Recusado no CodeTown' });

    const sim2 = new DemoSimulator({ seed: 6 }, start);
    const a2 = sim2.forcePermission(start)!;
    const p2 = sim2.snapshot(start).agents.find((x) => x.id === a2)!.permission!;
    expect(sim2.decidePermission(p2.id, { behavior: 'terminal' }, start + 1)).toBe(true);
    const still = sim2.snapshot(start + 1).agents.find((x) => x.id === a2)!;
    expect(still.status).toBe('waiting');
    expect(still.permission).toBeUndefined();
    let t = start + 1;
    while (t < start + 20_000 && sim2.snapshot(t).agents.find((x) => x.id === a2)?.status === 'waiting') sim2.tick((t += 250));
    expect(sim2.snapshot(t).agents.find((x) => x.id === a2)?.status).toBe('working');
  });

  it('com o tempo, as esperas por permissão trazem pedido e ele some quando a espera acaba', () => {
    const sim = new DemoSimulator({ seed: 2, speed: 10, sessions: 5 }, 0);
    let withPermission = 0;
    for (let t = 0; t < 600_000; t += 250) {
      sim.tick(t);
      for (const a of sim.snapshot(t).agents) {
        if (a.permission) {
          withPermission++;
          expect(a.status).toBe('waiting');
        }
        if (a.status !== 'waiting') expect(a.permission).toBeUndefined();
      }
    }
    expect(withPermission).toBeGreaterThan(0);
  });
});
