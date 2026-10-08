// Servidor do Habblaud: observa as sessões abertas do Claude Code (todas as contas),
// mantém o modelo do escritório e transmite via SSE. Sem dependências de runtime.
//   npm run dev    -> tsx server/index.ts --dev (Vite em middleware mode, HMR no mesmo servidor)
//   npm start      -> node dist/server/index.js (serve dist/client)
import http from 'node:http';
import { join } from 'node:path';
import { AccountsService } from './accounts/service';
import { loadConfig, terminalOffReason } from './config';
import { createApiHandler, sendJson } from './http/app';
import { createRequestGuard } from './http/guard';
import { Hub } from './http/sse';
import { createStaticHandler } from './http/static';
import { TerminalStreams } from './http/terminal';
import { createTimelineHandler } from './http/timeline';
import { TIMELINE_DIR, TimelineRecorder } from './history/timeline';
import { DayStatsService } from './history/daystats';
import { describeStateMigration, legacyEnvWarning, migrateLegacyStateDir } from './legacy';
import { errMsg, log } from './log';
import { NameStore } from './model/names';
import { Office } from './model/office';
import { openMainAgent, SessionHistory } from './sources/history';
import { createPermissionRoutes } from './permissions/http';
import { PermissionRegistry } from './permissions/registry';
import { ClaudeWatcher } from './sources/watcher';
import { createBuildReader } from './build';
import { UpdateChecker } from './updates/checker';

const config = loadConfig();
const startedAt = Date.now();

// Nome antigo (CodeTown, até a 0.3.2): leva ~/.codetown para ~/.habblaud antes de ler qualquer estado e avisa
// das variáveis CODETOWN_* que não valem mais. No Docker, quem migra é o docker:up.
if (!config.inDocker) {
  const r = migrateLegacyStateDir(config.home);
  const msg = describeStateMigration(r);
  if (msg) (r.error ? log.warn : log.info)(msg);
}
const legacyEnv = legacyEnvWarning(Object.keys(process.env));
if (legacyEnv) log.warn(legacyEnv);

const names = new NameStore(join(config.dataDir, 'names.json'));
names.load();

// Office, contas e watcher se referenciam (avisos de mudança / fontes): ligação tardia.
const late: { office?: Office; watcher?: ClaudeWatcher; permissions?: PermissionRegistry } = {};
// Versão nova: consulta a release mais recente no GitHub a cada 6 h (HABBLAUD_UPDATE_CHECK=0 desliga).
const updates = new UpdateChecker({
  current: config.version,
  repo: config.repo,
  enabled: config.updateCheck,
  file: join(config.dataDir, 'updates.json'),
  onChange: () => late.office?.markDirty(),
});
updates.load();
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
  terminal: config.terminal,
  permissions: () => late.permissions?.snapshot() ?? new Map(),
  updates: () => updates.status(),
});
const watcher = new ClaudeWatcher({ accounts, office, inDocker: config.inDocker });
late.office = office;
late.watcher = watcher;
const hub = new Hub(office);
// "Meu dia": amostra o escritório a cada segundo e persiste em <dataDir>/stats/ (ver history/daystats.ts).
const stats = new DayStatsService({ dir: join(config.dataDir, 'stats'), snapshot: () => hub.current() });
stats.load();
// Terminal somente leitura: só existe com bind local (ver terminalOffReason em config.ts).
const terminals = config.terminal ? new TerminalStreams({ office, transcriptPathOf: (id) => watcher.transcriptPathOf(id) }) : undefined;
// Histórico do terminal (sessões recentes, abertas ou encerradas): mesma trava.
const history = config.terminal
  ? new SessionHistory({ accounts: () => accounts.entries(), openAgentOf: (acc, sid) => openMainAgent(office.list(), acc, sid) })
  : undefined;
// Linha do tempo do timelapse: grava cada snapshot novo (com throttle) em <dataDir>/timeline.
const timelineDir = join(config.dataDir, TIMELINE_DIR);
const timeline = config.timeline ? new TimelineRecorder({ dir: timelineDir }) : undefined;
if (timeline) hub.onSnapshot((snap) => timeline.ingest(snap));
// Responder pelo escritório (hook PermissionRequest): age sobre as sessões, então segue a mesma trava.
const permissions = config.terminal
  ? new PermissionRegistry({
      office,
      viewers: () => hub.localSize,
      transcriptPathOf: (id) => watcher.transcriptPathOf(id),
      demoDecide: (id, d) => office.decideDemoPermission(id, d),
      demoDetail: (id) => office.demoPermission(id),
    })
  : undefined;
late.permissions = permissions;

if (config.demo) office.setDemo(true);
watcher.start();
accounts.start();
hub.start();
if (timeline) {
  timeline.start();
  timeline.ingest(hub.current());
}
permissions?.start();
stats.start();
updates.start();
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
  terminal: config.terminal,
  terminals,
  sessions: history,
  timeline: createTimelineHandler({ dir: timelineDir, recording: !!timeline }),
  permissions: permissions ? createPermissionRoutes(permissions) : undefined,
  stats,
  updates,
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
  if (err.code === 'EADDRINUSE') log.error(`A porta ${config.port} já está em uso (defina HABBLAUD_PORT para usar outra).`);
  else log.error(`Erro no servidor HTTP: ${errMsg(err)}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  log.info(`🏢 Habblaud ${config.version}${config.dev ? ' (dev)' : ''}${config.inDocker ? ' (docker)' : ''} em http://${host}:${config.port}`);
  const list = accounts.entries();
  if (!list.length) log.warn('Nenhuma pasta do Claude Code encontrada (defina HABBLAUD_CLAUDE_DIRS).');
  for (const a of list) {
    const src = watcher.sources().find((s) => s.label === a.id);
    const usage = accounts.usageView(a.id).status;
    log.info(`   Conta ${a.detected.short} (${a.id}): ${src?.sessions ?? 0} sessão(ões) aberta(s) · uso: ${usage} · ${a.dir}`);
  }
  if (office.isDemo()) log.info('   Modo demonstração ligado (agentes simulados misturados aos reais).');
  if (config.terminal) log.info('   Terminal somente leitura: ligado (acesso só local).');
  else log.info(`   Terminal somente leitura: desligado (${terminalOffReason(process.env, config.host, config.inDocker)}).`);
  log.info(timeline ? `   Linha do tempo (timelapse): gravando em ${timelineDir}.` : '   Linha do tempo (timelapse): gravação desligada (HABBLAUD_TIMELINE).');
  log.info(`   Responder pelo escritório: ${config.terminal ? 'ligado (precisa do mod: npm run mod:install; ou do hook antigo: npm run hooks:install)' : 'desligado (mesma trava do terminal)'}.`);
  log.info(
    updates.enabled
      ? `   Versão nova: verificando as releases de github.com/${config.repo} a cada 6 h.`
      : `   Versão nova: verificação desligada (${config.repo ? 'HABBLAUD_UPDATE_CHECK' : 'package.json sem repositório no GitHub'}).`,
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Encerrando (${signal})…`);
  clearInterval(ticker);
  stats.stop();
  watcher.stop();
  accounts.stop();
  hub.stop();
  terminals?.stop();
  timeline?.stop();
  permissions?.stop();
  updates.stop();
  names.flush();
  void closeVite?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
