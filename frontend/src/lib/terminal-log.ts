/**
 * 会话输出日志（内存态，有界）。
 *
 * 历史实现把每个 chunk 用 `new TextDecoder().decode()` 解出来后累加到
 * `window.__openshell_session_log`：
 *  1. 每次新建解码器 → 被 chunk 边界切开的多字节字符（中文、emoji）会变成 U+FFFD；
 *  2. 字符串无限拼接 → O(n²) 复制 + 永不释放，开一天终端就是确定性内存泄漏。
 *
 * 这里改为：每个标签一个流式解码器 + 有界环形字符缓冲，标签关闭时释放。
 */

/** 单个会话最多保留的字符数（约 400KB 文本，足够回溯又不会拖慢 WebView） */
const MAX_CHARS_PER_TAB = 200_000;
/** 同时保留日志的会话数上限，超出后淘汰最早写入的会话 */
const MAX_TRACKED_TABS = 32;

interface LogEntry {
  text: string;
  decoder: TextDecoder;
}

const logs = new Map<string, LogEntry>();

export function appendSessionLog(tabId: string, payload: Uint8Array): void {
  if (payload.length === 0) return;

  let entry = logs.get(tabId);
  if (!entry) {
    if (logs.size >= MAX_TRACKED_TABS) {
      const oldest = logs.keys().next().value;
      if (oldest !== undefined) logs.delete(oldest);
    }
    entry = { text: "", decoder: new TextDecoder("utf-8") };
    logs.set(tabId, entry);
  }

  // stream: true —— 不完整的多字节序列会留在解码器内部等待下一个 chunk
  entry.text += entry.decoder.decode(payload, { stream: true });
  if (entry.text.length > MAX_CHARS_PER_TAB) {
    entry.text = entry.text.slice(entry.text.length - MAX_CHARS_PER_TAB);
  }
}

export function getSessionLog(tabId: string): string {
  return logs.get(tabId)?.text ?? "";
}

export function dropSessionLog(tabId: string): void {
  const entry = logs.get(tabId);
  if (!entry) return;
  // 冲掉解码器里可能残留的半个字符再丢弃
  try {
    entry.decoder.decode();
  } catch {
    // 解码器状态已不可用，忽略
  }
  logs.delete(tabId);
}
