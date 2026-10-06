import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { L, tempDir } from '../test/fixtures';
import { FileTail } from './tail';
import {
  applyTaskOp,
  createTranscriptState,
  mergePrefix,
  parseLine,
  parseTaskNotification,
  scanPrefix,
  titleOf,
  type LineResult,
  type TranscriptState,
} from './transcript';

const T0 = Date.parse('2026-10-06T10:00:00Z');

function feed(state: TranscriptState, lines: string[]): LineResult[] {
  return lines.map((l) => parseLine(state, l, { idPrefix: 'acc:1', now: T0 }));
}

function acts(results: LineResult[]) {
  return results.flatMap((r) => r.activities);
}

describe('parseLine — atividades', () => {
  it('prompt, pensamento, ferramenta, resposta e fim de turno', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.prompt('Arruma o bug do carrinho', { at: T0 }),
      L.assistant([L.thinking()], { at: T0 + 1000, msgId: 'm1' }),
      L.assistant([L.tool('tu1', 'Read', { file_path: '/p/src/Cart.tsx' })], { at: T0 + 2000, msgId: 'm1' }),
      L.result('tu1', 'conteúdo', { at: T0 + 2500 }),
      L.assistant([L.text('Pronto, corrigi.')], { at: T0 + 3000, msgId: 'm2', stop: 'end_turn' }),
      L.system('turn_duration', { durationMs: 65_000 }, { at: T0 + 3100 }),
    ]);
    const a = acts(r);
    expect(a.map((x) => x.activity.kind)).toEqual(['prompt', 'think', 'read', 'respond', 'done']);
    expect(a[2].activity).toMatchObject({ text: 'Lendo Cart.tsx', tool: 'Read', at: T0 + 2000 });
    expect(a[4].activity).toMatchObject({ text: 'Concluiu em 1min 5s', durationMs: 65_000 });
    expect(a.every((x) => x.activity.id.startsWith('acc:1#'))).toBe(true);
    expect(new Set(a.map((x) => x.activity.id)).size).toBe(a.length);
    expect(s.ended).toBe(true);
    expect(s.stats.toolCalls).toBe(1);
  });

  it('ignora meta, comandos locais, lembretes e tipos desconhecidos', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.meta('Caveat: mensagens locais'),
      L.prompt('<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
      L.prompt('<local-command-stdout>ok</local-command-stdout>'),
      L.prompt('<system-reminder>x</system-reminder>'),
      L.raw('file-history-snapshot', { snapshot: {} }),
      L.raw('tipo-do-futuro', { x: 1 }),
      'isto não é json',
      '[]',
    ]);
    expect(acts(r)).toEqual([]);
  });

  it('comando de barra de trabalho vira prompt', () => {
    const s = createTranscriptState();
    const a = acts(feed(s, [L.prompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>')]));
    expect(a).toHaveLength(1);
    expect(a[0].activity.kind).toBe('prompt');
    expect(a[0].activity.detail).toBe('/review 123');
  });

  it('um único "Pensando…" por mensagem', () => {
    const s = createTranscriptState();
    const a = acts(
      feed(s, [
        L.assistant([L.thinking()], { at: T0, msgId: 'm1' }),
        L.assistant([L.thinking()], { at: T0 + 100, msgId: 'm1' }),
      ]),
    );
    expect(a).toHaveLength(1);
  });

  it('erro de ferramenta antiga vai para o histórico sem virar a atividade atual', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('a', 'Bash', { command: 'npm test' }), L.tool('b', 'Read', { file_path: '/x/y.ts' })], { at: T0 }),
      L.result('a', 'Exit code 1\nfalhou', { error: true, at: T0 + 10 }),
      L.result('b', 'Arquivo inexistente', { error: true, at: T0 + 20 }),
    ]);
    const a = acts(r);
    const errors = a.filter((x) => x.activity.kind === 'error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ current: false, activity: { text: 'Erro em Bash', detail: 'Exit code 1', error: true } });
    expect(errors[1].current).toBe(true);
  });

  it('interrupção e recusa', () => {
    const s = createTranscriptState();
    const a = acts(
      feed(s, [
        L.assistant([L.tool('a', 'Edit', { file_path: '/x/a.ts' })], { at: T0 }),
        L.result('a', "The user doesn't want to proceed with this tool use.", {
          error: true,
          extraText: '[Request interrupted by user for tool use]',
        }),
        L.assistant([L.tool('b', 'Write', { file_path: '/x/b.ts' })], { at: T0 + 10 }),
        L.result('b', "The user doesn't want to proceed with this tool use. The tool use was rejected", { error: true }),
      ]),
    );
    expect(a.map((x) => x.activity.text)).toEqual(['Editando a.ts', 'Interrompido por você', 'Escrevendo b.ts', 'Você recusou: Write']);
    expect(s.ended).toBe(false);
  });

  it('compactação, erro de API e resultado em segundo plano', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.system('compact_boundary', { compactMetadata: {} }),
      L.system('api_error', { retryAttempt: 1 }),
      L.system('api_error', { retryAttempt: 2 }),
      L.notification('toolu_bg', 'completed', 'Tudo certo'),
    ]);
    const a = acts(r);
    expect(a.map((x) => x.activity.kind)).toEqual(['compact', 'wait', 'other']);
    expect(a[2].activity.detail).toBe('Tudo certo');
    expect(r[3].signals).toEqual([{ type: 'notification', toolUseId: 'toolu_bg', taskId: 't1', status: 'completed', summary: 'Tudo certo' }]);
  });
});

