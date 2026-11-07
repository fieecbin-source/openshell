import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pauseSerialRead,
  resumeSerialRead,
  stopSerialSendTimer,
  subscribeSerial,
  teardownSerialSession,
  useSerialStore,
} from "./serialStore";
import { getSerialStats, readSerial, sendSerial, terminalEncode } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({
  listSerialPorts: vi.fn(),
  openSerial: vi.fn(),
  sendSerial: vi.fn(),
  setSerialLines: vi.fn(),
  getSerialModemStatus: vi.fn(),
  getSerialStats: vi.fn(),
  closeSerial: vi.fn(),
  readSerial: vi.fn(),
  terminalEncode: vi.fn(),
}));

const read = vi.mocked(readSerial);
const write = vi.mocked(sendSerial);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useSerialStore.setState({
    sendText: "AT",
    sendIsHex: false,
    newlineMode: "none",
    isTimerRunning: false,
    timerHandle: null,
    timerCardId: null,
    sendError: null,
  });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("fans out the same raw bytes to ASCII and HEX subscribers from one poller", async () => {
  read.mockResolvedValue([0x41, 0x42]);
  const ascii = vi.fn();
  const hex = vi.fn();
  const unsubscribeAscii = subscribeSerial("card", { onData: ascii });
  const unsubscribeHex = subscribeSerial("card", { onData: hex });

  await vi.advanceTimersByTimeAsync(60);

  expect(read).toHaveBeenCalledTimes(1);
  expect(ascii).toHaveBeenCalledTimes(1);
  expect(hex).toHaveBeenCalledTimes(1);
  // 两个视图拿到的是同一份字节，不存在谁先读走谁没数据
  expect(ascii.mock.calls[0][0]).toEqual([0x41, 0x42]);
  expect(hex.mock.calls[0][0]).toBe(ascii.mock.calls[0][0]);

  unsubscribeAscii();
  unsubscribeHex();
});

it("stops polling and reports the read error to every subscriber", async () => {
  read.mockRejectedValue(new Error("device unplugged"));
  const errorA = vi.fn();
  const errorB = vi.fn();
  const unsubscribeA = subscribeSerial("card-error", { onError: errorA });
  const unsubscribeB = subscribeSerial("card-error", { onError: errorB });

  await vi.advanceTimersByTimeAsync(60);

  expect(errorA).toHaveBeenCalledTimes(1);
  expect(errorB).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  await vi.advanceTimersByTimeAsync(200);
  expect(read).toHaveBeenCalledTimes(1);

  unsubscribeA();
  unsubscribeB();
});

it("stops the shared poller when the last subscriber unsubscribes", async () => {
  read.mockResolvedValue([]);
  const unsubscribe = subscribeSerial("card", { onData: vi.fn() });
  unsubscribe();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(read).not.toHaveBeenCalled();
});

it("records a send failure and stops the timer instead of swallowing it", async () => {
  useSerialStore.setState({ isTimerRunning: true, timerHandle: 1 as unknown as ReturnType<typeof setInterval> });
  write.mockRejectedValueOnce(new Error("write failed"));

  await expect(useSerialStore.getState().sendCurrent("card")).rejects.toThrow("write failed");

  expect(useSerialStore.getState().sendError).toMatchObject({
    cardId: "card",
    message: expect.stringContaining("write failed"),
  });
  expect(useSerialStore.getState().isTimerRunning).toBe(false);
  expect(useSerialStore.getState().timerHandle).toBeNull();
});

it("resumes RX polling after a device failure without dropping HEX/ASCII subscribers", async () => {
  read.mockRejectedValueOnce(new Error("device unplugged")).mockResolvedValue([0x41, 0x42]);
  const data = vi.fn();
  const onError = vi.fn();
  const unsubscribe = subscribeSerial("card-recover", { onData: data, onError });

  await vi.advanceTimersByTimeAsync(60);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  // 模拟重连后恢复：订阅关系仍在，原地重启轮询即可继续收数据
  resumeSerialRead("card-recover");
  await vi.advanceTimersByTimeAsync(60);
  expect(data).toHaveBeenCalledWith([0x41, 0x42]);

  unsubscribe();
});

it("pauses RX polling on disconnect and resumes it after reconnect", async () => {
  read.mockResolvedValue([0x01]);
  const data = vi.fn();
  const unsubscribe = subscribeSerial("card-pause", { onData: data });

  pauseSerialRead("card-pause");
  await vi.advanceTimersByTimeAsync(200);
  expect(read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  resumeSerialRead("card-pause");
  await vi.advanceTimersByTimeAsync(60);
  expect(data).toHaveBeenCalledWith([0x01]);

  unsubscribe();
});

it("tears down timer, polling, subscribers and send error together", async () => {
  read.mockResolvedValue([]);
  const data = vi.fn();
  const unsubscribe = subscribeSerial("card-teardown", { onData: data });
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 1 as unknown as ReturnType<typeof setInterval>,
    sendError: { cardId: "card-teardown", message: "boom" } as unknown as never,
  });

  teardownSerialSession("card-teardown");

  expect(useSerialStore.getState().isTimerRunning).toBe(false);
  expect(useSerialStore.getState().timerHandle).toBeNull();
  expect(useSerialStore.getState().sendError).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  expect(read).not.toHaveBeenCalled();

  // 视图卸载时的兜底取消不应影响已清空的 teardown 状态
  unsubscribe();
});

