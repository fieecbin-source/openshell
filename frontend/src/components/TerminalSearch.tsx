import React, { useEffect, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";

interface TerminalSearchProps {
  searchAddon: SearchAddon | null;
  onClose: () => void;
}

export const TerminalSearch: React.FC<TerminalSearchProps> = ({ searchAddon, onClose }) => {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);

  useEffect(() => {
    if (!searchAddon || !query) return;
    searchAddon.findNext(query, {
      caseSensitive,
      regex: useRegex,
      wholeWord,
      incremental: true,
    });
  }, [query, caseSensitive, useRegex, wholeWord, searchAddon]);

  const handleNext = () => {
    if (!searchAddon || !query) return;
    searchAddon.findNext(query, {
      caseSensitive,
      regex: useRegex,
      wholeWord,
    });
  };

  const handlePrevious = () => {
    if (!searchAddon || !query) return;
    searchAddon.findPrevious(query, {
      caseSensitive,
      regex: useRegex,
      wholeWord,
    });
  };

  return (
    <div className="absolute top-2 right-4 z-30 bg-surface-900 border border-surface-700 rounded-xl shadow-2xl p-1.5 flex items-center gap-1.5 backdrop-blur-md animate-in slide-in-from-top-2">
      <div className="flex items-center bg-surface-950 border border-surface-800 rounded-lg px-2 py-1">
        <svg className="w-3.5 h-3.5 text-slate-500 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          autoFocus
          placeholder="搜索终端内容..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (e.shiftKey) handlePrevious();
              else handleNext();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          className="bg-transparent text-xs text-white placeholder-slate-600 outline-none w-48 font-mono"
        />
      </div>

      {/* 搜索修饰符 */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => setCaseSensitive(!caseSensitive)}
          title="区分大小写"
          className={`px-1.5 py-0.5 rounded text-[11px] font-mono transition ${
            caseSensitive
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          Aa
        </button>
        <button
          onClick={() => setUseRegex(!useRegex)}
          title="使用正则表达式"
          className={`px-1.5 py-0.5 rounded text-[11px] font-mono transition ${
            useRegex
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          .*
        </button>
        <button
          onClick={() => setWholeWord(!wholeWord)}
          title="全字匹配"
          className={`px-1.5 py-0.5 rounded text-[11px] font-mono transition ${
            wholeWord
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "text-slate-500 hover:text-slate-300"
          }`}
        >
          \b
        </button>
      </div>

      <div className="h-4 w-px bg-surface-800" />

      {/* 上一个 / 下一个导航 */}
      <button
        onClick={handlePrevious}
        title="上一个 (Shift+Enter)"
        className="p-1 text-slate-400 hover:text-white rounded hover:bg-surface-800 transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
      <button
        onClick={handleNext}
        title="下一个 (Enter)"
        className="p-1 text-slate-400 hover:text-white rounded hover:bg-surface-800 transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <button
        onClick={onClose}
        title="关闭 (Esc)"
        className="p-1 text-slate-400 hover:text-white rounded hover:bg-surface-800 transition"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
};
