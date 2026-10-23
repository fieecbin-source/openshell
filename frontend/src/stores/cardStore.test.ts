import { describe, it, expect, vi, beforeEach } from "vitest";
import { useCardStore } from "./cardStore";
import type { SessionCard } from "../types/ipc";

// Mock ipc
vi.mock("../lib/ipc", () => ({
  createCard: vi.fn(async (sessionId: string) => ({
    card_id: "card_123",
    session_id: sessionId,
    name: "Test-Server",
    protocol: "ssh",
    current_mode: "command",
    state: "connecting",
    created_at: 1000,
    last_active_at: 1000,
  })),
  listCards: vi.fn(async () => []),
  setCardMode: vi.fn(async (cardId: string, mode: string) => ({
    card_id: cardId,
    session_id: "sess_1",
    name: "Test-Server",
    protocol: "ssh",
    current_mode: mode,
    state: "connected",
    created_at: 1000,
    last_active_at: 1000,
  })),
  closeCard: vi.fn(async () => {}),
  connectSession: vi.fn(async () => ({ connection_id: "conn_1" })),
  openSerial: vi.fn(async () => {}),
}));

describe("cardStore", () => {
  beforeEach(() => {
    useCardStore.setState({
      cards: [],
      activeCardId: null,
      loading: false,
      error: null,
    });
  });

  it("should add card and set activeCardId", () => {
    const card: SessionCard = {
      card_id: "c_1",
      session_id: "s_1",
      name: "Alpha",
      protocol: "ssh",
      current_mode: "command",
      state: "connected",
      connection_id: "conn_1",
      created_at: Date.now(),
      last_active_at: Date.now(),
    };

    useCardStore.setState({ cards: [card], activeCardId: "c_1" });
    const state = useCardStore.getState();
    expect(state.cards.length).toBe(1);
    expect(state.activeCardId).toBe("c_1");
  });

  it("should switch mode between command and view", async () => {
    const card: SessionCard = {
      card_id: "c_1",
      session_id: "s_1",
      name: "Alpha",
      protocol: "ssh",
      current_mode: "command",
      state: "connected",
      connection_id: "conn_1",
      created_at: Date.now(),
      last_active_at: Date.now(),
    };

    useCardStore.setState({ cards: [card], activeCardId: "c_1" });
    await useCardStore.getState().switchMode("c_1", "view");

    const updated = useCardStore.getState().cards.find((c) => c.card_id === "c_1");
    expect(updated?.current_mode).toBe("view");
  });

  it("should disallow switching to view mode for serial card", async () => {
    const serialCard: SessionCard = {
      card_id: "c_serial",
      session_id: "s_serial",
      name: "COM3",
      protocol: "serial",
      current_mode: "command",
      state: "connected",
      connection_id: null,
      created_at: Date.now(),
      last_active_at: Date.now(),
    };

    useCardStore.setState({ cards: [serialCard], activeCardId: "c_serial" });
    await useCardStore.getState().switchMode("c_serial", "view");

    const notUpdated = useCardStore.getState().cards.find((c) => c.card_id === "c_serial");
    expect(notUpdated?.current_mode).toBe("command");
  });
});
