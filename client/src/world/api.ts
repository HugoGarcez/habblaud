// CONTRATO do mundo (canvas do escritório) consumido pela UI (client/src/ui/**).
// Implementação: client/src/world/index.ts -> createWorld().
// Regra: mudanças aqui devem ser ADITIVAS.

export type Selection = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface WorldOptions {
  /** Mostrar etiquetas com os nomes dos personagens. */
  showNames: boolean;
  /** Balões de atividade: todos, só importantes (precisa de você, selecionado, mudanças recentes) ou nenhum. */
  bubbles: 'all' | 'important' | 'none';
  /** Frequência de passeios pelo escritório quando os agentes estão ociosos. */
  liveliness: 'calm' | 'normal' | 'lively';
  /** Câmera acompanha o agente selecionado. */
  followSelected: boolean;
  /** Ciclo dia/noite pela hora local (janelas, iluminação). */
  dayNight: boolean;
}

export interface WorldApi {
  /** Seleciona (ou limpa) um agente/sala. `focus` move a câmera até ele. */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  getSelection(): Selection;
  /** Disparado quando a seleção muda (por clique no canvas ou por select()). */
  onSelect(cb: (sel: Selection) => void): () => void;
  /** Agente sob o cursor (para tooltips da UI). */
  onHover(cb: (agentId: string | null) => void): () => void;
  focusAgent(id: string, opts?: { follow?: boolean }): void;
  focusRoom(id: string): void;
  /** Enquadra o prédio inteiro. */
  overview(): void;
  zoomBy(factor: number): void;
  getOptions(): WorldOptions;
  setOptions(o: Partial<WorldOptions>): void;
  /** Posição na tela (CSS px, relativo à viewport) logo acima da cabeça do personagem, ou null se não visível. */
  screenPositionOf(agentId: string): { x: number; y: number } | null;
  /**
   * (Opcional, aditivo) Área da tela coberta por painéis da UI, em px CSS. O mundo passa a enquadrar
   * (visão geral) e centralizar (focusAgent/focusRoom/seguir) dentro da área livre.
   */
  setViewInsets?(insets: Partial<ViewInsets>): void;
  /**
   * (Opcional, aditivo) Vida social de um agente presente no escritório: personalidade, carteira de
   * moedinhas, amizades/rivalidades com quem está lá agora e a roda de que participa. null se não está.
   */
  social?(agentId: string): AgentSocial | null;
  /** (Opcional, aditivo) Acontecimentos sociais (partidas e apostas) para o feed. */
  onSocialEvent?(cb: (e: SocialEvent) => void): () => void;
  destroy(): void;
}

export interface AgentSocial {
  traits: { emoji: string; label: string; desc: string }[];
  /** Bordão ("Tá pago!"). */
  catchphrase: string;
  /** Saldo de moedinhas (🪙). */
  coins: number;
  /** Quanto já ganhou trabalhando (saldo inicial + tarefas + pedidos + entregas). */
  earned: number;
  wins: number;
  losses: number;
  /** Colegas presentes com quem tem amizade ou rivalidade; `record` = [vitórias, derrotas] contra ele. */
  bonds: { id: string; name: string; kind: 'amizade' | 'rivalidade'; record: [number, number] | null }[];
  /** O que está fazendo numa roda agora ("📺 Vendo futebol na TV com Rafaela"), ou null. */
  doing: string | null;
  /** Extrato: movimentações mais recentes primeiro. */
  ledger: { at: number; delta: number; icon: string; text: string }[];
}

/** Partida/aposta resolvida (vira uma linha do feed). */
export interface SocialEvent {
  id: string;
  at: number;
  icon: string;
  /** Protagonista (quem venceu). */
  agentId: string;
  /** Texto sem o nome do protagonista: "ganhou 🪙10 de Caio no jokenpô". */
  text: string;
  /** Onde aconteceu ("Lounge", "Copa"...). */
  place: string;
}

/** Margens da viewport cobertas pela UI (px CSS). */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = {
  showNames: true,
  bubbles: 'important',
  liveliness: 'normal',
  followSelected: false,
  dayNight: true,
};
