import React, { useEffect, useState } from "react";
import { useSnippetStore } from "../stores/snippetStore";
import type { SendMode, Snippet } from "../types/ipc";
import { writeTerminal } from "../lib/ipc";

interface SnippetBarProps {
  activeTabId: string | null;
}

export const SnippetBar: React.FC<SnippetBarProps> = ({ activeTabId }) => {
  const { snippets, loadSnippets, createSnippet, deleteSnippet } = useSnippetStore();
  const [paramModal, setParamModal] = useState<{
    snippet: Snippet;
    params: { name: string; defaultValue: string; value: string }[];
  } | null>(null);

  const [createModal, setCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [newSendMode, setNewSendMode] = useState<SendMode>("execute");

  useEffect(() => {
    loadSnippets();
  }, []);

  // 解析命令模板中的占位符，例如 ${PORT:-8080} 或 ${HOST}
  const parsePlaceholders = (template: string) => {
    const regex = /\$\{([a-zA-Z0-9_]+)(?::-(.*?))?\}/g;
    const matches: { name: string; defaultValue: string; value: string }[] = [];
    const seen = new Set<string>();

    let match;
    while ((match = regex.exec(template)) !== null) {
      const name = match[1];
      const defaultValue = match[2] || "";
      if (!seen.has(name)) {
        seen.add(name);
        matches.push({ name, defaultValue, value: defaultValue });
      }
    }
    return matches;
  };

  const handleSnippetClick = (snippet: Snippet) => {
    if (!activeTabId) return;

    const placeholders = parsePlaceholders(snippet.command_template);
    if (placeholders.length > 0) {
      setParamModal({ snippet, params: placeholders });
    } else {
      executeCommand(snippet.command_template, snippet.send_mode);
    }
  };

  const executeCommand = (cmd: string, mode: SendMode) => {
    if (!activeTabId) return;
    const finalCmd = mode === "execute" ? `${cmd}\n` : cmd;
    const bytes = new TextEncoder().encode(finalCmd);
    writeTerminal(activeTabId, bytes).catch(console.warn);
  };

  const handleApplyParams = () => {
    if (!paramModal || !activeTabId) return;
    let finalCmd = paramModal.snippet.command_template;
    for (const p of paramModal.params) {
      const val = p.value || p.defaultValue || "";
      const regex = new RegExp(`\\$\\{${p.name}(?::-.*?)?\\}`, "g");
      finalCmd = finalCmd.replace(regex, val);
    }
    executeCommand(finalCmd, paramModal.snippet.send_mode);
    setParamModal(null);
  };

  const handleCreateSnippet = async () => {
    if (!newName.trim() || !newCmd.trim()) return;
    await createSnippet({
      name: newName.trim(),
      command_template: newCmd.trim(),
      send_mode: newSendMode,
    });
    setNewName("");
    setNewCmd("");
    setCreateModal(false);
  };

  return (
    <div className="h-8 bg-surface-950 border-t border-surface-800 flex items-center px-3 gap-2 select-none overflow-x-auto text-xs shrink-0">
      <div className="flex items-center gap-1.5 text-slate-500 font-medium shrink-0">
        <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-[11px]">快捷命令:</span>
      </div>

      <div className="flex items-center gap-1.5 flex-1 overflow-x-auto no-scrollbar">
        {snippets.length === 0 ? (
          <span className="text-[11px] text-slate-600">点击右侧按钮添加常用命令片段</span>
        ) : (
          snippets.map((snip) => (
            <div
              key={snip.id}
              className="group flex items-center bg-surface-900 hover:bg-surface-800 border border-surface-800 rounded px-2 py-0.5 cursor-pointer transition shrink-0"
            >
              <button
                onClick={() => handleSnippetClick(snip)}
                title={snip.command_template}
                className="text-[11px] font-mono text-slate-300 hover:text-white mr-1 truncate max-w-[150px]"
              >
                {snip.name}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSnippet(snip.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 text-[10px] ml-1 transition"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <button
        onClick={() => setCreateModal(true)}
        className="px-2 py-0.5 rounded bg-surface-900 hover:bg-surface-800 border border-surface-800 text-[11px] text-slate-300 hover:text-white shrink-0 transition"
      >
        + 新增
      </button>

      {/* 参数占位符填充弹窗 */}
      {paramModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-96 bg-surface-900 border border-surface-700 rounded-xl p-5 shadow-2xl animate-in zoom-in-95">
            <h4 className="text-xs font-bold text-white mb-1">
              执行命令: {paramModal.snippet.name}
            </h4>
            <p className="text-[11px] text-slate-400 mb-4 font-mono bg-surface-950 p-2 rounded border border-surface-800 truncate">
              {paramModal.snippet.command_template}
            </p>

            <div className="space-y-3 mb-5">
              {paramModal.params.map((p, idx) => (
                <div key={p.name}>
                  <label className="block text-[11px] font-medium text-slate-300 mb-1">
                    参数 <span className="font-mono text-emerald-400">{p.name}</span>
                    {p.defaultValue && (
                      <span className="text-slate-500 text-[10px] ml-1">(默认: {p.defaultValue})</span>
                    )}
                  </label>
                  <input
                    type="text"
                    autoFocus={idx === 0}
                    placeholder={p.defaultValue}
                    value={p.value}
                    onChange={(e) => {
                      const updated = [...paramModal.params];
                      updated[idx].value = e.target.value;
                      setParamModal({ ...paramModal, params: updated });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleApplyParams();
                    }}
                    className="w-full px-2.5 py-1.5 bg-surface-950 border border-surface-700 rounded text-xs text-white outline-none focus:border-emerald-500 font-mono"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setParamModal(null)}
                className="px-3 py-1 bg-surface-800 text-slate-300 rounded text-xs hover:bg-surface-700"
              >
                取消
              </button>
              <button
                onClick={handleApplyParams}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-medium"
              >
                发送到终端
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建命令片段弹窗 */}
      {createModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-96 bg-surface-900 border border-surface-700 rounded-xl p-5 shadow-2xl animate-in zoom-in-95">
            <h4 className="text-xs font-bold text-white mb-3">创建快捷命令</h4>

            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-[11px] text-slate-300 mb-1">命令名称</label>
                <input
                  type="text"
                  placeholder="例如: 查看日志"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-surface-950 border border-surface-700 rounded text-xs text-white outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-300 mb-1">
                  命令模板 <span className="text-[10px] text-slate-500">(支持 ${"{"}VAR:-DEFAULT{"}"} 占位符)</span>
                </label>
                <textarea
                  placeholder="例如: tail -f -n ${LINES:-100} ${FILE}"
                  value={newCmd}
                  onChange={(e) => setNewCmd(e.target.value)}
                  rows={3}
                  className="w-full px-2.5 py-1.5 bg-surface-950 border border-surface-700 rounded text-xs font-mono text-white outline-none focus:border-emerald-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-300 mb-1">发送模式</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="sendMode"
                      checked={newSendMode === "execute"}
                      onChange={() => setNewSendMode("execute")}
                    />
                    <span>自动回车执行</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="radio"
                      name="sendMode"
                      checked={newSendMode === "insert"}
                      onChange={() => setNewSendMode("insert")}
                    />
                    <span>仅插入到命令行</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCreateModal(false)}
                className="px-3 py-1 bg-surface-800 text-slate-300 rounded text-xs hover:bg-surface-700"
              >
                取消
              </button>
              <button
                onClick={handleCreateSnippet}
                className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-medium"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
