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
  readSerial,
} from "../lib/ipc";
import { encodeTextForSession } from "../lib/terminal-actions";

export interface SerialSnippet {
  id: string;
  name: string;
  payload: string;
  isHex: boolean;
}

export interface SerialReadHandlers {
  onData?: (bytes: number[]) => void;
  onError?: (error: unknown) => void;
}

/**
 * 串口读取只能有一个消费者：ASCII 终端与 HEX 视图若各自轮询，
 * 会从后端唯一队列里抢走彼此的字节。这里按 card 维护单轮询 + 多订阅者分发。
 */
const SERIAL_READ_INTERVAL_MS = 50;
const serialReadSubscribers = new Map<string, Set<SerialReadHandlers>>();
const serialReadTimers = new Map<string, ReturnType<typeof setInterval>>();
const serialReadInFlight = new Set<string>();

function stopSerialReadPoller(cardId: string): void {
  const timer = serialReadTimers.get(cardId);
  if (timer !== undefined) clearInterval(timer);
  serialReadTimers.delete(cardId);
}

function ensureSerialReadPoller(cardId: string): void {
  if (serialReadTimers.has(cardId)) return;
  const timer = setInterval(async () => {
    const handlers = serialReadSubscribers.get(cardId);
    if (!handlers || handlers.size === 0) {
      stopSerialReadPoller(cardId);
      return;
    }
    if (serialReadInFlight.has(cardId)) return;
    serialReadInFlight.add(cardId);
    try {
      const bytes = await readSerial(cardId, 4096);
      const current = serialReadSubscribers.get(cardId);
      if (!current || current.size === 0 || bytes.length === 0) return;
      // 同一份原始字节同步分发，ASCII/HEX 得到完全一致的数据
      for (const handler of Array.from(current)) handler.onData?.(bytes);
    } catch (error) {
      // 设备失败：停止轮询并把错误交给订阅者，不允许静默吞掉。
      // 订阅者必须保留——HEX 视图的 effect 只依赖 cardId，重连后 cardId 不变，
      // 若在这里把订阅删掉，它永远不会重新订阅，界面会永久冻结。
      stopSerialReadPoller(cardId);
      const current = serialReadSubscribers.get(cardId);
      if (current) {
        for (const handler of Array.from(current)) handler.onError?.(error);
      }
    } finally {
      serialReadInFlight.delete(cardId);
    }
  }, SERIAL_READ_INTERVAL_MS);
  serialReadTimers.set(cardId, timer);
}

export function subscribeSerial(
  cardId: string,
  handlers: SerialReadHandlers
): () => void {
  let subscribers = serialReadSubscribers.get(cardId);
  if (!subscribers) {
    subscribers = new Set();
    serialReadSubscribers.set(cardId, subscribers);
  }
  subscribers.add(handlers);
  ensureSerialReadPoller(cardId);

  return () => {
    const current = serialReadSubscribers.get(cardId);
    if (!current) return;
    current.delete(handlers);
    if (current.size === 0) {
      serialReadSubscribers.delete(cardId);
      stopSerialReadPoller(cardId);
    }
  };
}

export interface SerialSendError {
  cardId: string;
  message: string;
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
  /** 最近一次串口发送失败；由 TerminalHost 转成断开状态后清空 */
  sendError: SerialSendError | null;

  // Actions
  loadPorts: () => Promise<void>;
  setActiveCard: (cardId: string | null) => void;
  openPort: (cardId: string, config: SerialProfileConfig, useMock?: boolean) => Promise<void>;
  sendCurrent: (cardId: string, encoding?: string | null) => Promise<void>;
  sendSnippet: (cardId: string, snippet: SerialSnippet, encoding?: string | null) => Promise<void>;
  clearSendError: () => void;
  setDtr: (cardId: string, level: boolean) => Promise<void>;
  setRts: (cardId: string, level: boolean) => Promise<void>;
  esp32Reset: (cardId: string) => Promise<void>;
  fetchModemStatus: (cardId: string) => Promise<void>;
  fetchStats: (cardId: string) => Promise<void>;
  startTimer: (cardId: string, encoding?: string | null) => void;
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
  sendError: null,

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

