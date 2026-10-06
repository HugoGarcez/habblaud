// Integração da simulação sem DOM: snapshots -> personagens andando, sentando, apagando a luz e indo embora.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, RoomInfo } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { Sim } from './sim';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const appearance: Appearance = {
  skin: '#f0c8a0',
  hair: '#3a2a20',
  hairStyle: 'short',
  eyes: '#222',
  top: '#3f7fd8',
  topAccent: '#fff',
  topStyle: 'tshirt',
  bottom: '#333',
  shoes: '#111',
  accessory: 'none',
  accessoryColor: '#000',
  lanyard: null,
  look: 'm',
};

const art = {
  appearanceFromSeed: () => appearance,
  roomTheme: () => theme,
} as unknown as ArtModule;

const T0 = 1_700_000_000_000;

function room(id: string, slot: number): RoomInfo {
  return { id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 };
}

function agent(id: string, roomId: string, status: AgentInfo['status'], extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId,
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status,
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], rev = 1): OfficeSnapshot {
  return {
    rev,
    serverTime: T0,
    rooms,
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  };
}

/** Avança a simulação em passos de 1/30 s. */
function run(sim: Sim, clock: { now: number }, seconds: number, until?: () => boolean): void {
  const steps = Math.round(seconds * 30);
  for (let i = 0; i < steps; i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    if (until?.()) return;
  }
}

function newSim(): Sim {
  return new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
}

