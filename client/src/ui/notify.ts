// Notificações (opt-in): Notification do navegador para alertas com a aba oculta, sons sintetizados
// e o contador no título da aba quando há agentes esperando você.
import type { Notice } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { computeCounters } from './model';

const BASE_TITLE = 'CodeTown';
const SOUND_GAP_MS = 1_200;

/** Sons curtos gerados com WebAudio (sem arquivos de áudio). */
class Chimes {
  private ac: AudioContext | null = null;
  private lastAt = 0;

  /** Precisa ser chamado a partir de um gesto do usuário para o navegador liberar o áudio. */
  unlock(): void {
    try {
      this.ac ??= new AudioContext();
      if (this.ac.state === 'suspended') void this.ac.resume();
    } catch {
      this.ac = null;
    }
  }

  play(kind: 'ding' | 'pop'): void {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    const now = performance.now();
    if (now - this.lastAt < SOUND_GAP_MS) return;
    this.lastAt = now;
    const t = ac.currentTime;
    const out = ac.createGain();
    out.gain.value = 0.9;
    out.connect(ac.destination);
    if (kind === 'ding') {
      // Sino suave: duas parciais com decaimento longo.
      for (const [freq, gain, delay] of [
        [880, 0.16, 0],
        [1318.5, 0.08, 0],
        [1174.7, 0.1, 0.14],
      ] as const) {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t + delay);
        g.gain.exponentialRampToValueAtTime(gain, t + delay + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + delay + 1.1);
        o.connect(g).connect(out);
        o.start(t + delay);
        o.stop(t + delay + 1.2);
      }
    } else {
      // "Pop": varredura curta para baixo.
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(740, t);
      o.frequency.exponentialRampToValueAtTime(330, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.14, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.2);
    }
  }
}

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationState(): NotificationState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export class Notifier implements UiComponent {
  private chimes = new Chimes();
  private lastTitle = '';

  constructor(private ctx: UiContext) {
    ctx.store.on('notice', (n) => this.onNotice(n));
    // O áudio só é liberado depois de um gesto do usuário.
    const unlock = () => {
      if (this.ctx.prefs.sound) this.chimes.unlock();
    };
    addEventListener('pointerdown', unlock, { passive: true });
    addEventListener('keydown', unlock);
  }

  /** Liga/desliga o som (chamado a partir do clique nas configurações). */
  setSound(on: boolean): void {
    if (on) {
      this.chimes.unlock();
      this.chimes.play('pop');
    }
  }

  /** Pede permissão de notificação ao ligar a opção. Devolve o estado final. */
  async enableBrowserNotifications(): Promise<NotificationState> {
    const state = notificationState();
    if (state === 'unsupported' || state === 'denied' || state === 'granted') return state;
    try {
      return await Notification.requestPermission();
    } catch {
      return notificationState();
    }
  }

  render(): void {
    const waiting = computeCounters(this.ctx.store.snapshot).waiting;
    const title = waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      document.title = title;
    }
  }

  private onNotice(n: Notice): void {
    const prefs = this.ctx.prefs;
    if (prefs.sound) {
      if (n.level === 'alert') this.chimes.play('ding');
      else if (n.level === 'success') this.chimes.play('pop');
    }
    if (n.level === 'alert' && prefs.browserNotifications && document.hidden && notificationState() === 'granted') {
      try {
        const notification = new Notification('CodeTown — precisa de você', {
          body: n.text,
          tag: n.agentId ?? n.id,
          icon: '/assets/brand/favicon-32.png',
        });
        notification.onclick = () => {
          window.focus();
          if (n.agentId && this.ctx.agent(n.agentId)) this.ctx.select({ type: 'agent', id: n.agentId }, { focus: true });
          notification.close();
        };
      } catch {
        // Alguns navegadores só permitem notificações via service worker; o toast continua aparecendo.
      }
    }
  }
}
