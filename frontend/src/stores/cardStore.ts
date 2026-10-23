import { create } from "zustand";
import type { CardMode, Session, SessionCard } from "../types/ipc";
import {
  createCard,
  listCards,
  setCardMode,
  closeCard as apiCloseCard,
  connectSession,
  openSerial,
} from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

interface CardState {
  cards: SessionCard[];
  activeCardId: string | null;
  loading: boolean;
  error: string | null;

  loadCards: () => Promise<void>;
  setActiveCard: (cardId: string) => void;
  openCardForSession: (session: Session) => Promise<SessionCard>;
  switchMode: (cardId: string, mode: CardMode) => Promise<void>;
  toggleMode: (cardId: string) => Promise<void>;
  closeCard: (cardId: string) => Promise<void>;
  updateCardState: (cardId: string, patch: Partial<SessionCard>) => void;
}

export const useCardStore = create<CardState>((set, get) => ({
  cards: [],
  activeCardId: null,
  loading: false,
  error: null,

  loadCards: async () => {
    try {
      const cards = await listCards();
      set({ cards });
      if (cards.length > 0 && !get().activeCardId) {
        set({ activeCardId: cards[0].card_id });
      }
    } catch (e: any) {
      set({ error: formatFriendlyError(e) });
    }
  },

  setActiveCard: (activeCardId) => set({ activeCardId }),

  openCardForSession: async (session: Session) => {
    set({ loading: true, error: null });
    try {
      // 1. 创建后端视图卡
      const card = await createCard(session.id);
      
      // 更新前端状态
      set((s) => ({
        cards: [...s.cards.filter((c) => c.card_id !== card.card_id), card],
        activeCardId: card.card_id,
        loading: false,
      }));

      // 2. 根据协议建立物理连接
      if (session.protocol === "serial") {
        const serialOpts = session.protocol_options_json || {
          port_name: "COM1",
          baud_rate: 115200,
        };
        await openSerial(card.card_id, serialOpts, false).catch(async () => {
          // 若物理硬件不存在，降级为 Mock 模式保证不崩溃
          await openSerial(card.card_id, serialOpts, true);
        });
        get().updateCardState(card.card_id, { state: "connected" });
      } else {
        // SSH 协议连接
        try {
          const reqId = "req_" + Math.random().toString(36).substring(2);
          const res = await connectSession(reqId, session.id);
          get().updateCardState(card.card_id, {
            state: "connected",
            connection_id: res.connection_id,
          });
        } catch (err: any) {
          get().updateCardState(card.card_id, { state: "disconnected" });
          set({ error: formatFriendlyError(err) });
        }
      }

      return card;
    } catch (e: any) {
      set({ loading: false, error: e?.message });
      throw e;
    }
  },

  switchMode: async (cardId, mode) => {
    const card = get().cards.find((c) => c.card_id === cardId);
    if (!card) return;
    if (card.protocol === "serial" && mode === "view") {
      // 串口视图卡禁止切到视图模式
      return;
    }
    try {
      const updated = await setCardMode(cardId, mode);
      get().updateCardState(cardId, { current_mode: updated.current_mode });
    } catch (e: any) {
      set({ error: formatFriendlyError(e) });
    }
  },

  toggleMode: async (cardId) => {
    const card = get().cards.find((c) => c.card_id === cardId);
    if (!card || card.protocol === "serial") return;
    const targetMode: CardMode = card.current_mode === "command" ? "view" : "command";
    await get().switchMode(cardId, targetMode);
  },

  closeCard: async (cardId) => {
    try {
      await apiCloseCard(cardId);
      const remaining = get().cards.filter((c) => c.card_id !== cardId);
      let nextActive = get().activeCardId;
      if (nextActive === cardId) {
        nextActive = remaining.length > 0 ? remaining[remaining.length - 1].card_id : null;
      }
      set({ cards: remaining, activeCardId: nextActive });
    } catch (e: any) {
      set({ error: formatFriendlyError(e) });
    }
  },

  updateCardState: (cardId, patch) => {
    set((s) => ({
      cards: s.cards.map((c) => (c.card_id === cardId ? { ...c, ...patch } : c)),
    }));
  },
}));
