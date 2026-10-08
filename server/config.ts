// Configuração do servidor a partir das variáveis de ambiente (documentadas em server/README.md).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeDirs } from './accounts/detect';
import { parseAllowedHosts } from './http/guard';

export interface ServerConfig {
  port: number;
  host: string;
  /** `--dev`: Vite em middleware mode (HMR) no mesmo servidor. */
  dev: boolean;
  /** Liga o simulador de demonstração ao iniciar. */
  demo: boolean;
  /** Rodando dentro de um container (PIDs do registro são do host: não dá para checá-los). */
  inDocker: boolean;
  home: string;
  /** Config dirs do Claude Code observados (um por conta). */
  claudeDirs: string[];
  /** Onde o CodeTown guarda o próprio estado (nomes persistidos). */
  dataDir: string;
  /**
   * Pasta com o uso capturado pelo statusline do Claude Code (scripts/statusline-tap.mjs):
   * CODETOWN_USAGE_DIR ou ~/.codetown/usage. No Docker, o docker-up monta essa pasta em /usage.
   */
  usageDir: string;
  /** Nomes extras aceitos no cabeçalho Host/Origin (CODETOWN_ALLOWED_HOSTS); localhost e IPs sempre valem. */
  allowedHosts: Set<string>;
  /**
   * Terminal somente leitura (GET /api/agents/:id/terminal) ligado: só com bind local, isto é, com o
   * CodeTown acessível apenas pelo próprio computador (ver terminalOffReason).
   */
  terminal: boolean;
  /** Grava a linha do tempo do escritório para o timelapse (<dataDir>/timeline); CODETOWN_TIMELINE=0 desliga. */
  timeline: boolean;
  /** Raiz do projeto (onde fica o package.json); serve dist/client a partir daqui. */
  rootDir: string;
  version: string;
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

/** Sobe a partir de `from` até achar o package.json do projeto. */
export function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (name === 'codetown') return dir;
      } catch {
        // package.json ilegível: continua subindo
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '..');
}

function readVersion(rootDir: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function detectDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CODETOWN_IN_DOCKER !== undefined) return isTruthy(env.CODETOWN_IN_DOCKER);
  return existsSync('/.dockerenv');
}

/**
 * Endereço de escuta que só o próprio computador alcança: 127.0.0.0/8, `::1` (com ou sem colchetes)
 * ou `localhost`. `0.0.0.0`, `::`, IPs de rede e nomes quaisquer não contam.
 */
export function isLoopbackBind(value: string | undefined): boolean {
  let v = value?.trim().toLowerCase() ?? '';
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === 'localhost') return true;
  const family = isIP(v);
  if (family === 4) return v.startsWith('127.');
  if (family !== 6) return false;
  try {
    // Forma canônica (0:0:0:0:0:0:0:1 -> [::1]).
    return new URL(`http://[${v}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Por que o terminal somente leitura fica desligado (undefined = ligado). Os transcripts têm a conversa
 * inteira, então ele só liga quando o CodeTown não fica exposto além do próprio computador:
 * - Node: o CODETOWN_HOST precisa ser loopback;
 * - Docker: o processo sempre escuta em 0.0.0.0 dentro do container e quem decide a exposição é a porta
 *   publicada no host, CODETOWN_BIND (o docker-compose.yml repassa o mesmo valor ao container). Ausente
 *   ou vazia = desligado: sem ela não dá para saber se a porta está exposta.
 * CODETOWN_TERMINAL com qualquer valor que não seja "ligado" (0, false, off...) desliga; não existe forma
 * de ligar com a porta exposta.
 */
export function terminalOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.CODETOWN_TERMINAL?.trim();
  if (flag && !isTruthy(flag)) return `CODETOWN_TERMINAL=${flag}`;
  if (inDocker) {
    const bind = env.CODETOWN_BIND?.trim();
    if (!bind) return 'CODETOWN_BIND não chegou ao container, então a porta pode estar exposta na rede';
    return isLoopbackBind(bind) ? undefined : `a porta está exposta na rede: CODETOWN_BIND=${bind}`;
  }
  return isLoopbackBind(host) ? undefined : `a porta está exposta na rede: CODETOWN_HOST=${host}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  const home = env.HOME || homedir();
  const inDocker = detectDocker(env);
  const port = Number.parseInt(env.CODETOWN_PORT ?? '', 10);
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  const host = env.CODETOWN_HOST?.trim() || '127.0.0.1';
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 4747,
    host,
    dev: argv.includes('--dev'),
    demo: isTruthy(env.CODETOWN_DEMO),
    inDocker,
    home,
    claudeDirs: discoverClaudeDirs(env, home),
    dataDir: resolve(env.CODETOWN_DATA_DIR?.trim() || (inDocker ? '/data' : join(home, '.codetown'))),
    usageDir: resolve(env.CODETOWN_USAGE_DIR?.trim() || join(home, '.codetown', 'usage')),
    allowedHosts: parseAllowedHosts(env.CODETOWN_ALLOWED_HOSTS),
    terminal: terminalOffReason(env, host, inDocker) === undefined,
    timeline: !env.CODETOWN_TIMELINE?.trim() || isTruthy(env.CODETOWN_TIMELINE),
    rootDir,
    version: readVersion(rootDir),
  };
}
