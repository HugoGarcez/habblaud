// Servidor do CodeTown: observa as sessões abertas do Claude Code (todas as contas),
// mantém o modelo do escritório e transmite via SSE. Sem dependências de runtime.
//   npm run dev    -> tsx server/index.ts --dev (Vite em middleware mode, HMR no mesmo servidor)
//   npm start      -> node dist/server/index.js (serve dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { AccountsService } from './accounts/service';
import { loadConfig } from './config';
import { createApiHandler, sendJson } from './http/app';
import { createRequestGuard } from './http/guard';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { ClaudeWatcher } from './sources/watcher';
import { createBuildReader } from './build';

const config = loadConfig();
const startedAt = Date.now();

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();

// Office, contas e watcher se referenciam (avisos de mudança / fontes): ligação tardia.
const late: { office?: Office; watcher?: ClaudeWatcher } = {};
const accounts = new AccountsService({
  dirs: config.claudeDirs,
  home: config.home,
  env: process.env,
  usageDir: config.usageDir,
  onChange: () => late.office?.markDirty(),
});
const office = new Office({
  names,
  version: config.version,
  // No modo dev o Vite serve o cliente direto do código-fonte: não há build para comparar.
  build: config.dev ? undefined : createBuildReader(config.rootDir),
  startedAt,
  accounts: (sessions) => accounts.list(sessions),
  sources: () => late.watcher?.sources() ?? [],
  accountName: (id) => accounts.find(id)?.detected.name,
});
const watcher = new ClaudeWatcher({ accounts, office, inDocker: config.inDocker });
late.office = office;
late.watcher = watcher;
const hub = new Hub(office);

if (config.demo) office.setDemo(true);
watcher.start();
accounts.start();
hub.start();
const ticker = setInterval(() => {
  try {
    office.tick();
  } catch (err) {
    log.warnOnce(`tick:${errMsg(err)}`, `Falha no relógio do escritório: ${errMsg(err)}`);
  }
}, 250);

const api = createApiHandler({
  office,
  hub,
  accounts,
  sources: () => watcher.sources(),
  version: config.version,
  inDocker: config.inDocker,
});

const server = http.createServer();
let closeVite: (() => Promise<void>) | undefined;

function parseUrl(req: http.IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return new URL('/', 'http://localhost');
  }
}

/** Quem atende o que não é /api: o Vite (dev) ou os arquivos de dist/client (produção). */
let fallback: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void;
if (config.dev) {
  // Import dinâmico: o bundle de produção nunca carrega o Vite.
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(config.rootDir, 'vite.config.ts'),
    server: { middlewareMode: true, ws: { server } },
    appType: 'spa',
  });
  closeVite = () => vite.close();
  fallback = (req, res) => vite.middlewares(req, res);
} else {
  const serveStatic = createStaticHandler(join(config.rootDir, 'dist', 'client'));
  fallback = (req, res, url) => serveStatic(req, res, url.pathname);
}

// Host/Origin/Content-Type: barra DNS rebinding e CSRF antes de qualquer rota (inclusive o Vite).
const guard = createRequestGuard({ allowedHosts: config.allowedHosts });

server.on('request', (req, res) => {
  const url = parseUrl(req);
  try {
    if (guard(req, res)) return;
    if (!api(req, res, url)) fallback(req, res, url);
  } catch (err) {
    log.warn(`Erro ao responder ${req.method} ${url.pathname}: ${errMsg(err)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'erro interno' });
    else res.destroy();
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') log.error(`A porta ${config.port} já está em uso (defina CODETOWN_PORT para usar outra).`);
  else log.error(`Erro no servidor HTTP: ${errMsg(err)}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info(`🏢 CodeTown ${config.version}${config.dev ? ' (dev)' : ''}${config.inDocker ? ' (docker)' : ''} em http://${host}:${config.port}`);
  const list = accounts.entries();
  if (!list.length) log.warn('Nenhuma pasta do Claude Code encontrada (defina CODETOWN_CLAUDE_DIRS).');
  for (const a of list) {
    const src = watcher.sources().find((s) => s.label === a.id);
    const usage = accounts.usageView(a.id).status;
    log.info(`   Conta ${a.detected.short} (${a.id}): ${src?.sessions ?? 0} sessão(ões) aberta(s) · uso: ${usage} · ${a.dir}`);
  }
  if (office.isDemo()) log.info('   Modo demonstração ligado (agentes simulados misturados aos reais).');
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Encerrando (${signal})…`);
  clearInterval(ticker);
  watcher.stop();
  accounts.stop();
  hub.stop();
  names.flush();
  void closeVite?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
