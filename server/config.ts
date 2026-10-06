// Configuração do servidor a partir das variáveis de ambiente (documentadas em server/README.md).
import { existsSync, readFileSync } from 'node:fs';
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  const home = env.HOME || homedir();
  const inDocker = detectDocker(env);
  const port = Number.parseInt(env.CODETOWN_PORT ?? '', 10);
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 4747,
    host: env.CODETOWN_HOST?.trim() || '127.0.0.1',
    dev: argv.includes('--dev'),
    demo: isTruthy(env.CODETOWN_DEMO),
    inDocker,
    home,
    claudeDirs: discoverClaudeDirs(env, home),
    dataDir: resolve(env.CODETOWN_DATA_DIR?.trim() || (inDocker ? '/data' : join(home, '.codetown'))),
    usageDir: resolve(env.CODETOWN_USAGE_DIR?.trim() || join(home, '.codetown', 'usage')),
    allowedHosts: parseAllowedHosts(env.CODETOWN_ALLOWED_HOSTS),
    rootDir,
    version: readVersion(rootDir),
  };
}
