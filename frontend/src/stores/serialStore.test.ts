import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  pauseSerialRead,
  resumeSerialRead,
  subscribeSerial,
  teardownSerialSession,
  useSerialStore,
} from "./serialStore";
import { readSerial, sendSerial } from "../lib/ipc";

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