describe('parseLine — títulos, tarefas e números', () => {
  it('título: custom-title > agent-name > ai-title > último prompt', () => {
    const s = createTranscriptState();
    feed(s, [L.prompt('Faz a página de checkout com resumo')]);
    expect(titleOf(s)).toBe('Faz a página de checkout com resumo');
    feed(s, [L.raw('ai-title', { aiTitle: 'Checkout' })]);
    expect(titleOf(s)).toBe('Checkout');
    feed(s, [L.raw('agent-name', { agentName: 'Agente X' })]);
    expect(titleOf(s)).toBe('Agente X');
    feed(s, [L.raw('custom-title', { customTitle: 'Loja' })]);
    expect(titleOf(s)).toBe('Loja');
  });

  it('TodoWrite substitui a lista; TaskCreate/TaskUpdate editam (id vindo do resultado)', () => {
    const s = createTranscriptState();
    feed(s, [
      L.assistant([
        L.tool('t1', 'TodoWrite', {
          todos: [
            { content: 'Ler código', status: 'completed', activeForm: 'Lendo código' },
            { content: 'Corrigir', status: 'in_progress', activeForm: 'Corrigindo' },
          ],
        }),
      ]),
    ]);
    expect(s.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      ['1', 'Ler código', 'completed'],
      ['2', 'Corrigir', 'in_progress'],
    ]);
    const s2 = createTranscriptState();
    feed(s2, [
      L.assistant([L.tool('c1', 'TaskCreate', { subject: 'Escrever testes', activeForm: 'Escrevendo testes' })]),
      L.result('c1', 'Task #7 created successfully', { toolUseResult: { task: { id: '7', subject: 'Escrever testes' } } }),
      L.assistant([L.tool('c2', 'TaskCreate', { subject: 'Revisar' })]),
      L.result('c2', 'Task #8 created successfully: Revisar'),
      L.assistant([L.tool('u1', 'TaskUpdate', { taskId: '7', status: 'in_progress' })]),
      L.assistant([L.tool('u2', 'TaskUpdate', { taskId: '8', status: 'deleted' })]),
    ]);
    expect(s2.tasks).toEqual([{ id: '7', title: 'Escrever testes', status: 'in_progress', activeForm: 'Escrevendo testes' }]);
  });

  it('tokens: linhas da mesma mensagem contam uma vez (com o uso final)', () => {
    const s = createTranscriptState();
    feed(s, [
      L.assistant([L.thinking()], { msgId: 'm1', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } }),
      L.assistant([L.tool('x', 'Bash', { command: 'ls' })], {
        msgId: 'm1',
        usage: { input_tokens: 2, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
      }),
      L.assistant([L.text('ok')], { msgId: 'm2', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    ]);
    expect(s.stats.tokensIn).toBe(1052 + 5);
    expect(s.stats.tokensOut).toBe(40 + 7);
    expect(s.stats.toolCalls).toBe(1);
  });

  it('cost-state mais recente vale; modelo, branch e modo de permissão', () => {
    const s = createTranscriptState();
    feed(s, [
      L.raw('cost-state', { totalCostUSD: 0.5, totalLinesAdded: 10, totalLinesRemoved: 2 }),
      L.raw('cost-state', { totalCostUSD: 1.23456, totalLinesAdded: 30, totalLinesRemoved: 4 }),
      L.raw('permission-mode', { permissionMode: 'auto' }),
      L.assistant([L.text('oi')], { model: 'claude-opus-teste', gitBranch: 'feat/x' }),
      L.assistant([L.text('oi')], { model: '<synthetic>', gitBranch: 'HEAD' }),
    ]);
    expect(s.stats).toMatchObject({ costUSD: 1.2346, linesAdded: 30, linesRemoved: 4 });
    expect(s.model).toBe('claude-opus-teste');
    expect(s.gitBranch).toBe('feat/x');
    expect(s.permissionMode).toBe('auto');
  });
});

describe('parseLine — sinais de subagentes', () => {
  it('Agent em primeiro plano: spawn e término', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_a', 'Agent', { description: 'Revisar código', subagent_type: 'Explore', prompt: '...' })]),
      L.result('toolu_a', 'resumo', { toolUseResult: { status: 'completed', agentId: 'abc123', totalTokens: 10 } }),
    ]);
    expect(r[0].signals).toEqual([
      { type: 'spawn', spawn: expect.objectContaining({ toolUseId: 'toolu_a', tool: 'Agent', description: 'Revisar código', subagentType: 'Explore', background: false }) },
    ]);
    expect(r[1].signals).toEqual([{ type: 'finished', toolUseId: 'toolu_a', agentId: 'abc123', error: false }]);
    expect(s.stats.subagents).toBe(1);
  });

  it('em segundo plano: lançado (não termina) e depois notificação', () => {
    const s = createTranscriptState();
    const r = feed(s, [
      L.assistant([L.tool('toolu_b', 'Agent', { description: 'Pesquisar', subagent_type: 'fork', run_in_background: 'true' })]),
      L.result('toolu_b', 'lançado', { toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'bg1' } }),
      L.assistant([L.tool('toolu_w', 'Workflow', { scriptPath: '/x.js' })]),
      L.result('toolu_w', 'ok', { toolUseResult: { status: 'async_launched', taskId: 'w1', runId: 'wf_1' } }),
      L.assistant([L.tool('toolu_s', 'TaskStop', { task_id: 'w1' })]),
      L.result('toolu_s', 'parado'),
    ]);
    expect(r[0].signals[0]).toMatchObject({ type: 'spawn', spawn: { background: true } });
    expect(r[1].signals).toEqual([{ type: 'launched', toolUseId: 'toolu_b', agentId: 'bg1' }]);
    expect(r[3].signals).toEqual([{ type: 'launched', toolUseId: 'toolu_w', runId: 'wf_1', taskId: 'w1' }]);
    expect(r[5].signals).toEqual([{ type: 'stopped', taskId: 'w1' }]);
  });

  it('notificação enfileirada (queue-operation) também sinaliza, sem atividade', () => {
    const s = createTranscriptState();
    const r = parseLine(
      s,
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><tool-use-id>toolu_q</tool-use-id><status>completed</status></task-notification>' }),
      { idPrefix: 'p', now: T0 },
    );
    expect(r.activities).toEqual([]);
    expect(r.signals).toEqual([{ type: 'notification', toolUseId: 'toolu_q', status: 'completed' }]);
  });

  it('parseTaskNotification', () => {
    expect(parseTaskNotification('<task-notification><task-id>x</task-id><status>killed</status></task-notification>')).toEqual({
      taskId: 'x',
      toolUseId: undefined,
      status: 'killed',
      summary: undefined,
    });
  });
});

