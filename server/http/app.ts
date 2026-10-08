// Rotas da API (/api/*). Respostas JSON; rotas desconhecidas -> 404 JSON.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SourceInfo } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import type { DayStatsService } from '../history/daystats';
import type { Office } from '../model/office';
import type { SessionHistory } from '../sources/history';
import { isJsonContentType, isLoopbackHost } from './guard';
import { handleSessionsRoute } from './sessions';
import type { Hub } from './sse';
import { handleStatsRoute } from './stats';
import type { TerminalStreams } from './terminal';

export interface ApiDeps {
  office: Office;
  hub: Hub;
  accounts: AccountsService;
  sources: () => SourceInfo[];
  version: string;
  inDocker: boolean;
  /** Terminal somente leitura ligado (ServerConfig.terminal: só com bind local). */
  terminal?: boolean;
  /** Streams do terminal; sem eles o recurso fica desligado mesmo com `terminal`. */
  terminals?: TerminalStreams;
  /** Histórico de sessões do terminal (GET /api/sessions/*, http/sessions.ts); mesma trava do terminal. */
  sessions?: SessionHistory;
  /** Rotas do timelapse (/api/timeline/*, ver http/timeline.ts); devolve false para o resto. */
  timeline?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  /**
   * Rotas de /api/permissions (responder pelo escritório, server/permissions/http.ts). Só existem com bind
   * local (ServerConfig.terminal); a trava do Host local é conferida aqui antes de chamá-las.
   */
  permissions?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /** Estatísticas do "Meu dia" (GET /api/stats, http/stats.ts). */
  stats?: DayStatsService;
}

/** GET /api/agents/:id/terminal (ids nunca contêm '/'). */
const TERMINAL_ROUTE = /^\/api\/agents\/([^/]+)\/terminal$/;

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // A API só é lida pela própria página: nada de leitura "no-cors" por outras origens.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(data);
}

/** Lê o corpo JSON. Exige `Content-Type: application/json` (barreira contra CSRF; ver http/guard.ts). */
export function readJson(req: IncomingMessage): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    return Promise.reject(new HttpError(415, 'envie o corpo como JSON (Content-Type: application/json)'));
  }
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Grande demais: continua drenando (sem guardar) para conseguir responder 413.
      if (size > MAX_BODY) return void fail(new HttpError(413, 'corpo grande demais'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', fail);
  });
}

/** Devolve um handler que trata /api/* e responde false para o resto. */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { office, hub, accounts } = deps;
  const terminals = deps.terminal ? deps.terminals : undefined;

  const methodNotAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'método não permitido' });
  };

  const handleDemo = async (req: IncomingMessage, res: ServerResponse) => {
    const body = (await readJson(req)) as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'esperado {enabled: boolean}');
    office.setDemo(body.enabled);
    sendJson(res, 200, { ok: true, demo: office.isDemo() });
  };

  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: 'erro interno' });
  };

  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return false;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (path === '/api/stream') {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else hub.attach(req, res);
      return true;
    }
    if (path === '/api/snapshot') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, hub.current());
      return true;
    }
    if (path === '/api/health') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          demo: office.isDemo(),
          docker: deps.inDocker,
          terminal: !!terminals,
          permissions: !!deps.permissions,
          sources: deps.sources(),
          accounts: accounts.entries().map((a) => ({ id: a.id, usageStatus: accounts.usageView(a.id).status })),
        });
      }
      return true;
    }
    const terminalMatch = TERMINAL_ROUTE.exec(path);
    if (terminalMatch) {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else if (!terminals) {
        sendJson(res, 403, { error: 'terminal somente leitura desligado: ele só funciona com o CodeTown acessível apenas pelo próprio computador' });
      } else if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'o terminal somente leitura só abre pelo próprio computador (http://localhost ou http://127.0.0.1)' });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(terminalMatch[1]);
        } catch {
          sendJson(res, 400, { error: 'id inválido' });
          return true;
        }
        terminals.attach(req, res, id);
      }
      return true;
    }
    if (path.startsWith('/api/sessions/')) {
      handleSessionsRoute(req, res, path, { history: deps.terminal ? deps.sessions : undefined, terminals });
      return true;
    }
    if (path === '/api/permissions' || path.startsWith('/api/permissions/')) {
      // Responder pelo escritório age sobre as sessões: a mesma trava do terminal (bind local + Host local).
      if (!deps.permissions) {
        sendJson(res, 403, { error: 'responder pelo escritório desligado: só funciona com o CodeTown acessível apenas pelo próprio computador' });
      } else if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'pedidos de permissão só são respondidos pelo próprio computador (http://localhost ou http://127.0.0.1)' });
      } else {
        deps.permissions(req, res, path);
      }
      return true;
    }
    if (path.startsWith('/api/agents/')) {
      if (!isRead) {
        methodNotAllowed(res, 'GET');
        return true;
      }
      let id: string;
      try {
        id = decodeURIComponent(path.slice('/api/agents/'.length));
      } catch {
        sendJson(res, 400, { error: 'id inválido' });
        return true;
      }
      const detail = office.detail(id);
      if (detail) sendJson(res, 200, detail);
      else sendJson(res, 404, { error: 'agente não encontrado' });
      return true;
    }
    if (path === '/api/stats' || path.startsWith('/api/stats/')) {
      handleStatsRoute(req, res, url, deps.stats, sendJson);
      return true;
    }
    if (path === '/api/demo') {
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else handleDemo(req, res).catch((err) => fail(res, err));
      return true;
    }
    if (deps.timeline?.(req, res, url)) return true;
    sendJson(res, 404, { error: 'rota desconhecida' });
    return true;
  };
}
