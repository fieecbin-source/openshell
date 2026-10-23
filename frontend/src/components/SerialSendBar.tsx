import React, { useState } from "react";
import { useSerialStore } from "../stores/serialStore";
import type { SerialNewlineMode } from "../types/ipc";

interface SerialSendBarProps {
  cardId: string;
}

export const SerialSendBar: React.FC<SerialSendBarProps> = ({ cardId }) => {
  const {
    sendText,
    setSendText,
    sendIsHex,
    setSendIsHex,
    newlineMode,
    setNewlineMode,
    timerIntervalMs,
    setTimerIntervalMs,
    isTimerRunning,
    startTimer,
    stopTimer,
    sendCurrent,
    sendSnippet,
    snippets,
    addSnippet,
    removeSnippet,
    history,
  } = useSerialStore();

  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showAddSnippet, setShowAddSnippet] = useState(false);
  const [newSnippetName, setNewSnippetName] = useState("");
  const [newSnippetPayload, setNewSnippetPayload] = useState("");
  const [newSnippetIsHex, setNewSnippetIsHex] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCurrent(cardId);
      setHistoryIndex(-1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0 && historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setSendText(history[nextIndex]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setSendText(history[nextIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setSendText("");
      }
    }
  };

  const handleCreateSnippet = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSnippetName.trim() || !newSnippetPayload.trim()) return;
    addSnippet(newSnippetName.trim(), newSnippetPayload.trim(), newSnippetIsHex);
    setNewSnippetName("");
    setNewSnippetPayload("");
    setShowAddSnippet(false);
  };

  return (
    <div className="flex flex-col bg-[#f5f5f7] border-t border-black/[0.06] p-2.5 gap-2 text-xs select-none">
      {/* 预设指令胶囊栏 */}
      <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-0.5">
        <span className="text-[11px] text-[#86868b] font-medium mr-1">快捷片段:</span>
        {snippets.map((sn) => (
          <div
            key={sn.id}
            className="flex items-center rounded-lg bg-white border border-black/[0.08] hover:border-black/[0.15] shadow-apple-sm transition group"
          >
            <button
              type="button"
              onClick={() => sendSnippet(cardId, sn)}
              className="px-2.5 py-0.5 text-[#1d1d1f] hover:text-[#0071e3] font-mono text-[11px] font-medium"
              title={`点击发送: ${sn.payload} (${sn.isHex ? "HEX" : "ASCII"})`}
            >
              {sn.name}
            </button>
            <button
              type="button"
              onClick={() => removeSnippet(sn.id)}
              className="px-1.5 text-[#86868b] hover:text-red-600 text-[11px] opacity-0 group-hover:opacity-100 transition"
              title="删除此片段"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setShowAddSnippet(!showAddSnippet)}
          className="px-2 py-0.5 rounded-lg bg-black/[0.04] hover:bg-black/[0.08] text-[#1d1d1f] border border-dashed border-black/[0.12] text-[11px] font-medium transition"
        >
          + 添加
        </button>
      </div>

      {/* 新增片段快捷表单 */}
      {showAddSnippet && (
        <form
          onSubmit={handleCreateSnippet}
          className="flex items-center gap-2 bg-white p-2 rounded-xl border border-black/[0.08] shadow-apple-sm animate-in fade-in"
        >
          <input
            type="text"
            placeholder="名称 (如: 读取传感器)"
            value={newSnippetName}
            onChange={(e) => setNewSnippetName(e.target.value)}
            className="px-2.5 py-1 bg-[#f5f5f7] border border-black/[0.08] rounded-lg text-[#1d1d1f] text-xs focus:outline-none focus:border-[#0071e3] focus:bg-white w-32 transition"
          />
          <input
            type="text"
            placeholder={newSnippetIsHex ? "HEX (如: 01 03 00 00)" : "内容 (如: AT+CSQ\\r\\n)"}
            value={newSnippetPayload}
            onChange={(e) => setNewSnippetPayload(e.target.value)}
            className="flex-1 px-2.5 py-1 bg-[#f5f5f7] border border-black/[0.08] rounded-lg text-[#1d1d1f] text-xs font-mono focus:outline-none focus:border-[#0071e3] focus:bg-white transition"
          />
          <label className="flex items-center gap-1 text-[11px] text-[#424245] cursor-pointer">
            <input
              type="checkbox"
              checked={newSnippetIsHex}
              onChange={(e) => setNewSnippetIsHex(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-black/[0.2] text-[#0071e3] focus:ring-0 accent-[#0071e3]"
            />
            <span>HEX</span>
          </label>
          <button
            type="submit"
            className="px-3 py-1 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-lg text-xs font-semibold shadow-sm transition active:scale-[0.98]"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => setShowAddSnippet(false)}
            className="px-2.5 py-1 bg-black/[0.04] hover:bg-black/[0.08] text-[#1d1d1f] rounded-lg text-xs font-medium transition"
          >
            取消
          </button>
        </form>
      )}

      {/* 主发送工具条 */}
      <div className="flex items-center gap-2">
        {/* 输入模式选择 */}
        <button
          type="button"
          onClick={() => setSendIsHex(!sendIsHex)}
          className={`px-2.5 py-1 rounded-lg font-mono text-[11px] font-bold border transition active:scale-[0.98] ${
            sendIsHex
              ? "bg-amber-50 text-amber-800 border-amber-300 shadow-apple-sm"
              : "bg-white text-[#424245] border-black/[0.08] hover:text-[#1d1d1f] shadow-apple-sm"
          }`}
          title="点击切换 ASCII 文本输入与 HEX 十六进制输入"
        >
          {sendIsHex ? "HEX 模式" : "ASCII"}
        </button>

        {/* 发送输入框 */}
        <div className="flex-1 relative">
          <input
            type="text"
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              sendIsHex
                ? "输入 HEX 十六进制字节（如 01 03 00 00 00 0A C5 CD），回车发送"
                : "输入串口指令（支持按 ↑/↓ 切换历史），回车发送"
            }
            className="w-full px-3 py-1.5 bg-white border border-black/[0.08] focus:border-[#0071e3] rounded-xl text-[#1d1d1f] text-xs font-mono focus:outline-none transition shadow-apple-sm"
          />
        </div>

        {/* 换行符映射选择器 */}
        {!sendIsHex && (
          <select
            value={newlineMode}
            onChange={(e) => setNewlineMode(e.target.value as SerialNewlineMode)}
            className="bg-white border border-black/[0.08] shadow-apple-sm rounded-xl px-2.5 py-1.5 text-[#1d1d1f] text-xs focus:outline-none focus:border-[#0071e3] transition"
            title="追加换行符"
          >
            <option value="none">无换行</option>
            <option value="crlf">CRLF (\r\n)</option>
            <option value="lf">LF (\n)</option>
            <option value="cr">CR (\r)</option>
          </select>
        )}

        {/* 循环定时发送 */}
        <div className="flex items-center gap-1.5 bg-white rounded-xl border border-black/[0.08] shadow-apple-sm px-2 py-1">
          <span className="text-[11px] text-[#86868b] font-medium">循环:</span>
          <input
            type="number"
            min="10"
            max="60000"
            step="100"
            value={timerIntervalMs}
            onChange={(e) => setTimerIntervalMs(parseInt(e.target.value) || 1000)}
            className="w-14 bg-[#f5f5f7] border border-black/[0.08] rounded-md px-1.5 py-0.5 text-[11px] font-mono text-[#1d1d1f] focus:outline-none text-right"
          />
          <span className="text-[11px] text-[#86868b]">ms</span>
          <button
            type="button"
            onClick={() => (isTimerRunning ? stopTimer() : startTimer(cardId))}
            className={`px-2 py-0.5 rounded-md text-[11px] font-semibold transition active:scale-[0.98] ${
              isTimerRunning
                ? "bg-red-500 text-white animate-pulse"
                : "bg-black/[0.04] hover:bg-black/[0.08] text-[#1d1d1f]"
            }`}
          >
            {isTimerRunning ? "停止" : "启动"}
          </button>
        </div>

        {/* 发送大按钮 */}
        <button
          type="button"
          onClick={() => sendCurrent(cardId)}
          className="px-4 py-1.5 bg-[#0071e3] hover:bg-[#0077ed] active:scale-[0.98] text-white font-semibold rounded-xl text-xs transition shadow-sm"
        >
          发送
        </button>
      </div>
    </div>
  );
};
