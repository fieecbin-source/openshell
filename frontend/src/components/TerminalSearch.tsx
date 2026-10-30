import React, { useEffect, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { IconButton } from "./ui/Button";
import { cn } from "./ui/cn";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "./ui/icons";

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
    searchAddon.findNext(query, { caseSensitive, regex: useRegex, wholeWord });
  };

  const handlePrevious = () => {
    if (!searchAddon || !query) return;
    searchAddon.findPrevious(query, { caseSensitive, regex: useRegex, wholeWord });
  };

  const toggleClass = (active: boolean) =>
    cn(
      "px-1.5 py-0.5 font-mono text-[11px] transition-colors duration-os rounded-[5px]",
      active
        ? "bg-accent/10 text-accent"
        : "text-ink-tertiary hover:bg-line/5 hover:text-ink-secondary",
    );

  return (
    <div className="absolute right-4 top-2 z-30 flex items-center gap-1.5 rounded-os-md border border-line/10 bg-surface/95 p-1.5 shadow-os-md backdrop-blur-md animate-[fade-in_180ms_var(--os-ease)]">
      <div className="flex h-[26px] items-center gap-1.5 rounded-os-sm border border-line/10 bg-surface-muted px-2">
        <SearchIcon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
        <input
          type="text"
          autoFocus
          placeholder="搜索终端内容..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (event.shiftKey) handlePrevious();
              else handleNext();
            } else if (event.key === "Escape") {
              onClose();
            }
          }}
          className="w-44 bg-transparent font-mono text-os-xs text-ink placeholder:text-ink-tertiary focus:outline-none"
        />
      </div>

      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => setCaseSensitive(!caseSensitive)}
          title="区分大小写"
          aria-pressed={caseSensitive}
          className={toggleClass(caseSensitive)}
        >
          Aa
        </button>
        <button
          type="button"
          onClick={() => setUseRegex(!useRegex)}
          title="使用正则表达式"
          aria-pressed={useRegex}
          className={toggleClass(useRegex)}
        >
          .*
        </button>
        <button
          type="button"
          onClick={() => setWholeWord(!wholeWord)}
          title="全字匹配"
          aria-pressed={wholeWord}
          className={toggleClass(wholeWord)}
        >
          \b
        </button>
      </div>

      <span className="h-4 w-px bg-line/10" />

      <IconButton label="上一个 (Shift+Enter)" size="sm" className="h-[24px] w-[24px]" onClick={handlePrevious}>
        <ChevronUpIcon className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="下一个 (Enter)" size="sm" className="h-[24px] w-[24px]" onClick={handleNext}>
        <ChevronDownIcon className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton label="关闭 (Esc)" size="sm" className="h-[24px] w-[24px]" onClick={onClose}>
        <XIcon className="h-3.5 w-3.5" />
      </IconButton>
    </div>
  );
};
