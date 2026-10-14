// Chamadas às CLIs que o quadro usa (orca e gh): sem shell (execFile), com prazo e o stdout em JSON. Uma função
// `Exec` só, para os testes trocarem por uma falsa.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type Exec = (bin: string, args: string[], opts?: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;

export class CliError extends Error {
  constructor(
    message: string,
    /** Código de erro da CLI (o `error.code` do Orca), quando há. */
    readonly code?: string,
  ) {
    super(message);
  }
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/** A primeira linha não vazia do stderr (ou da mensagem), cortada: vai para a página. */
function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 300);
}

export const execCli: Exec = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, cwd: opts.cwd, env: opts.env }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // O Orca responde erros em JSON no stdout, mesmo saindo com código != 0.
      if (stdout.trim().startsWith('{')) return resolve(stdout);
      reject(new CliError(firstLine(String(stderr)) || firstLine(String(stdout)) || firstLine(err.message)));
    });
    // Nada a mandar pela entrada (o `claude -p` espera alguns segundos por ela se ficar aberta).
    child.stdin?.end();
  });

/** Roda de novo uma vez depois de `delayMs` se falhar (a CLI do Orca às vezes falha quando chamada junto com outra). */
export async function retryOnce<T>(fn: () => Promise<T>, delayMs = 400): Promise<T> {
  try {
    return await fn();
  } catch {
    await new Promise((r) => setTimeout(r, delayMs));
    return fn();
  }
}

/** Resultado de `orca … --json`: `{ok, result}` ou `{ok: false, error: {code, message}}`. */
export function orcaResult<T>(stdout: string): T {
  let d: { ok?: boolean; result?: T; error?: { code?: string; message?: string } };
  try {
    d = JSON.parse(stdout);
  } catch {
    throw new CliError('resposta do Orca ilegível');
  }
  if (!d.ok) throw new CliError(d.error?.message?.slice(0, 300) || 'o Orca recusou o pedido', d.error?.code);
  return d.result as T;
}

/** Acha um executável no PATH (ou nos lugares comuns do Homebrew). */
export function findBin(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}
