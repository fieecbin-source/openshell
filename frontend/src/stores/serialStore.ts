import { create } from "zustand";
import type {
  ModemStatus,
  SerialNewlineMode,
  SerialPortInfo,
  SerialProfileConfig,
  SerialStats,
} from "../types/ipc";
import {
  listSerialPorts,
  openSerial,
  sendSerial,
  setSerialLines,
  getSerialModemStatus,
  getSerialStats,
  closeSerial,
} from "../lib/ipc";

export interface SerialSnippet {
  id: string;
  name: string;
  payload: string;
  isHex: boolean;
}

interface SerialState {
  ports: SerialPortInfo[];
  loadingPorts: boolean;
  activeCardId: string | null;
  modemStatus: Record<string, ModemStatus>;
  stats: Record<string, SerialStats>;
  viewMode: "ascii" | "hex";
  showTimestamp: boolean;
  sendText: string;
  sendIsHex: boolean;
  newlineMode: SerialNewlineMode;
  timerIntervalMs: number;
  isTimerRunning: boolean;
  timerHandle: any | null;
  history: string[];
  snippets: SerialSnippet[];

  // Actions
  loadPorts: () => Promise<void>;
  setActiveCard: (cardId: string | null) => void;
  openPort: (cardId: string, config: SerialProfileConfig, useMock?: boolean) => Promise<void>;
  sendCurrent: (cardId: string) => Promise<void>;
  sendSnippet: (cardId: string, snippet: SerialSnippet) => Promise<void>;
  setDtr: (cardId: string, level: boolean) => Promise<void>;
  setRts: (cardId: string, level: boolean) => Promise<void>;
  esp32Reset: (cardId: string) => Promise<void>;
  fetchModemStatus: (cardId: string) => Promise<void>;
  fetchStats: (cardId: string) => Promise<void>;
  startTimer: (cardId: string) => void;
  stopTimer: () => void;
  setViewMode: (mode: "ascii" | "hex") => void;
  setShowTimestamp: (show: boolean) => void;
  setSendText: (text: string) => void;
  setSendIsHex: (isHex: boolean) => void;
  setNewlineMode: (mode: SerialNewlineMode) => void;
  setTimerIntervalMs: (ms: number) => void;
  addSnippet: (name: string, payload: string, isHex: boolean) => void;
  removeSnippet: (id: string) => void;
  disconnectPort: (cardId: string) => Promise<void>;
}

