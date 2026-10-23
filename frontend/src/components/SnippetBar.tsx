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
    <div className="h-8 bg-[#f5f5f7] border-b border-slate-200/80 flex items-center px-3 gap-2 select-none overflow-x-auto text-xs shrink-0">
      <div className="flex items-center gap-1.5 text-slate-500 font-medium shrink-0">
        <svg className="w-3.5 h-3.5 text-apple-orange" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-[11px] font-semibold text-slate-700">快捷片段:</span>
      </div>

      <div className="flex items-center gap-1.5 flex-1 overflow-x-auto no-scrollbar">
        {snippets.length === 0 ? (
          <span className="text-[11px] text-slate-400">点击右侧按钮添加常用命令快捷方式</span>
        ) : (
          snippets.map((snip) => (
            <div
              key={snip.id}
              className="group flex items-center bg-white hover:bg-slate-50 border border-slate-200/80 rounded-lg px-2 py-0.5 cursor-pointer transition shrink-0 shadow-apple-sm"
            >
              <button
                onClick={() => handleSnippetClick(snip)}
                title={snip.command_template}
                className="text-[11px] font-mono text-slate-700 hover:text-apple-blue mr-1 truncate max-w-[150px] font-medium"
              >
                {snip.name}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSnippet(snip.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-apple-red text-[10px] ml-1 transition"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      <button
        onClick={() => setCreateModal(true)}
        className="px-2 py-0.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-200/80 text-[11px] text-slate-700 font-medium shrink-0 transition shadow-apple-sm"
      >
        + 新增
      </button>

      {/* 参数占位符填充弹窗 */}
      {paramModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm p-4">
          <div className="w-96 bg-white border border-black/10 rounded-2xl p-5 shadow-apple-xl animate-in zoom-in-95 text-slate-800">
            <h4 className="text-xs font-bold text-slate-900 mb-1">
              执行命令: {paramModal.snippet.name}
            </h4>
            <p className="text-[11px] text-slate-600 mb-4 font-mono bg-slate-50 p-2 rounded-xl border border-slate-200/80 truncate">
              {paramModal.snippet.command_template}
            </p>

            <div className="space-y-3 mb-5">
              {paramModal.params.map((p, idx) => (
                <div key={p.name}>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    参数 <span className="font-mono text-apple-blue">{p.name}</span>
                    {p.defaultValue && (
                      <span className="text-slate-400 text-[10px] ml-1">(默认: {p.defaultValue})</span>
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
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 outline-none focus:border-apple-blue focus:ring-1 focus:ring-apple-blue font-mono"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setParamModal(null)}
                className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded-xl text-xs hover:bg-slate-100 transition"
              >
                取消
              </button>
              <button
                onClick={handleApplyParams}
                className="px-3.5 py-1.5 bg-apple-blue hover:bg-apple-hoverBlue text-white rounded-xl text-xs font-semibold shadow-apple-sm transition"
              >
                发送到终端
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建命令片段弹窗 */}
      {createModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm p-4">
          <div className="w-96 bg-white border border-black/10 rounded-2xl p-5 shadow-apple-xl animate-in zoom-in-95 text-slate-800">
            <h4 className="text-sm font-bold text-slate-900 mb-3 tracking-tight">创建快捷命令</h4>

            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">命令名称</label>
                <input
                  type="text"
                  placeholder="例如: 查看日志"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 outline-none focus:border-apple-blue focus:ring-1 focus:ring-apple-blue"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  命令模板 <span className="text-[10px] text-slate-400">(支持 ${"{"}VAR:-DEFAULT{"}"} 占位符)</span>
                </label>
                <textarea
                  placeholder="例如: tail -f -n ${LINES:-100} ${FILE}"
                  value={newCmd}
                  onChange={(e) => setNewCmd(e.target.value)}
                  rows={3}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-mono text-slate-900 outline-none focus:border-apple-blue focus:ring-1 focus:ring-apple-blue resize-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">发送模式</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="radio"
                      name="sendMode"
                      checked={newSendMode === "execute"}
                      onChange={() => setNewSendMode("execute")}
                      className="text-apple-blue focus:ring-apple-blue"
                    />
                    <span>自动回车执行</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="radio"
                      name="sendMode"
                      checked={newSendMode === "insert"}
                      onChange={() => setNewSendMode("insert")}
                      className="text-apple-blue focus:ring-apple-blue"
                    />
                    <span>仅插入到命令行</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setCreateModal(false)}
                className="px-3 py-1.5 border border-slate-200 text-slate-600 rounded-xl text-xs hover:bg-slate-100 transition"
              >
                取消
              </button>
              <button
                onClick={handleCreateSnippet}
                className="px-3.5 py-1.5 bg-apple-blue hover:bg-apple-hoverBlue text-white rounded-xl text-xs font-semibold shadow-apple-sm transition"
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
