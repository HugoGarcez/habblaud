import { describe, expect, it } from 'vitest';
import type { AgentInfo, PermissionRequestInfo } from '../../../shared/types';
import { destinationLabel, expiryText, isLocalHostname, nextPermissionAgent, permissionAgents } from './permission';

function agent(id: string, permission?: Partial<PermissionRequestInfo>, status: AgentInfo['status'] = 'waiting'): AgentInfo {
  const a: AgentInfo = {
    id,
    kind: 'main',
    roomId: 'r',
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: 'acc',
    status,
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
  };
  if (permission) a.permission = { id: `p-${id}`, tool: 'Bash', title: 'Bash(ls)', text: 'Listando', icon: '💻', createdAt: 0, expiresAt: 1, ...permission };
  return a;
}

describe('responder pelo escritório (peças puras)', () => {
  it('expiryText: quanto falta para o pedido voltar ao terminal', () => {
    expect(expiryText(10 * 60_000, 0)).toBe('volta ao terminal em 10 min');
    expect(expiryText(30_000, 0)).toBe('volta ao terminal em menos de 1 min');
    expect(expiryText(0, 5)).toBe('voltando ao terminal…');
  });

  it('destinationLabel', () => {
    expect(destinationLabel('localSettings')).toBe('neste projeto, só para você');
    expect(destinationLabel('userSettings')).toBe('em todos os projetos');
    expect(destinationLabel('session')).toBe('só nesta sessão');
    expect(destinationLabel('outro')).toBe('outro');
  });

  it('fila de pedidos: do mais antigo para o mais recente, passando por todos e voltando ao primeiro', () => {
    const list = [agent('b', { createdAt: 20 }), agent('x'), agent('a', { createdAt: 10 }), agent('gone', { createdAt: 5 }, 'offline')];
    delete list[1].permission;
    expect(permissionAgents(list).map((a) => a.id)).toEqual(['a', 'b']);
    expect(nextPermissionAgent(list)?.id).toBe('a');
    expect(nextPermissionAgent(list, 'a')?.id).toBe('b');
    expect(nextPermissionAgent(list, 'b')?.id).toBe('a');
    expect(nextPermissionAgent(list, 'x')?.id).toBe('a');
    expect(nextPermissionAgent([agent('y')])).toBeUndefined();
  });

  it('isLocalHostname: a mesma regra do servidor para aceitar respostas', () => {
    for (const h of ['localhost', 'habblaud.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', 'LOCALHOST']) expect(isLocalHostname(h), h).toBe(true);
    for (const h of ['192.168.0.10', 'meu-mac.local', 'habblaud.lan', '128.0.0.1', '127.0.0.1.nip.io']) expect(isLocalHostname(h), h).toBe(false);
  });
});