describe('simulação do escritório', () => {
  it('carga inicial: quem trabalha já está sentado digitando, sala acesa', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/a', 'waiting', { waitingFor: 'aprovar' })]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    const bia = sim.chars.get('bia')!;
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('type');
    expect(bia.pose).toBe('raise_hand');
    expect(bia.mode).toBe('wait');
    const r = sim.rooms.get('/a')!;
    expect(r.phase).toBe('ready');
    expect(r.lightOn).toBe(true);
  });

  it('chegada: sala nova é construída apagada, o primeiro acende a luz e senta', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.phase).toBe('building');
    expect(b.lightOn).toBe(false);
    const caio = sim.chars.get('caio')!;
    expect(caio.step?.t ?? caio.queue[0]?.t).toBe('elevOut');
    run(sim, clock, 60, () => !!caio.homeSpot && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.phase).toBe('ready');
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
    run(sim, clock, 0.1);
    expect(caio.pose).toBe('type');
  });

  it('chegada: mudar de status a caminho do interruptor não deixa a sala no escuro', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 3);
    expect(b.lightOn).toBe(false);
    expect(b.switchClaim).toBe('caio');
    // ainda andando até o interruptor: o status muda duas vezes (o plano é refeito)
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'waiting', { waitingFor: 'aprovar' })], 3), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 4), clock.now);
    run(sim, clock, 60, () => b.lightOn && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
  });

  it('saída: quem acabou de acender a luz e já precisa ir embora apaga de novo ao sair', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 60, () => caio.step?.t === 'switch');
    expect(caio.step?.t).toBe('switch');
    // a sessão termina bem no meio do clique do interruptor
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 3), clock.now);
    run(sim, clock, 20, () => caio.leaving && !b.lightOn);
    expect(b.lightOn).toBe(false);
    // ainda a caminho do elevador quando a luz apaga
    expect(sim.chars.has('caio')).toBe(true);
    run(sim, clock, 90, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
  });

  it('saída: o último apaga a luz, vai ao elevador, some e a sala é desmontada', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working'), agent('davi', '/b', 'idle')]), clock.now);
    run(sim, clock, 0.5);
    // sessões da sala /b encerram: caio fica offline, davi some do snapshot
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.listed).toBe(false);
    expect(sim.chars.get('caio')!.mode).toBe('leave');
    // davi só sai depois do debounce de 3 s
    run(sim, clock, 1);
    expect(sim.chars.get('davi')!.leaving).toBe(false);
    run(sim, clock, 3);
    expect(sim.chars.get('davi')!.leaving).toBe(true);
    // exatamente um deles se encarrega do interruptor
    expect(b.switchClaim).not.toBeNull();
    run(sim, clock, 90, () => !b.lightOn);
    expect(b.lightOn).toBe(false);
    run(sim, clock, 90, () => !sim.chars.has('caio') && !sim.chars.has('davi'));
    expect(sim.chars.has('caio')).toBe(false);
    expect(sim.chars.has('davi')).toBe(false);
    run(sim, clock, 10, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    // a outra sala continua acesa
    expect(sim.rooms.get('/a')!.lightOn).toBe(true);
  });

  it('subagente entrega o resultado ao pai e vai embora', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const main = agent('ana', '/a', 'working');
    sim.applySnapshot(snap(rooms, [main]), clock.now);
    run(sim, clock, 0.2);
    const sub = agent('ana:s1', '/a', 'working', { kind: 'sub', parentId: 'ana', name: 'Beto', title: 'Mapear arquivos' });
    sim.applySnapshot(snap(rooms, [main, sub], 2), clock.now);
    const beto = sim.chars.get('ana:s1')!;
    run(sim, clock, 60, () => beto.atSpot !== null && beto.atSpot === beto.homeSpot && !beto.step && !beto.queue.length);
    expect(beto.homeSpot).not.toBeNull();
    sim.applySnapshot(snap(rooms, [main, { ...sub, status: 'done' }], 3), clock.now);
    expect(beto.mode).toBe('deliver');
    let delivered = false;
    run(sim, clock, 40, () => {
      if (beto.bubbleText?.startsWith('Entregando')) delivered = true;
      return delivered;
    });
    expect(delivered).toBe(true);
    const ana = sim.chars.get('ana')!;
    expect(['check', 'heart']).toContain(ana.icon);
    run(sim, clock, 60, () => !sim.chars.has('ana:s1'));
    expect(sim.chars.has('ana:s1')).toBe(false);
  });

  it('ocioso passeia e volta para a mesa', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    let left = false;
    run(sim, clock, 60, () => {
      if (ana.atSpot !== ana.homeSpot) left = true;
      return left && ana.atSpot === ana.homeSpot;
    });
    expect(left).toBe(true);
    // volta ao trabalho imediatamente quando o status muda
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')], 2), clock.now);
    run(sim, clock, 60, () => !!ana.homeSpot && ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('type');
  });

  it('avanço rápido (aba oculta) teletransporta para os destinos', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    clock.now += 20_000;
    sim.fastForward(clock.now);
    const caio = sim.chars.get('caio')!;
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(caio.alpha).toBe(1);
    expect(sim.rooms.get('/b')!.phase).toBe('ready');
    expect(sim.rooms.get('/b')!.lightOn).toBe(true);
  });

  it('snapshots com falhas não quebram o mundo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/inexistente', 'working'), agent('bia', '/a', 'working', { parentId: 'ninguem', kind: 'sub' })]), clock.now);
    run(sim, clock, 5);
    expect(sim.chars.size).toBe(2);
    // sala some e volta durante a desmontagem: reconstrói
    sim.applySnapshot(snap([], [], 2), clock.now);
    run(sim, clock, 20);
    sim.applySnapshot(snap([room('/a', 0)], [agent('caio', '/a', 'working')], 3), clock.now);
    run(sim, clock, 5);
    const a = sim.rooms.get('/a');
    expect(a).toBeDefined();
    expect(['building', 'ready']).toContain(a!.phase);
  });

  it('carga inicial: ninguém começa parado em banco de corredor/banheiro e nenhuma sala fica vazia', () => {
    for (const since of [T0, T0 - 5 * 60_000]) {
      const sim = newSim();
      const clock = { now: T0 };
      const agents: AgentInfo[] = [];
      for (let i = 0; i < 12; i++) agents.push(agent(`ocioso-${String.fromCharCode(97 + i)}${'x'.repeat(i)}`, i % 2 ? '/b' : '/a', 'idle', { statusSince: since }));
      sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], agents), clock.now);
      for (const ch of sim.chars.values()) {
        const at = ch.atSpot ? sim.spots.get(ch.atSpot) : undefined;
        expect(at, `${ch.id} sem lugar`).toBeDefined();
        expect(at!.kind).not.toBe('bench');
        // quem acabou de ficar ocioso começa na própria mesa
        if (since === T0) expect(ch.atSpot).toBe(ch.homeSpot);
      }
      for (const id of ['/a', '/b']) expect([...sim.chars.values()].some((c) => c.roomId === id && c.atSpot === c.homeSpot)).toBe(true);
      // e ninguém sai passear nos primeiros segundos
      run(sim, clock, 3);
      if (since === T0) for (const ch of sim.chars.values()) expect(ch.atSpot, ch.id).toBe(ch.homeSpot);
    }
  });

  it('sala lotada: quem sobra trabalha em pé DENTRO da sala (não fica rodando na recepção)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents: AgentInfo[] = [];
    for (let i = 0; i < 26; i++) agents.push(agent(`ag-${i}-${'y'.repeat(i)}`, '/a', 'working'));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    run(sim, clock, 25);
    const r = sim.rooms.get('/a')!.layout.rect;
    const inside = (x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const homeless = [...sim.chars.values()].filter((c) => !c.homeSpot);
    expect(homeless.length).toBeGreaterThan(0);
    const tiles = new Set<string>();
    for (const c of homeless) {
      expect(c.standTile, c.id).not.toBeNull();
      expect(inside(c.standTile!.x, c.standTile!.y)).toBe(true);
      expect(inside(c.tx, c.ty), `${c.id} fora da sala em ${c.tx},${c.ty}`).toBe(true);
      const key = `${c.standTile!.x},${c.standTile!.y}`;
      expect(tiles.has(key), `dois no mesmo tile ${key}`).toBe(false);
      tiles.add(key);
    }
    // parados (não andando em círculos) e trabalhando com o notebook
    const before = homeless.map((c) => `${c.tx},${c.ty}`);
    run(sim, clock, 15);
    expect(homeless.map((c) => `${c.tx},${c.ty}`)).toEqual(before);
    expect(homeless.every((c) => c.pose === 'read' && c.held === 'laptop')).toBe(true);
    // vagou um lugar: alguém de pé senta
    const seated = [...sim.chars.values()].find((c) => c.homeSpot && c.atSpot === c.homeSpot)!;
    sim.applySnapshot(snap([room('/a', 0)], agents.filter((a) => a.id !== seated.id), 2), clock.now);
    run(sim, clock, 40, () => homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot));
    expect(homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot)).toBe(true);
  });

  it('delegar: conversa virado para a porta com 💬 (a mão levantada é só para "precisa de você")', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const main = agent('ana', '/a', 'working', { activity: { id: 'a1', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap([room('/a', 0)], [main]), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap([room('/a', 0)], [{ ...main, activity: { id: 'a2', kind: 'delegate', icon: '👥', text: 'Delegando', at: T0 } }], 2), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBe('chat');
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('talk')).toBe(true);
    expect(poses.has('raise_hand')).toBe(false);
  });

  it('cada personagem tem ritmo e faixa próprios (quem sai junto não anda sobreposto)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map((id) => agent(id, '/a', 'working', { seed: id.charCodeAt(0) * 7919 + id.length }));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    const chars = [...sim.chars.values()];
    for (const c of chars) {
      expect(c.speedK).toBeGreaterThanOrEqual(0.92);
      expect(c.speedK).toBeLessThanOrEqual(1.08);
      expect(Math.abs(c.lane)).toBeLessThanOrEqual(4);
    }
    expect(new Set(chars.map((c) => c.speedK.toFixed(3))).size).toBeGreaterThan(1);
    expect(new Set(chars.map((c) => c.lane)).size).toBeGreaterThan(1);
  });
});
