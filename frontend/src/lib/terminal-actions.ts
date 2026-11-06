import { terminalEncode } from "./ipc";

export const SAVE_SNIPPET_EVENT = "openshell:save-snippet";

/** UTF-8 走浏览器原生快速路径，其余编码交给后端/TextDecoder 转换 */
export function isUtf8Encoding(encoding?: string | null): boolean {
  const normalized = (encoding ?? "").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "utf-8" ||
    normalized === "utf8" ||
    normalized === "utf-8-bom"
  );
}

export interface StreamingDecoder {
  decode(bytes: number[] | Uint8Array): string;
  reset(): void;
}

/**
 * 非 UTF-8 终端的下行解码器：保留跨块状态，避免多字节字符被拆开时出现乱码。
 * UTF-8 返回 null，调用方应直接把原始字节交给 xterm（更快且不破坏控制序列）。
 */
export function createStreamingDecoder(encoding?: string | null): StreamingDecoder | null {
  if (isUtf8Encoding(encoding)) return null;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding as string);
  } catch {
    throw new Error(`不支持的终端编码：${encoding}`);
  }
  return {
    decode(input) {
      const view = input instanceof Uint8Array ? input : new Uint8Array(input);
      return decoder.decode(view, { stream: true });
    },
    reset() {
      decoder.decode();
    },
  };
}

/**
 * 键盘/粘贴/命令广播的发送编码。UTF-8 本地编码，不会假装后端已支持其他编码；
 * 非 UTF-8 必须经 gpt 提供的 terminal_encode 转换，失败时抛出可读错误而不是静默按 UTF-8 发送。
 */
export async function encodeTextForSession(
  text: string,
  encoding?: string | null
): Promise<Uint8Array> {
  if (isUtf8Encoding(encoding)) return new TextEncoder().encode(text);
  try {
    const bytes = await terminalEncode(text, encoding as string);
    return new Uint8Array(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`终端编码失败（${encoding}）：${reason}`);
  }
}
