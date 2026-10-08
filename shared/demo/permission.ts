// Pedidos de permissão fictícios do modo demonstração (responder pelo escritório sem sessões reais).
// Puro: usado pelo simulador no servidor (HABBLAUD_DEMO=1) e no navegador (?mock=1).
import type { PermissionRequestInfo } from '../types';
import { describeTool } from '../activity';

export interface DemoPermissionSource {
  /** Arquivos do projeto fictício (relativos à raiz). */
  files: readonly string[];
  /** Comandos de terminal do projeto fictício. */
  commands: readonly string[];
}

/** Quanto tempo o "hook" fictício espera antes de devolver o pedido ao terminal. */
export const DEMO_PERMISSION_MS = 5 * 60_000;

/** Linhas de um diff fictício, no formato do terminal somente leitura ("- antiga" / "+ nova"). */
const DEMO_DIFFS: readonly string[][] = [
  ['- const total = items.reduce((s, i) => s + i.price, 0);', '+ const total = items.reduce((s, i) => s + i.price * i.qty, 0);', '+ if (total < 0) throw new Error("total inválido");'],
  ['- export const TIMEOUT = 5_000;', '+ export const TIMEOUT = 15_000;'],
  ['- <button onClick={save}>Salvar</button>', '+ <button onClick={save} disabled={saving}>', '+   {saving ? "Salvando…" : "Salvar"}', '+ </button>'],
];

/**
 * Um pedido fictício (comando no terminal, edição de arquivo ou leitura de página), com a sugestão de
 * "sempre permitir" que o Claude Code costuma oferecer para comandos.
 */
export function demoPermission(id: string, src: DemoPermissionSource, rng: () => number, now: number): PermissionRequestInfo {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  const roll = rng();
  const base = { id, createdAt: now, expiresAt: now + DEMO_PERMISSION_MS };
  if (roll < 0.55 && src.commands.length) {
    const command = pick(src.commands);
    const d = describeTool('Bash', { command });
    const prefix = command.split(/\s+/).slice(0, 2).join(' ');
    return {
      ...base,
      tool: 'Bash',
      title: `Bash(${command})`,
      text: d.text,
      icon: d.icon,
      input: command,
      inputKind: 'command',
      suggestions: [{ index: 0, rules: [`Bash(${prefix}:*)`], destination: 'localSettings' }],
    };
  }
  if (roll < 0.9 && src.files.length) {
    const file = pick(src.files);
    const d = describeTool('Edit', { file_path: file });
    return { ...base, tool: 'Edit', title: `Edit(${file})`, text: d.text, icon: d.icon, input: pick(DEMO_DIFFS).join('\n'), inputKind: 'diff' };
  }
  const url = 'https://developer.mozilla.org/pt-BR/docs/Web/API/Fetch_API';
  const d = describeTool('WebFetch', { url });
  return {
    ...base,
    tool: 'WebFetch',
    title: `WebFetch(${url})`,
    text: d.text,
    icon: d.icon,
    input: 'Resuma como tratar erros de rede com fetch',
    inputKind: 'text',
    suggestions: [{ index: 0, rules: ['WebFetch(domain:developer.mozilla.org)'], destination: 'localSettings' }],
  };
}
