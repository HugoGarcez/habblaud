// API de depuração do mundo (console: `codetown.world.debug`), usada em testes visuais para
// forçar cenários: sessões simuladas chegando/saindo, salas fechando, hora do dia, câmera.
import type { AgentInfo, AgentStatus, RoomInfo } from '../../../shared/types';
import { hash32 } from '../../../shared/hash';
import { TILE } from '../art/api';
import type { Camera } from './camera';
import type { Renderer } from './render/renderer';
import type { Sim } from './sim/sim';

export interface SpawnOptions {
  /** Nome do projeto (sala). Padrão: um nome novo; se a sala existir, reaproveita. */
  project?: string;
  name?: string;
  /** Id da conta (AccountInfo.id). */
  account?: string;
  status?: AgentStatus;
  /** Quantos subagentes (trabalhando) disparar junto. */
  subs?: number;
}

export interface WorldDebug {
  /** Resumo do estado: salas (fase, luz) e personagens (modo, passo, posição). */
  state(): unknown;
  /** Abre uma sessão simulada (sala nova se preciso). Retorna o id do agente principal. */
  spawnSession(opts?: SpawnOptions): string;
  /** Muda o status de uma sessão simulada (ex.: 'waiting', 'idle') ou de um subagente simulado. */
  setStatus(agentId: string, status: AgentStatus, waitingFor?: string): void;
  /** Encerra uma sessão simulada (o agente some do snapshot; os subagentes também). */
  endSession(agentId: string): void;
  /** Simula o encerramento de uma sessão real (vai embora; se for o último, apaga a luz). */
  closeSession(agentId: string): void;
  /** Simula o fim de todas as sessões de uma sala: todos saem e a sala some do "snapshot". */
  closeRoom(roomId: string): void;
  /** Desfaz os encerramentos simulados e remove as sessões simuladas. */
  reset(): void;
  /** Força a hora do dia (0–24) para o ciclo dia/noite; null volta à hora local. */
  setHour(hour: number | null): void;
  /** Centraliza a câmera num ponto (tiles) com zoom opcional, sem animação. */
  lookAt(tx: number, ty: number, zoom?: number): void;
  /** Centraliza a câmera numa sala (id ou nome). */
  lookAtRoom(idOrName: string, zoom?: number): void;
  /** Avança todos os comportamentos até o destino (como ao voltar de uma aba oculta). */
  fastForward(): void;
  /** Faz todos os ociosos saírem para passear agora. */
  wanderNow(): void;
  /** Junta dois ociosos numa conversa ou partida de ping-pong. Retorna os nomes ou null. */
  socialize(kind: 'talk' | 'pingpong'): string[] | null;
  readonly sim: Sim;
  readonly camera: Camera;
}

const NAMES = ['Lia', 'Otávio', 'Bruna', 'Caio', 'Iara', 'Rui', 'Nina', 'Davi', 'Tais', 'Ivo'];

