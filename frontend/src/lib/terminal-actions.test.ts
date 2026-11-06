import { beforeEach, expect, it, vi } from "vitest";
import {
  createStreamingDecoder,
  encodeTextForSession,
  isUtf8Encoding,
} from "./terminal-actions";
import { terminalEncode } from "./ipc";

vi.mock("./ipc", () => ({ terminalEncode: vi.fn() }));
const encode = vi.mocked(terminalEncode);

beforeEach(() => {
  vi.clearAllMocks();
});

it("detects UTF-8 aliases and treats missing encoding as UTF-8", () => {
  expect(isUtf8Encoding(undefined)).toBe(true);
  expect(isUtf8Encoding("")).toBe(true);
  expect(isUtf8Encoding("UTF-8")).toBe(true);
  expect(isUtf8Encoding("utf8")).toBe(true);
  expect(isUtf8Encoding("gb18030")).toBe(false);
});

it("keeps multibyte characters intact across streamed chunks", () => {
  const decoder = createStreamingDecoder("gb18030");
  expect(decoder).not.toBeNull();
  // GB18030: 中 = D6 D0, 文 = CE C4
  expect(decoder!.decode([0xd6])).toBe("");
  expect(decoder!.decode([0xd0, 0xce])).toBe("中");
  expect(decoder!.decode([0xc4])).toBe("文");
});

it("passes ANSI control sequences through the non-UTF-8 decoder", () => {
  const decoder = createStreamingDecoder("windows-1252");
  expect(decoder!.decode([0x1b, 0x5b, 0x41])).toBe("\x1b[A");
});

it("returns null fast path for UTF-8 and reports unsupported encodings", () => {
  expect(createStreamingDecoder("utf-8")).toBeNull();
  expect(() => createStreamingDecoder("no-such-encoding")).toThrow("不支持的终端编码");
});

it("encodes UTF-8 locally without touching the backend", async () => {
  const bytes = await encodeTextForSession("你好", "utf-8");
  expect(Array.from(bytes)).toEqual(Array.from(new TextEncoder().encode("你好")));
  expect(encode).not.toHaveBeenCalled();
});

it("uses terminal_encode for non-UTF-8 text and surfaces its failure", async () => {
  encode.mockResolvedValueOnce([0x41, 0x42]);
  const bytes = await encodeTextForSession("AB", "gb18030");
  expect(encode).toHaveBeenCalledWith("AB", "gb18030");
  expect(Array.from(bytes)).toEqual([0x41, 0x42]);

  encode.mockRejectedValueOnce(new Error("encoder offline"));
  await expect(encodeTextForSession("AB", "gb18030")).rejects.toThrow(
    "终端编码失败（gb18030）：encoder offline"
  );
});
