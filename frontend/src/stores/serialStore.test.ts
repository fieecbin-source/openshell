import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pauseSerialRead,
  resumeSerialRead,
  subscribeSerial,
  teardownSerialSession,
  useSerialStore,
} from "./serialStore";
import { readSerial, sendSerial, terminalEncode } from "../lib/ipc";

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