it("S06: does not write to a reopened card when encoding finishes after a reconnect", async () => {
  let finishEncode!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishEncode = resolve; })
  );

  const pending = useSerialStore.getState().sendCurrent("card-reopen", "gb18030");
  await vi.advanceTimersByTimeAsync(0);
  // 断开后按同一个 cardId 重开：pause/resume 是重连路径的既有动作，所有标识都不变
  pauseSerialRead("card-reopen");
  resumeSerialRead("card-reopen");
  finishEncode([0x41]);

  await expect(pending).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

it("S06: does not write a snippet when the port is torn down during encoding", async () => {
  let finishEncode!: (value: number[]) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((resolve) => { finishEncode = resolve; })
  );
  useSerialStore.getState().addSnippet("probe", "AT", false);
  const snippet = useSerialStore.getState().snippets.at(-1)!;

  const pending = useSerialStore.getState().sendSnippet("card-teardown-race", snippet, "gb18030");
  await vi.advanceTimersByTimeAsync(0);
  teardownSerialSession("card-teardown-race");
  finishEncode([0x41]);

  await expect(pending).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

// ── Task7 R06：旧 encode / send 拒绝不得污染新 timer、旧 sendError 或其他 card ──
it("R06: a stale encode rejection cannot stop the new timer or write an old sendError", async () => {
  let failEncode!: (error: Error) => void;
  vi.mocked(terminalEncode).mockImplementationOnce(
    () => new Promise<number[]>((_resolve, reject) => { failEncode = reject; })
  );
  const stale = useSerialStore.getState().sendCurrent("card-stale", "gb18030");
  await vi.advanceTimersByTimeAsync(0);

  // 断开重开后新 timer 已启动；旧句柄的编码拒绝此时才到达
  pauseSerialRead("card-stale");
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 2 as unknown as ReturnType<typeof setInterval>,
    timerCardId: "card-stale",
    sendError: null,
  });
  failEncode(new Error("encoder unavailable"));

  await expect(stale).rejects.toThrow();
  expect(useSerialStore.getState().sendError).toBeNull();
  expect(useSerialStore.getState().isTimerRunning).toBe(true);
  expect(useSerialStore.getState().timerHandle).toBe(2 as unknown as ReturnType<typeof setInterval>);
  expect(useSerialStore.getState().timerCardId).toBe("card-stale");
});

it("R06: a stale sendSerial rejection cannot stop a different card's timer", async () => {
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);
  let failWrite!: (error: Error) => void;
  write.mockImplementationOnce(
    () => new Promise<number>((_resolve, reject) => { failWrite = reject; })
  );
  const stale = useSerialStore.getState().sendCurrent("card-old", "utf-8");
  await vi.advanceTimersByTimeAsync(0);

  pauseSerialRead("card-old");
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 3 as unknown as ReturnType<typeof setInterval>,
    timerCardId: "card-other",
    sendError: null,
  });
  failWrite(new Error("device gone"));

  await expect(stale).rejects.toThrow();
  expect(useSerialStore.getState().sendError).toBeNull();
  expect(useSerialStore.getState().isTimerRunning).toBe(true);
  expect(useSerialStore.getState().timerHandle).toBe(3 as unknown as ReturnType<typeof setInterval>);
  expect(useSerialStore.getState().timerCardId).toBe("card-other");
});

it("R06: a genuine failure on the current card still reports the error and stops its own timer", async () => {
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);
  write.mockRejectedValueOnce(new Error("write failed"));
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 4 as unknown as ReturnType<typeof setInterval>,
    timerCardId: "card-current",
    sendError: null,
  });

  await expect(
    useSerialStore.getState().sendCurrent("card-current", "utf-8")
  ).rejects.toThrow("write failed");
  expect(useSerialStore.getState().sendError).toMatchObject({
    cardId: "card-current",
    message: expect.stringContaining("write failed"),
  });
  expect(useSerialStore.getState().isTimerRunning).toBe(false);
  expect(useSerialStore.getState().timerHandle).toBeNull();
  expect(useSerialStore.getState().timerCardId).toBeNull();
});

// ── Task8 红测：旧写入晚完成、并发历史合并、按 card 停 timer ──
const T8_STATS = { rx_bytes: 20, tx_bytes: 20, rx_bps: 2, tx_bps: 2 };