export function createDebug(sim: Sim, renderer: Renderer, camera: Camera, onCameraMoved: () => void): WorldDebug {
  let seq = 0;
  const now = () => Date.now();
  const reapply = () => sim.reapply(now());

  const freeSlot = (): number => {
    const used = new Set<number>([...sim.rooms.values()].map((r) => r.slot));
    for (const r of sim.injected.rooms) used.add(r.slot);
    let s = 0;
    while (used.has(s)) s++;
    return s;
  };

  const makeAgent = (base: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'name' | 'roomId' | 'kind' | 'account' | 'sessionId'>): AgentInfo => {
    const t = now();
    return {
      look: seq % 2 ? 'f' : 'm',
      role: base.kind === 'main' ? 'Agente principal' : 'Explore',
      status: 'working',
      recent: [],
      tasks: base.kind === 'main' ? [{ id: '1', title: 'Testar o mundo', status: 'in_progress' }, { id: '2', title: 'Revisar', status: 'pending' }] : [],
      startedAt: t,
      lastEventAt: t,
      statusSince: t,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: hash32(base.id),
      activity: { id: `dbg-act-${++seq}`, kind: 'edit', icon: '✏️', text: 'Editando world.ts', at: t },
      ...base,
    };
  };

  return {
    state: () => ({
      cols: sim.building.cols,
      camera: { x: Math.round(camera.x), y: Math.round(camera.y), zoom: camera.zoom },
      rooms: [...sim.rooms.values()].map((r) => ({
        id: r.id,
        name: r.info.name,
        slot: r.slot,
        phase: r.phase,
        listed: r.listed,
        lightOn: r.lightOn,
        light: Math.round(r.light(now()) * 100) / 100,
        occupants: sim.occupants(r),
      })),
      chars: [...sim.chars.values()].map((c) => ({
        id: c.id,
        name: c.info.name,
        kind: c.info.kind,
        status: c.info.status,
        mode: c.mode,
        step: c.step?.t ?? null,
        queue: c.queue.map((s) => s.t),
        tile: [c.tx, c.ty],
        room: c.roomId,
        spot: c.atSpot,
        leaving: c.leaving,
        pose: c.pose,
      })),
    }),

    spawnSession: (opts = {}) => {
      const project = opts.project ?? `projeto-teste-${seq + 1}`;
      let room: RoomInfo | undefined = [...sim.rooms.values()].map((r) => r.info).find((r) => r.name === project) ?? sim.injected.rooms.find((r) => r.name === project);
      if (!room) {
        const id = `/debug/${project}`;
        room = { id, name: project, path: id, slot: freeSlot(), seed: hash32(id), createdAt: now() };
        sim.injected.rooms.push(room);
      }
      const n = ++seq;
      const sessionId = `dbg-sess-${n}`;
      const account = opts.account ?? [...sim.accounts.keys()][n % Math.max(1, sim.accounts.size)] ?? '.claude';
      const main = makeAgent({
        id: `dbg:${n}`,
        kind: 'main',
        name: opts.name ?? NAMES[n % NAMES.length],
        roomId: room.id,
        account,
        sessionId,
        status: opts.status ?? 'working',
        title: `Sessão de teste ${n}`,
      });
      sim.injected.agents.push(main);
      for (let i = 0; i < (opts.subs ?? 0); i++) {
        const k = ++seq;
        sim.injected.agents.push(
          makeAgent({ id: `${sessionId}:sub${k}`, kind: 'sub', parentId: main.id, name: NAMES[k % NAMES.length], roomId: room.id, account, sessionId, title: 'Investigar o bug' }),
        );
      }
      reapply();
      return main.id;
    },

    setStatus: (id, status, waitingFor) => {
      const i = sim.injected.agents.findIndex((x) => x.id === id);
      if (i < 0) return;
      // cópia nova (como um snapshot de verdade), para o mundo perceber a mudança
      const a: AgentInfo = { ...sim.injected.agents[i] };
      sim.injected.agents[i] = a;
      a.status = status;
      a.statusSince = now();
      a.waitingFor = status === 'waiting' ? (waitingFor ?? 'aprovar uma permissão') : undefined;
      a.activity = {
        id: `dbg-act-${++seq}`,
        kind: status === 'idle' || status === 'done' ? 'done' : status === 'waiting' ? 'wait' : 'run',
        icon: status === 'idle' || status === 'done' ? '✅' : status === 'waiting' ? '✋' : '💻',
        text: status === 'idle' || status === 'done' ? 'Concluiu' : status === 'waiting' ? 'Precisa de você' : 'Rodando testes',
        at: now(),
      };
      reapply();
    },

    endSession: (id) => {
      const main = sim.injected.agents.find((x) => x.id === id);
      sim.injected.agents = sim.injected.agents.filter((x) => x.id !== id && x.parentId !== id);
      if (main && !sim.injected.agents.some((x) => x.roomId === main.roomId)) sim.injected.rooms = sim.injected.rooms.filter((r) => r.id !== main.roomId);
      reapply();
    },

    closeSession: (id) => {
      sim.forcedOffline.add(id);
      for (const c of sim.chars.values()) if (c.info.parentId === id) sim.forcedOffline.add(c.id);
      reapply();
    },

    closeRoom: (roomId) => {
      for (const c of sim.chars.values()) if (c.roomId === roomId) sim.forcedOffline.add(c.id);
      sim.hiddenRooms.add(roomId);
      reapply();
    },

    reset: () => {
      sim.forcedOffline.clear();
      sim.hiddenRooms.clear();
      sim.injected.agents = [];
      sim.injected.rooms = [];
      reapply();
    },

    setHour: (h) => {
      renderer.hourOverride = h;
    },

    lookAt: (tx, ty, zoom) => {
      onCameraMoved();
      camera.follow = null;
      camera.stop();
      camera.x = tx * TILE;
      camera.y = ty * TILE;
      if (zoom) camera.zoom = zoom;
      camera.clamp();
    },

    lookAtRoom: (idOrName, zoom = 2.5) => {
      const room = [...sim.rooms.values()].find((r) => r.id === idOrName || r.info.name === idOrName);
      if (!room) return;
      const r = room.layout.rect;
      onCameraMoved();
      camera.follow = null;
      camera.stop();
      camera.x = (r.x + r.w / 2) * TILE;
      camera.y = (r.y + r.h / 2) * TILE;
      camera.zoom = zoom;
      camera.clamp();
    },

    fastForward: () => sim.fastForward(now()),

    wanderNow: () => {
      for (const c of sim.chars.values()) c.nextOutingAt = 1;
    },

    socialize: (kind) => {
      const idle = [...sim.chars.values()].filter((c) => c.mode === 'idle' && !c.leaving && !c.meeting && !c.arriving);
      if (idle.length < 2) return null;
      return sim.startMeeting(kind, idle[0], idle[1]) ? [idle[0].info.name, idle[1].info.name] : null;
    },

    sim,
    camera,
  };
}