describe('janela final + prefixo em segundo plano', () => {
  it('mescla títulos, tarefas e números sem contar duas vezes', async () => {
    const tmp = tempDir();
    try {
      const file = join(tmp.dir, 's.jsonl');
      const prefixLines = [
        L.raw('custom-title', { customTitle: 'Projeto antigo' }),
        L.assistant([L.tool('c1', 'TaskCreate', { subject: 'Primeira' })], { msgId: 'p1' }),
        L.result('c1', 'Task #1 created successfully'),
        L.raw('cost-state', { totalCostUSD: 2, totalLinesAdded: 5, totalLinesRemoved: 1 }),
        // Mensagem que atravessa a fronteira: primeira linha no prefixo...
        L.assistant([L.thinking()], { msgId: 'mx', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
      ];
      const tailLines = [
        // ...e a segunda (uso final) na janela.
        L.assistant([L.tool('t9', 'Bash', { command: 'ls' })], { msgId: 'mx', usage: { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        L.assistant([L.tool('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })], { msgId: 't2' }),
      ];
      const prefixText = prefixLines.map((l) => `${l}\n`).join('');
      writeFileSync(file, prefixText + tailLines.map((l) => `${l}\n`).join(''));
      const end = Buffer.byteLength(prefixText);

      const tail = new FileTail(file);
      tail.offset = end;
      const state = createTranscriptState({ trackPrefix: true });
      for (const line of tail.read().lines) parseLine(state, line, { idPrefix: 'a', now: T0 });
      expect(state.tasks).toEqual([]);
      const tailTokensOut = state.stats.tokensOut;

      const prefix = await scanPrefix(file, end, new Set(state.firstMsgIds));
      mergePrefix(state, prefix.state);
      expect(titleOf(state)).toBe('Projeto antigo');
      expect(state.tasks).toEqual([{ id: '1', title: 'Primeira', status: 'completed' }]);
      expect(state.stats.costUSD).toBe(2);
      expect(state.stats.toolCalls).toBe(3);
      // 'mx' foi contada só pela janela (uso final); 'p1' veio do prefixo.
      expect(state.stats.tokensOut).toBe(tailTokensOut + 5);
    } finally {
      tmp.cleanup();
    }
  });

  it('applyTaskOp ignora atualização de tarefa desconhecida', () => {
    expect(applyTaskOp([], { op: 'update', id: '9', status: 'completed' })).toEqual([]);
  });
});
