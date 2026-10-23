import React, { useState } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { writeTerminal } from "../lib/ipc";

interface MultiExecBarProps {
  onClose: () => void;
}

const DANGEROUS_PATTERNS = [
  /\brm\s+-[rfRF]{1,3}\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\breboot\b/,
  /\bshutdown\b/,
  /\binit\s+[06]\b/,
  /:\(\)\{\s*:\|:&\s*\};:/,
  />\s*\/dev\/(sd[a-z]|nvme[0-9])/,
  /\bchmod\s+-R\s+777\s+\/\b/,
];

export const MultiExecBar: React.FC<MultiExecBarProps> = ({ onClose }) => {
  const { tabs } = useTerminalStore();
  const connectedTabs = tabs.filter((t) => t.status === "connected");

  const [selectedTabIds, setSelectedTabIds] = useState<string[]>(
    connectedTabs.map((t) => t.tabId)
  );
  const [command, setCommand] = useState("");
  const [dangerModal, setDangerModal] = useState<string | null>(null);

  const toggleSelectTab = (tabId: string) => {
    setSelectedTabIds((prev) =>
      prev.includes(tabId) ? prev.filter((id) => id !== tabId) : [...prev, tabId]
    );
  };

  const handleSelectAll = () => {
    if (selectedTabIds.length === connectedTabs.length) {
      setSelectedTabIds([]);
    } else {
      setSelectedTabIds(connectedTabs.map((t) => t.tabId));
    }
  };

  const checkDangerous = (cmd: string): boolean => {
    return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
  };

  const handleSend = () => {
    if (!command.trim() || selectedTabIds.length === 0) return;

    if (checkDangerous(command)) {
      setDangerModal(command);
    } else {
      dispatchCommand(command);
    }
  };

  const dispatchCommand = (cmd: string) => {
    const bytes = new TextEncoder().encode(cmd + "\n");
    for (const tabId of selectedTabIds) {
      writeTerminal(tabId, bytes).catch(console.warn);
    }
    setCommand("");
    setDangerModal(null);
  };

  return (
    <div className="bg-[#fbfbfd] border-t border-slate-200/80 p-3 px-4 flex flex-col gap-2.5 shadow-apple-md select-none text-slate-800">
      {/* 顶部目标选择 */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-apple-orange animate-pulse" />
          <span className="font-semibold text-slate-900">多会话同步输入 (MultiExec)</span>
          <span className="text-slate-500 text-[11px]">
            已选 {selectedTabIds.length} / {connectedTabs.length} 个终端
          </span>
          <button
            onClick={handleSelectAll}
            className="text-[11px] text-apple-blue hover:underline ml-2 font-medium"
          >
            {selectedTabIds.length === connectedTabs.length ? "取消全选" : "全选"}
          </button>
        </div>

        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700 p-1 rounded-full hover:bg-slate-200 transition"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* 终端选择 Chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {connectedTabs.map((t) => {
          const isSelected = selectedTabIds.includes(t.tabId);
          return (
            <button
              key={t.tabId}
              onClick={() => toggleSelectTab(t.tabId)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-mono border transition ${
                isSelected
                  ? "bg-apple-orange/10 text-amber-800 border-apple-orange/30 font-semibold shadow-apple-sm"
                  : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
              }`}
            >
              {isSelected ? "✓ " : ""}{t.sessionName}
            </button>
          );
        })}
      </div>

      {/* 命令输入框与执行按钮 */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          placeholder="在此输入将同时发送到上述所有选定终端的命令并回车..."
          className="flex-1 px-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-900 outline-none focus:border-apple-blue focus:ring-1 focus:ring-apple-blue shadow-apple-sm"
        />
        <button
          onClick={handleSend}
          disabled={!command.trim() || selectedTabIds.length === 0}
          className="px-4 py-2 bg-apple-orange hover:bg-amber-600 text-white text-xs font-semibold rounded-xl shadow-apple-sm transition disabled:opacity-40"
        >
          广播执行
        </button>
      </div>

      {/* 危险命令警告弹窗 */}
      {dangerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-white border border-red-300 rounded-2xl p-6 shadow-apple-xl text-slate-800">
            <div className="flex items-center gap-3 mb-3 text-apple-red">
              <svg className="w-6 h-6 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h4 className="text-base font-bold text-slate-900">高危多机同步广播警告！</h4>
            </div>

            <p className="text-xs text-slate-600 leading-relaxed mb-4">
              您即将在 <span className="text-apple-red font-bold font-mono">{selectedTabIds.length}</span> 台远端服务器上同时执行高危破坏性指令：
            </p>

            <div className="p-3 bg-red-50 border border-red-200 rounded-xl font-mono text-xs text-red-700 break-all mb-5">
              {dangerModal}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDangerModal(null)}
                className="px-4 py-2 border border-slate-200 hover:bg-slate-100 text-slate-600 rounded-xl text-xs transition"
              >
                取消执行
              </button>
              <button
                onClick={() => dispatchCommand(dangerModal)}
                className="px-4 py-2 bg-apple-red hover:bg-red-600 text-white font-semibold rounded-xl text-xs shadow-apple-sm transition"
              >
                仍然广播执行 (后果自负)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
