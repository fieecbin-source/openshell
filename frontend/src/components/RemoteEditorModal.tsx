import React, { useEffect } from "react";
import { useSftpStore } from "../stores/sftpStore";

export const RemoteEditorModal: React.FC = () => {
  const { editor, updateEditorContent, saveEditor, closeEditor } = useSftpStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveEditor();
      } else if (e.key === "Escape") {
        closeEditor();
      }
    };
    if (editor.open) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [editor.open, saveEditor, closeEditor]);

  if (!editor.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6">
      <div className="w-full max-w-4xl h-[85vh] bg-surface-900 border border-surface-700/80 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 顶部标题栏 */}
        <div className="h-12 px-5 border-b border-surface-800 flex items-center justify-between bg-surface-950/80">
          <div className="flex items-center gap-2 truncate">
            <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <span className="text-xs font-semibold text-slate-200">远端文件在线编辑</span>
            <span className="text-xs font-mono text-slate-400 bg-surface-800 px-2 py-0.5 rounded truncate max-w-md">
              {editor.path}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500 mr-2">支持 Ctrl+S 保存</span>
            <button
              onClick={saveEditor}
              disabled={editor.saving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-lg shadow-sm transition disabled:opacity-50"
            >
              {editor.saving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>保存中...</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>保存</span>
                </>
              )}
            </button>
            <button
              onClick={closeEditor}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-surface-800 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {editor.error && (
          <div className="bg-red-500/10 border-b border-red-500/20 px-4 py-2 text-xs text-red-400 flex items-center justify-between">
            <span>{editor.error}</span>
          </div>
        )}

        {/* 编辑区域 */}
        <div className="flex-1 p-3 bg-surface-950 flex flex-col">
          <textarea
            value={editor.content}
            onChange={(e) => updateEditorContent(e.target.value)}
            className="flex-1 w-full p-4 bg-surface-900/60 border border-surface-800 rounded-xl font-mono text-xs text-slate-200 resize-none outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 leading-relaxed"
            placeholder="输入文件内容..."
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
};