export const useSerialStore = create<SerialState>((set, get) => ({
  ports: [],
  loadingPorts: false,
  activeCardId: null,
  modemStatus: {},
  stats: {},
  viewMode: "ascii",
  showTimestamp: false,
  sendText: "",
  sendIsHex: false,
  newlineMode: "crlf",
  timerIntervalMs: 1000,
  isTimerRunning: false,
  timerHandle: null,
  history: [],
  snippets: [
    { id: "1", name: "AT Ping", payload: "AT\r\n", isHex: false },
    { id: "2", name: "Version", payload: "ATI\r\n", isHex: false },
    { id: "3", name: "Modbus Read", payload: "01 03 00 00 00 02 C4 0B", isHex: true },
  ],

  loadPorts: async () => {
    set({ loadingPorts: true });
    try {
      const ports = await listSerialPorts();
      set({ ports, loadingPorts: false });
    } catch {
      set({ loadingPorts: false });
    }
  },

  setActiveCard: (cardId) => set({ activeCardId: cardId }),

  openPort: async (cardId, config, useMock = false) => {
    await openSerial(cardId, config, useMock);
    set({ activeCardId: cardId });
    get().fetchModemStatus(cardId);
    get().fetchStats(cardId);
  },

  sendCurrent: async (cardId) => {
    const { sendText, sendIsHex, newlineMode, history } = get();
    if (!sendText.trim()) return;

    let payloadBytes: number[] = [];
    if (sendIsHex) {
      // 非十六进制字符直接忽略，避免被静默转换成 0x00
      const cleaned = sendText.replace(/[^0-9a-fA-F]/g, "");
      for (let i = 0; i < cleaned.length; i += 2) {
        payloadBytes.push(parseInt(cleaned.substring(i, i + 2), 16));
      }
    } else {
      let textToSend = sendText;
      if (newlineMode === "cr") textToSend += "\r";
      else if (newlineMode === "lf") textToSend += "\n";
      else if (newlineMode === "crlf") textToSend += "\r\n";
      payloadBytes = Array.from(new TextEncoder().encode(textToSend));
    }

    await sendSerial(cardId, new Uint8Array(payloadBytes));

    const newHistory = [sendText, ...history.filter((h) => h !== sendText)].slice(0, 50);
    set({ history: newHistory });
    get().fetchStats(cardId);
  },

  sendSnippet: async (cardId, snippet) => {
    let payloadBytes: number[] = [];
    if (snippet.isHex) {
      const cleaned = snippet.payload.replace(/[^0-9a-fA-F]/g, "");
      for (let i = 0; i < cleaned.length; i += 2) {
        payloadBytes.push(parseInt(cleaned.substring(i, i + 2), 16));
      }
    } else {
      payloadBytes = Array.from(new TextEncoder().encode(snippet.payload));
    }
    await sendSerial(cardId, new Uint8Array(payloadBytes));
    get().fetchStats(cardId);
  },

  setDtr: async (cardId, level) => {
    await setSerialLines(cardId, level, undefined);
    get().fetchModemStatus(cardId);
  },

  setRts: async (cardId, level) => {
    await setSerialLines(cardId, undefined, level);
    get().fetchModemStatus(cardId);
  },

  esp32Reset: async (cardId) => {
    // ESP32 reset combo: DTR low, RTS high -> DTR high, RTS low
    await setSerialLines(cardId, false, true);
    await new Promise((r) => setTimeout(r, 100));
    await setSerialLines(cardId, true, false);
    get().fetchModemStatus(cardId);
  },

  fetchModemStatus: async (cardId) => {
    try {
      const status = await getSerialModemStatus(cardId);
      set((s) => ({
        modemStatus: { ...s.modemStatus, [cardId]: status },
      }));
    } catch {}
  },

  fetchStats: async (cardId) => {
    try {
      const stats = await getSerialStats(cardId);
      if (stats) {
        set((s) => ({
          stats: { ...s.stats, [cardId]: stats },
        }));
      }
    } catch {}
  },

  startTimer: (cardId) => {
    const { timerIntervalMs, isTimerRunning, sendCurrent } = get();
    if (isTimerRunning) return;

    const handle = setInterval(() => {
      sendCurrent(cardId);
    }, Math.max(10, timerIntervalMs));

    set({ isTimerRunning: true, timerHandle: handle });
  },

  stopTimer: () => {
    const { timerHandle } = get();
    if (timerHandle) clearInterval(timerHandle);
    set({ isTimerRunning: false, timerHandle: null });
  },

  setViewMode: (viewMode) => set({ viewMode }),
  setShowTimestamp: (showTimestamp) => set({ showTimestamp }),
  setSendText: (sendText) => set({ sendText }),
  setSendIsHex: (sendIsHex) => set({ sendIsHex }),
  setNewlineMode: (newlineMode) => set({ newlineMode }),
  setTimerIntervalMs: (timerIntervalMs) => set({ timerIntervalMs }),

  addSnippet: (name, payload, isHex) => {
    const newSnippet: SerialSnippet = {
      id: Date.now().toString(),
      name,
      payload,
      isHex,
    };
    set((s) => ({ snippets: [...s.snippets, newSnippet] }));
  },

  removeSnippet: (id) => {
    set((s) => ({ snippets: s.snippets.filter((sn) => sn.id !== id) }));
  },

  disconnectPort: async (cardId) => {
    get().stopTimer();
    try {
      await closeSerial(cardId);
    } catch {}
  },
}));
