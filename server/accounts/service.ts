// Contas observadas + uso de cada uma: tap de statusline (recomendado) e cache do /usage
// gravado no .claude.json. Só arquivos locais: nada de credenciais nem chamadas de rede.
import { basename, resolve } from 'node:path';
import type { AccountInfo } from '../../shared/types';
import { log } from '../log';
import { detectAccounts, type DetectedAccount } from './detect';
import { StatuslineUsageReader, type StatuslineUsage } from './statusline';
import { usageFromCache, UsageStore, type UsageView } from './usage';

export interface AccountEntry {
  id: string;
  /** Config dir lido por este processo (no Docker, o caminho montado). */
  dir: string;
  detected: DetectedAccount;
}

export interface AccountsServiceOptions {
  dirs: string[];
  home: string;
  env: NodeJS.ProcessEnv;
  onChange: () => void;
  now?: () => number;
  /** Intervalo de releitura do .claude.json (cache de uso). */
  refreshMs?: number;
  /** Pasta com o uso capturado do statusline (scripts/statusline-tap.mjs). Sem ela, a fonte fica desligada. */
  usageDir?: string;
  /** Intervalo de releitura da pasta do statusline (padrão 5 s). */
  statuslineMs?: number;
}

export class AccountsService {
  readonly usage = new UsageStore();
  private list_: AccountEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private statuslineTimer: ReturnType<typeof setInterval> | null = null;
  private readonly statusline: StatuslineUsageReader | null;
  /** Assinatura do uso exibido (o status muda sozinho com o tempo: ok -> stale, janelas reiniciam). */
  private usageSig = '';
  private readonly now: () => number;

  constructor(private readonly opts: AccountsServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.statusline = opts.usageDir ? new StatuslineUsageReader(opts.usageDir) : null;
    this.refresh();
    this.refreshStatusline();
  }

  /** Relê metadados e o cache de uso (barato: dois ou três JSONs pequenos). */
  refresh(): void {
    let detected: DetectedAccount[];
    try {
      detected = detectAccounts(this.opts.dirs, { home: this.opts.home, env: this.opts.env });
    } catch (err) {
      log.warnOnce('detect-accounts', `Falha ao detectar contas: ${String(err).slice(0, 120)}`);
      return;
    }
    const next = this.opts.dirs.map((dir, i) => ({ id: detected[i].id, dir, detected: detected[i] }));
    let changed = JSON.stringify(next.map((e) => ({ ...e.detected, cachedUsage: undefined }))) !==
      JSON.stringify(this.list_.map((e) => ({ ...e.detected, cachedUsage: undefined })));
    this.list_ = next;
    for (const e of next) {
      const cache = usageFromCache(e.detected.cachedUsage);
      if (cache) changed = this.usage.set(e.id, cache) || changed;
      else changed = this.usage.clear(e.id, 'cache') || changed;
    }
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
  }

  /**
   * Relê os arquivos do tap de statusline e aplica a cada conta o mais recente que casar
   * (pelo config dir; senão pelo id/basename). Conta sem arquivo perde a fonte 'statusline'.
   */
  refreshStatusline(): void {
    if (!this.statusline) return;
    let files: StatuslineUsage[];
    try {
      files = this.statusline.read(this.now());
    } catch (err) {
      log.warnOnce('statusline-read', `Falha ao ler o uso do statusline: ${String(err).slice(0, 120)}`);
      return;
    }
    let changed = false;
    for (const e of this.list_) {
      const mine = files.filter((f) => this.fileMatches(e, f));
      const best = mine.reduce<StatuslineUsage | undefined>((acc, f) => (!acc || f.usage.fetchedAt > acc.usage.fetchedAt ? f : acc), undefined);
      if (best) changed = this.usage.set(e.id, best.usage) || changed;
      else changed = this.usage.clear(e.id, 'statusline') || changed;
    }
    if (this.usageViewChanged()) changed = true;
    if (changed) this.opts.onChange();
  }

  private fileMatches(e: AccountEntry, f: StatuslineUsage): boolean {
    if (f.configDir) {
      const dir = resolve(f.configDir);
      if (dir === resolve(e.detected.configDir) || dir === resolve(e.dir)) return true;
      // Mesmo nome de pasta mas caminho diferente: só vale se nenhuma outra conta tiver esse caminho.
      if (this.list_.some((o) => resolve(o.detected.configDir) === dir || resolve(o.dir) === dir)) return false;
      return basename(dir) === e.id;
    }
    return !!f.accountId && f.accountId === e.id;
  }

  /** O uso exibido mudou (inclusive sozinho, com o tempo: ok -> stale, janelas reiniciam)? */
  private usageViewChanged(): boolean {
    const now = this.now();
    const sig = JSON.stringify(this.list_.map((e) => this.usage.view(e.id, now)));
    if (sig === this.usageSig) return false;
    this.usageSig = sig;
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh(), this.opts.refreshMs ?? 60_000);
    this.timer.unref?.();
    if (this.statusline) {
      this.statuslineTimer = setInterval(() => this.refreshStatusline(), this.opts.statuslineMs ?? 5_000);
      this.statuslineTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.statuslineTimer) clearInterval(this.statuslineTimer);
    this.timer = null;
    this.statuslineTimer = null;
  }

  entries(): readonly AccountEntry[] {
    return this.list_;
  }

  idForDir(dir: string): string | undefined {
    const abs = resolve(dir);
    return this.list_.find((e) => resolve(e.dir) === abs)?.id;
  }

  find(id: string): AccountEntry | undefined {
    return this.list_.find((e) => e.id === id);
  }

  usageView(id: string): UsageView {
    return this.usage.view(id, this.now());
  }

  /** Contas no formato do protocolo; `sessions` = sessões abertas por conta. */
  list(sessions: ReadonlyMap<string, number>): AccountInfo[] {
    const now = this.now();
    return this.list_.map((e) => {
      const d = e.detected;
      const view = this.usage.view(e.id, now);
      const info: AccountInfo = {
        id: e.id,
        short: d.short,
        name: d.name,
        color: d.color,
        configDir: d.configDir,
        sessions: sessions.get(e.id) ?? 0,
        usageStatus: view.status,
      };
      if (d.email) info.email = d.email;
      if (d.organization) info.organization = d.organization;
      if (d.plan) info.plan = d.plan;
      if (view.usage) info.usage = view.usage;
      return info;
    });
  }
}
