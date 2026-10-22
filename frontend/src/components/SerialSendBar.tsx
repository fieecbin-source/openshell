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
    <div className="flex flex-col bg-slate-900 border-t border-slate-800 p-2 gap-2 text-xs select-none">
      {/* 预设指令胶囊栏 */}
      <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-0.5">
        <span className="text-[11px] text-slate-500 font-medium mr-1">快捷片段:</span>
        {snippets.map((sn) => (
          <div
            key={sn.id}
            className="flex items-center rounded bg-slate-800 border border-slate-700 hover:border-slate-600 transition group"
          >
            <button
              type="button"
              onClick={() => sendSnippet(cardId, sn)}
              className="px-2 py-0.5 text-slate-300 hover:text-indigo-400 font-mono text-[11px]"
              title={`点击发送: ${sn.payload} (${sn.isHex ? "HEX" : "ASCII"})`}
            >
              {sn.name}
            </button>
            <button
              type="button"
              onClick={() => removeSnippet(sn.id)}
              className="px-1 text-slate-600 hover:text-rose-400 text-[10px] opacity-0 group-hover:opacity-100 transition"
              title="删除此片段"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setShowAddSnippet(!showAddSnippet)}
          className="px-1.5 py-0.5 rounded bg-slate-800/60 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border border-dashed border-slate-700 text-[11px] transition"
        >
          + 添加
        </button>
      </div>

      {/* 新增片段快捷表单 */}
      {showAddSnippet && (
        <form
          onSubmit={handleCreateSnippet}
          className="flex items-center gap-2 bg-slate-800/80 p-1.5 rounded border border-slate-700 animate-fadeIn"
        >
          <input
            type="text"
            placeholder="名称 (如: 读取传感器)"
            value={newSnippetName}
            onChange={(e) => setNewSnippetName(e.target.value)}
            className="px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs focus:outline-none focus:border-indigo-500 w-32"
          />
          <input
            type="text"
            placeholder={newSnippetIsHex ? "HEX (如: 01 03 00 00)" : "内容 (如: AT+CSQ\\r\\n)"}
            value={newSnippetPayload}
            onChange={(e) => setNewSnippetPayload(e.target.value)}
            className="flex-1 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-slate-200 text-xs font-mono focus:outline-none focus:border-indigo-500"
          />
          <label className="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={newSnippetIsHex}
              onChange={(e) => setNewSnippetIsHex(e.target.checked)}
              className="w-3.5 h-3.5 rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-0"
            />
            <span>HEX</span>
          </label>
          <button
            type="submit"
            className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-medium transition"
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => setShowAddSnippet(false)}
            className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs transition"
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
          className={`px-2 py-1 rounded font-mono text-[11px] font-bold border transition ${
            sendIsHex
              ? "bg-amber-950/80 text-amber-400 border-amber-600/80 shadow-[0_0_8px_rgba(245,158,11,0.2)]"
              : "bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200"
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
            className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 focus:border-indigo-500 rounded text-slate-200 text-xs font-mono focus:outline-none transition"
          />
        </div>

        {/* 换行符映射选择器 */}
        {!sendIsHex && (
          <select
            value={newlineMode}
            onChange={(e) => setNewlineMode(e.target.value as SerialNewlineMode)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300 text-xs focus:outline-none focus:border-indigo-500"
            title="追加换行符"
          >
            <option value="none">无换行</option>
            <option value="crlf">CRLF (\r\n)</option>
            <option value="lf">LF (\n)</option>
            <option value="cr">CR (\r)</option>
          </select>
        )}

        {/* 循环定时发送 */}
        <div className="flex items-center gap-1 bg-slate-800/80 rounded border border-slate-700 px-1.5 py-0.5">
          <span className="text-[11px] text-slate-400">循环:</span>
          <input
            type="number"
            min="10"
            max="60000"
            step="100"
            value={timerIntervalMs}
            onChange={(e) => setTimerIntervalMs(parseInt(e.target.value) || 1000)}
            className="w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-slate-200 focus:outline-none text-right"
          />
          <span className="text-[11px] text-slate-500">ms</span>
          <button
            type="button"
            onClick={() => (isTimerRunning ? stopTimer() : startTimer(cardId))}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${
              isTimerRunning
                ? "bg-rose-600 hover:bg-rose-500 text-white animate-pulse"
                : "bg-slate-700 hover:bg-slate-600 text-slate-300"
            }`}
          >
            {isTimerRunning ? "停止" : "启动"}
          </button>
        </div>

        {/* 发送大按钮 */}
        <button
          type="button"
          onClick={() => sendCurrent(cardId)}
          className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-medium rounded text-xs transition shadow-sm"
        >
          发送
        </button>
      </div>
    </div>
  );
};
