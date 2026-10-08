import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { createApiHandler } from './app';
import { createRequestGuard, hostAllowed, hostnameOf, isLoopbackHost, originAllowed, parseAllowedHosts } from './guard';
import { Hub } from './sse';
import { createStaticHandler, IMMUTABLE, REVALIDATE } from './static';

setQuiet(true);

interface Env {
  base: string;
  office: Office;
  close: () => Promise<void>;
}

async function start(): Promise<Env & { cleanup: () => void }> {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const dist = join(tmp.dir, 'dist');
  mkdirSync(join(dist, 'assets', 'brand'), { recursive: true });
  mkdirSync(join(dist, 'bundle'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>CodeTown</title>');
  writeFileSync(join(dist, 'bundle', 'main-abc12345.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'brand', 'logo-mark.png'), 'png');
  writeFileSync(join(dist, 'assets', 'manifest.json'), '{}');
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
  });
  late.office = office;
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false });
  const serveStatic = createStaticHandler(dist);
  const guard = createRequestGuard({ allowedHosts: new Set(['codetown.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) serveStatic(req, res, url.pathname);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  office.addMain({ id: '.claude:1', account: '.claude', sessionId: 's1', cwd: '/p/loja', role: 'Agente principal', startedAt: Date.now(), status: 'working' });
  return {
    base: `http://127.0.0.1:${port}`,
    office,
    close: () =>
      new Promise((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
    cleanup: tmp.cleanup,
  };
}

async function snapshotOf(base: string): Promise<OfficeSnapshot> {
  return (await (await fetch(`${base}/api/snapshot`)).json()) as OfficeSnapshot;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Requisição crua (o fetch não deixa trocar o cabeçalho Host). */
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end(opts.body);
  });
}

describe('API HTTP', () => {
  let env: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    env = await start();
  });
  afterEach(async () => {
    await env.close();
    env.cleanup();
  });

  it('GET /api/snapshot', async () => {
    const res = await fetch(`${env.base}/api/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const snap = (await res.json()) as OfficeSnapshot;
    expect(snap.rev).toBeGreaterThan(0);
    expect(snap.agents.map((a) => a.id)).toEqual(['.claude:1']);
    expect(snap.accounts[0]).toMatchObject({ id: '.claude', sessions: 1 });
    expect(snap.meta.version).toBe('9.9.9');
  });

  it('GET /api/stream envia retry, snapshot e feed; depois as mudanças', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${env.base}/api/stream`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (re: RegExp) => {
      while (!re.test(text)) text += dec.decode((await reader.read()).value, { stream: true });
    };
    await readUntil(/event: feed\n/);
    expect(text).toMatch(/^retry: 2000\n\nevent: snapshot\ndata: \{/);
    env.office.addActivity('.claude:1', { id: 'act-x', at: Date.now(), kind: 'read', icon: '📖', text: 'Lendo a.ts' }, true);
    await readUntil(/"id":"act-x"/);
    expect(text).toContain('event: feed\ndata: [{"id":"act-x"');
    ctrl.abort();
  });

  it('GET /api/agents/:id e /api/health', async () => {
    const ok = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ agent: { id: '.claude:1' }, history: [] });
    expect((await fetch(`${env.base}/api/agents/nao-existe`)).status).toBe(404);
    const health = await (await fetch(`${env.base}/api/health`)).json();
    expect(health).toMatchObject({ ok: true, version: '9.9.9', demo: false, docker: false, terminal: false, accounts: [{ id: '.claude', usageStatus: 'disabled' }] });
  });

  it('terminal somente leitura desligado: 403 JSON e meta.terminal false', async () => {
    const res = await fetch(`${env.base}/api/agents/${encodeURIComponent('.claude:1')}/terminal`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/desligado/);
    expect((await snapshotOf(env.base)).meta.terminal).toBe(false);
  });

  it('POST /api/demo liga e desliga', async () => {
    const on = await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) });
    expect(await on.json()).toEqual({ ok: true, demo: true });
    expect((await snapshotOf(env.base)).meta.demo).toBe(true);
    expect((await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":1}' })).status).toBe(400);
    expect((await fetch(`${env.base}/api/demo`, { method: 'POST', headers: JSON_HEADERS, body: '{' })).status).toBe(400);
    expect((await fetch(`${env.base}/api/demo`)).status).toBe(405);
  });

  it('DNS rebinding: Host de outro domínio é recusado em qualquer rota', async () => {
    const port = new URL(env.base).port;
    for (const path of ['/api/snapshot', '/api/stream', '/', '/bundle/main-abc12345.js']) {
      const r = await raw(env.base, path, { headers: { Host: `attacker.example:${port}` } });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('"agents"');
    }
    expect((await raw(env.base, '/api/health', { headers: { Host: `localhost:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `[::1]:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `192.168.0.10:${port}` } })).status).toBe(200);
    expect((await raw(env.base, '/api/health', { headers: { Host: `codetown.lan:${port}` } })).status).toBe(200);
  });

  it('CSRF: POST exige JSON e origem local', async () => {
    const demoOn = JSON.stringify({ enabled: true });
    // Formulário/fetch "simples" de outro site: text/plain, sem preflight.
    const plain = await fetch(`${env.base}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: demoOn });
    expect(plain.status).toBe(415);
    const form = await raw(env.base, '/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'enabled=true' });
    expect(form.status).toBe(415);
    const cross = await raw(env.base, '/api/demo', { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://attacker.example' }, body: demoOn });
    expect(cross.status).toBe(403);
    expect((await snapshotOf(env.base)).meta.demo).toBe(false);
    const port = new URL(env.base).port;
    const same = await raw(env.base, '/api/demo', { method: 'POST', headers: { ...JSON_HEADERS, Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, body: demoOn });
    expect(same.status).toBe(200);
  });

  it('respostas JSON com nosniff e CORP same-origin; sem CORS', async () => {
    const res = await fetch(`${env.base}/api/snapshot`, { headers: { Origin: 'http://attacker.example' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rotas desconhecidas: 404 JSON (inclusive o antigo POST /api/usage, que não existe mais)', async () => {
    const res = await fetch(`${env.base}/api/nada`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'rota desconhecida' });
    const usage = await fetch(`${env.base}/api/usage`, { method: 'POST', headers: JSON_HEADERS, body: '{"accounts":[]}' });
    expect(usage.status).toBe(404);
  });

  it('estáticos: SPA fallback, immutable só no /bundle (hash) e revalidação no resto', async () => {
    const page = await fetch(`${env.base}/sala/qualquer`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>CodeTown</title>');
    expect(page.headers.get('cache-control')).toBe(REVALIDATE);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    const bundle = await fetch(`${env.base}/bundle/main-abc12345.js`);
    expect(bundle.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(bundle.headers.get('content-type')).toMatch(/javascript/);
    // client/public: nome fixo, pode mudar a cada build.
    for (const path of ['/assets/brand/logo-mark.png', '/assets/manifest.json']) {
      const res = await fetch(`${env.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(REVALIDATE);
      const etag = res.headers.get('etag')!;
      expect(etag).toMatch(/^W\/"/);
      expect(res.headers.get('last-modified')).toBeTruthy();
      const again = await fetch(`${env.base}${path}`, { headers: { 'If-None-Match': etag } });
      expect(again.status).toBe(304);
      const since = await fetch(`${env.base}${path}`, { headers: { 'If-Modified-Since': res.headers.get('last-modified')! } });
      expect(since.status).toBe(304);
      const stale = await fetch(`${env.base}${path}`, { headers: { 'If-None-Match': 'W/"outro"' } });
      expect(stale.status).toBe(200);
    }
    expect((await fetch(`${env.base}/assets/nao-existe.js`)).status).toBe(404);
    expect((await fetch(`${env.base}/bundle/nao-existe.js`)).status).toBe(404);
    // Tentativa de sair da pasta cai no index.html, nunca em arquivos de fora.
    const escape = await fetch(`${env.base}/..%2F..%2Fetc%2Fpasswd`);
    expect(await escape.text()).toContain('<title>CodeTown</title>');
  });
});

describe('guarda de Host/Origin', () => {
  const allowed = parseAllowedHosts(' Meu-Mac.local:4747 , codetown.lan ');

  it('hostnameOf e CODETOWN_ALLOWED_HOSTS', () => {
    expect([...allowed]).toEqual(['meu-mac.local', 'codetown.lan']);
    expect(hostnameOf('LocalHost:4747')).toBe('localhost');
    expect(hostnameOf('[::1]:4747')).toBe('::1');
    expect(hostnameOf('a b')).toBeUndefined();
    expect(hostnameOf('[::1]lixo')).toBeUndefined();
  });

  it('Host: IPs, localhost e liberados sim; domínios de fora não', () => {
    expect(hostAllowed(undefined, allowed)).toBe(true);
    for (const h of ['localhost:4747', 'app.localhost', '127.0.0.1:4747', '[::1]:1', '10.0.0.5:4747', 'meu-mac.local:4747']) expect(hostAllowed(h, allowed)).toBe(true);
    for (const h of ['attacker.example:4747', 'localhost.attacker.example', '127.0.0.1.nip.io', '', 'x y']) expect(hostAllowed(h, allowed)).toBe(false);
  });

  it('isLoopbackHost: só localhost, *.localhost, 127.x e ::1 (terminal somente leitura)', () => {
    for (const h of ['localhost:4747', 'LOCALHOST', 'app.localhost:1', '127.0.0.1:4747', '127.8.9.10', '[::1]:4747']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of [undefined, '', '10.0.0.5:4747', '192.168.0.10', '0.0.0.0:4747', 'codetown.lan', 'meu-mac.local:4747', '[::]:4747', 'localhost.attacker.example', '127.0.0.1.nip.io', 'x y']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('Origin: ausente, mesma origem ou local', () => {
    expect(originAllowed(undefined, 'localhost:4747', allowed)).toBe(true);
    expect(originAllowed('http://localhost:4747', 'localhost:4747', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', '127.0.0.1:4747', allowed)).toBe(true); // Vite dev com proxy
    expect(originAllowed('http://192.168.0.10:4747', '192.168.0.10:4747', allowed)).toBe(true);
    expect(originAllowed('http://attacker.example', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('http://1.2.3.4', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('null', 'localhost:4747', allowed)).toBe(false);
    expect(originAllowed('file://', 'localhost:4747', allowed)).toBe(false);
  });
});