  sendCurrent: async (cardId, encoding) => {
    const { sendText, sendIsHex, newlineMode, history } = get();
    if (!sendText.trim()) return;

    let payloadBytes: number[] = [];
    try {
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
        payloadBytes = Array.from(await encodeTextForSession(textToSend, encoding));
      }

      await sendSerial(cardId, new Uint8Array(payloadBytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { timerHandle, isTimerRunning } = get();
      if (isTimerRunning && timerHandle) clearInterval(timerHandle);
      set({
        sendError: { cardId, message },
        isTimerRunning: false,
        timerHandle: null,
      });
      throw error instanceof Error ? error : new Error(message);
    }

    const newHistory = [sendText, ...history.filter((h) => h !== sendText)].slice(0, 50);
    set({ history: newHistory });
    get().fetchStats(cardId);
  },

  sendSnippet: async (cardId, snippet, encoding) => {
    let payloadBytes: number[] = [];
    try {
      if (snippet.isHex) {
        const cleaned = snippet.payload.replace(/[^0-9a-fA-F]/g, "");
        for (let i = 0; i < cleaned.length; i += 2) {
          payloadBytes.push(parseInt(cleaned.substring(i, i + 2), 16));
        }
      } else {
        payloadBytes = Array.from(await encodeTextForSession(snippet.payload, encoding));
      }
      await sendSerial(cardId, new Uint8Array(payloadBytes));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { timerHandle, isTimerRunning } = get();
      if (isTimerRunning && timerHandle) clearInterval(timerHandle);
      set({
        sendError: { cardId, message },
        isTimerRunning: false,
        timerHandle: null,
      });
      throw error instanceof Error ? error : new Error(message);
    }
    get().fetchStats(cardId);
  },

  clearSendError: () => set({ sendError: null }),

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

  startTimer: (cardId, encoding) => {
    const { timerIntervalMs, isTimerRunning, sendCurrent } = get();
    if (isTimerRunning) return;

    const handle = setInterval(() => {
      // 发送失败会在 sendCurrent 内记录 sendError 并停止定时器；这里吞掉重复拒绝
      void sendCurrent(cardId, encoding).catch(() => {});
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
    teardownSerialSession(cardId);
    try {
      await closeSerial(cardId);
    } catch {}
  },
}));

/** 暂停 RX 轮询但保留订阅者：故障/断开期间不清空 HEX/ASCII 的订阅关系，重连后可原地恢复。 */
export function pauseSerialRead(cardId: string): void {
  stopSerialReadPoller(cardId);
}

/** 重连成功后恢复 RX 轮询；订阅者仍在时无需视图重新挂载即可继续收数据。 */
export function resumeSerialRead(cardId: string): void {
  const subscribers = serialReadSubscribers.get(cardId);
  if (!subscribers || subscribers.size === 0) return;
  ensureSerialReadPoller(cardId);
}

/** 停止串口定时发送；关闭/重连时调用，避免旧定时任务在新连接上意外继续发送。 */
export function stopSerialSendTimer(): void {
  useSerialStore.getState().stopTimer();
}

/**
 * 统一串口 teardown：停止定时发送、RX 轮询、订阅和错误状态。
 * 用于用户主动关闭标签；不负责 closeSerial，由调用者按原有顺序释放句柄。
 */
export function teardownSerialSession(cardId: string): void {
  stopSerialSendTimer();
  stopSerialReadPoller(cardId);
  serialReadSubscribers.delete(cardId);
  useSerialStore.setState((state) => ({
    sendError: state.sendError?.cardId === cardId ? null : state.sendError,
    activeCardId: state.activeCardId === cardId ? null : state.activeCardId,
  }));
}