it("T8-2: a write that resolves after the card is reopened cannot overwrite new history or refresh stats", async () => {
  useSerialStore.setState({
    sendText: "OLD", sendIsHex: false, newlineMode: "none",
    history: [], stats: {}, sendError: null,
    isTimerRunning: false, timerHandle: null, timerCardId: null,
  });
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);
  let finishWrite!: (value: number) => void;
  write.mockImplementationOnce(
    () => new Promise<number>((resolve) => { finishWrite = resolve; })
  );

  const stale = useSerialStore.getState().sendCurrent("t8-late", "gb18030");
  await vi.advanceTimersByTimeAsync(0);

  // 同 card 重开：代次失效，新连接已有自己的历史与统计
  pauseSerialRead("t8-late");
  useSerialStore.setState({ sendText: "NEW", history: ["NEW"], stats: { "t8-late": T8_STATS } });

  finishWrite(3);
  const outcome = await stale.then(() => "resolved", () => "rejected");

  expect(outcome).toBe("rejected");
  expect(useSerialStore.getState().history).toEqual(["NEW"]);
  expect(useSerialStore.getState().stats["t8-late"]).toEqual(T8_STATS);
  expect(vi.mocked(getSerialStats)).not.toHaveBeenCalled();
  expect(useSerialStore.getState().sendError).toBeNull();
});

it("T8-3: a snippet write that resolves after a pause cannot refresh stats or report a stale failure", async () => {
  useSerialStore.setState({
    sendText: "AT", sendIsHex: false, newlineMode: "none",
    history: [], stats: {}, sendError: null,
  });
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);
  let finishWrite!: (value: number) => void;
  write.mockImplementationOnce(
    () => new Promise<number>((resolve) => { finishWrite = resolve; })
  );
  const snippet = { id: "t8", name: "probe", payload: "AT", isHex: false };

  const stale = useSerialStore.getState().sendSnippet("t8-snippet", snippet, "gb18030");
  await vi.advanceTimersByTimeAsync(0);
  pauseSerialRead("t8-snippet");
  useSerialStore.setState({ stats: { "t8-snippet": T8_STATS } });

  finishWrite(2);
  const outcome = await stale.then(() => "resolved", () => "rejected");

  expect(outcome).toBe("rejected");
  expect(useSerialStore.getState().stats["t8-snippet"]).toEqual(T8_STATS);
  expect(vi.mocked(getSerialStats)).not.toHaveBeenCalled();
  expect(useSerialStore.getState().sendError).toBeNull();
});

it("T8-4: concurrent sends merge into the latest history instead of overwriting each other", async () => {
  useSerialStore.setState({
    sendIsHex: false, newlineMode: "none", history: [], stats: {}, sendError: null,
  });
  vi.mocked(terminalEncode).mockResolvedValue([0x41]);
  const resolvers: Array<(value: number) => void> = [];
  write
    .mockImplementationOnce(() => new Promise<number>((resolve) => { resolvers.push(resolve); }))
    .mockImplementationOnce(() => new Promise<number>((resolve) => { resolvers.push(resolve); }));

  useSerialStore.setState({ sendText: "A" });
  const a = useSerialStore.getState().sendCurrent("t8-merge", "gb18030");
  await vi.advanceTimersByTimeAsync(0);
  useSerialStore.setState({ sendText: "B" });
  const b = useSerialStore.getState().sendCurrent("t8-merge", "gb18030");
  await vi.advanceTimersByTimeAsync(0);

  resolvers[1](1); // B 先完成
  expect(await b.then(() => "resolved", () => "rejected")).toBe("resolved");
  expect(useSerialStore.getState().history).toEqual(["B"]);

  resolvers[0](1); // A 后完成，必须合并而不是覆盖
  expect(await a.then(() => "resolved", () => "rejected")).toBe("resolved");
  expect(useSerialStore.getState().history).toEqual(["A", "B"]);
});

it("T8-5: tearing down card A leaves card B's owned timer running", () => {
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 501 as unknown as ReturnType<typeof setInterval>,
    timerCardId: "t8-card-B",
    sendError: null,
  });

  teardownSerialSession("t8-card-A");

  expect(useSerialStore.getState().isTimerRunning).toBe(true);
  expect(useSerialStore.getState().timerCardId).toBe("t8-card-B");
});

it("T8-12: a card-scoped stop keeps another card's timer, an unscoped stop is still global", () => {
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 502 as unknown as ReturnType<typeof setInterval>,
    timerCardId: "t8-card-B",
    sendError: null,
  });

  stopSerialSendTimer("t8-card-A");
  expect(useSerialStore.getState().isTimerRunning).toBe(true);
  expect(useSerialStore.getState().timerCardId).toBe("t8-card-B");

  // 生命周期只停自己的 timer
  stopSerialSendTimer("t8-card-B");
  expect(useSerialStore.getState().isTimerRunning).toBe(false);
  expect(useSerialStore.getState().timerCardId).toBeNull();

  // 用户显式按钮不传 cardId，维持全局停止原意
  useSerialStore.setState({
    isTimerRunning: true,
    timerHandle: 503 as unknown as ReturnType<typeof setInterval>,
    timerCardId: "t8-card-C",
  });
  useSerialStore.getState().stopTimer();
  expect(useSerialStore.getState().isTimerRunning).toBe(false);
});
