// Rotas do quadro de tarefas. Só pelo próprio computador (a trava fica em http/app.ts); o guard (http/guard.ts) já
// exigiu JSON e Origin local nos POST.
//
//   GET  /api/board                                  200 BoardIndex (projetos do Orca, times do Linear)
//   GET  /api/board/projects/:id[?refresh=1]         200 BoardView | 404
//   POST /api/board/projects/:id/config              {source, linearTeam?}: 200 BoardProject | 400 | 404
//   POST /api/board/projects/:id/cards               {kind, title, body}: 201 BoardCard | 400 | 404 | 502 (fonte)
//   POST /api/board/projects/:id/cards/:card/plan    {}: 202 BoardCard (Planejando; o plano chega depois) | 404 | 409
//   PUT  /api/board/projects/:id/cards/:card/plan    PlanEdit: 200 BoardCard | 400 | 404 | 409
//   POST /api/board/projects/:id/cards/:card/approve {}: 200 BoardCard (na fila) | 404 | 409
//   POST /api/board/projects/:id/cards/:card/discard {}: 200 BoardCard (de volta à coluna da fonte; cancela a execução)
//   POST /api/board/projects/:id/cards/:card/retry   {}: 200 BoardCard (card travado volta a rodar) | 409
//   POST /api/board/projects/:id/cards/:card/answer  {questionId, text}: 200 BoardCard | 400 | 409
//
// `:id` é o id do projeto no Orca com encodeURIComponent ("github%3Adono%2Frepo").
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CARD_BODY_MAX, CARD_TITLE_MAX, type BoardProjectConfig, type NewCard } from '../../shared/board';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { BoardResult, BoardService } from './service';

const PROJECT = /^\/api\/board\/projects\/([^/]+)(\/config|\/cards)?$/;
const TEAM = /^[A-Za-z0-9_-]{1,32}$/;
const CARD_ACTION = /^\/api\/board\/projects\/([^/]+)\/cards\/([^/]+)\/(plan|approve|discard|retry|answer)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: tr('método não permitido') });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
  log.warnOnce(`board:${errMsg(err)}`, `Quadro: ${errMsg(err)}`);
  sendJson(res, 502, { error: tr('O Orca não respondeu: {0}', [errMsg(err)]) });
}

export function parseConfig(body: unknown): BoardProjectConfig {
  const b = body as { source?: unknown; linearTeam?: unknown } | null;
  const source = b?.source;
  if (source !== null && source !== 'github' && source !== 'linear') throw new HttpError(400, tr('esperado {source: "github" | "linear" | null, linearTeam?}'));
  if (source === 'linear') {
    if (typeof b?.linearTeam !== 'string' || !TEAM.test(b.linearTeam)) throw new HttpError(400, tr('escolha o time do Linear'));
    return { source, linearTeam: b.linearTeam };
  }
  return { source };
}

export function parseNewCard(body: unknown): NewCard {
  const b = body as { kind?: unknown; title?: unknown; body?: unknown } | null;
  const kind = b?.kind;
  if (kind !== 'issue' && kind !== 'feature' && kind !== 'fix') throw new HttpError(400, tr('tipo do card: issue, feature ou fix'));
  const title = typeof b?.title === 'string' ? b.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > CARD_TITLE_MAX) throw new HttpError(400, tr('o título precisa ter de 1 a {0} caracteres', [CARD_TITLE_MAX]));
  const text = typeof b?.body === 'string' ? b.body.replace(/\0/g, '').trim() : '';
  if (text.length > CARD_BODY_MAX) throw new HttpError(400, tr('a descrição passa de {0} caracteres', [CARD_BODY_MAX]));
  return { kind, title, body: text };
}

export function createBoardRoutes(board: BoardService): (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => void {
  return (req, res, path, url) => {
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';
    if (path === '/api/board') {
      if (!isRead) return methodNotAllowed(res, 'GET');
      board.index().then((i) => sendJson(res, 200, i), (err) => fail(res, err));
      return;
    }
    const act = CARD_ACTION.exec(path);
    if (act) {
      let pid: string;
      let cid: string;
      try {
        pid = decodeURIComponent(act[1]);
        cid = decodeURIComponent(act[2]);
      } catch {
        return sendJson(res, 400, { error: tr('id inválido') });
      }
      const verb = act[3];
      const reply = (r: BoardResult<unknown>, okStatus = 200) => ('ok' in r ? sendJson(res, okStatus, r.ok) : sendJson(res, r.status, { error: r.error }));
      if (verb === 'plan' && method === 'PUT') {
        readJson(req)
          .then(async (body) => {
            const b = body as { summary?: unknown; actions?: unknown } | null;
            if (!Array.isArray(b?.actions)) throw new HttpError(400, tr('esperado {actions: [...], summary?}'));
            reply(await board.editPlan(pid, cid, { actions: b.actions, ...(typeof b.summary === 'string' ? { summary: b.summary } : {}) }));
          })
          .catch((err) => fail(res, err));
        return;
      }
      if (method !== 'POST') return methodNotAllowed(res, verb === 'plan' ? 'POST, PUT' : 'POST');
      readJson(req)
        .then(async (body) => {
          if (verb === 'plan') reply(await board.plan(pid, cid), 202);
          else if (verb === 'approve') reply(await board.approve(pid, cid));
          else if (verb === 'retry') reply(await board.retry(pid, cid));
          else if (verb === 'answer') {
            const b = body as { questionId?: unknown; text?: unknown } | null;
            const text = typeof b?.text === 'string' ? b.text.trim().slice(0, 4_000) : '';
            if (typeof b?.questionId !== 'string' || !text) throw new HttpError(400, tr('esperado {questionId, text}'));
            reply(await board.answer(pid, cid, b.questionId, text));
          } else reply(await board.discard(pid, cid));
        })
        .catch((err) => fail(res, err));
      return;
    }
    const m = PROJECT.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    if (m[2] === '/cards') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      readJson(req)
        .then(async (body) => {
          const r = await board.create(id, parseNewCard(body));
          if (!r) return sendJson(res, 404, { error: tr('projeto do Orca desconhecido') });
          if ('error' in r) return sendJson(res, 502, { error: r.error });
          sendJson(res, 201, r.card);
        })
        .catch((err) => fail(res, err));
      return;
    }
    if (m[2]) {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      readJson(req)
        .then(async (body) => {
          const p = await board.setConfig(id, parseConfig(body));
          if (!p) return sendJson(res, 404, { error: tr('projeto do Orca desconhecido') });
          sendJson(res, 200, p);
        })
        .catch((err) => fail(res, err));
      return;
    }
    if (!isRead) return methodNotAllowed(res, 'GET');
    board
      .view(id, url.searchParams.get('refresh') === '1')
      .then((v) => (v ? sendJson(res, 200, v) : sendJson(res, 404, { error: tr('projeto do Orca desconhecido') })))
      .catch((err) => fail(res, err));
  };
}
