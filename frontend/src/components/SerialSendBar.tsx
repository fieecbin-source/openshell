import React, { useState } from "react";
import { useSerialStore } from "../stores/serialStore";
import type { SerialNewlineMode } from "../types/ipc";
import { Button, IconButton } from "./ui/Button";
import { Input, Select } from "./ui/Field";
import { Checkbox, Segmented } from "./ui/Controls";
import { cn } from "./ui/cn";
import { PauseIcon, PlayIcon, PlusIcon, SendIcon, XIcon } from "./ui/icons";

interface SerialSendBarProps {
  cardId: string;
}

type SendMode = "ascii" | "hex";

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
    <div className="flex shrink-0 select-none flex-col gap-2 border-t border-line/10 bg-surface-muted p-2.5 text-os-xs">
      {/* 预设指令胶囊栏 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-os-2xs font-medium text-ink-tertiary">快捷片段</span>
        {snippets.map((sn) => (
          <div
            key={sn.id}
            className="group flex items-center rounded-full border border-line/10 bg-surface px-2 py-0.5 transition-colors duration-os hover:border-line/20"
          >
            <button
              type="button"
              onClick={() => sendSnippet(cardId, sn)}
              className="mr-1 font-mono text-os-2xs font-medium text-ink-secondary transition-colors duration-os hover:text-accent"
              title={`点击发送: ${sn.payload} (${sn.isHex ? "HEX" : "ASCII"})`}
            >
              {sn.name}
            </button>
            <IconButton
              label="删除片段"
              size="sm"
              className="h-[16px] w-[16px] text-ink-tertiary opacity-0 group-hover:opacity-100 hover:text-state-danger"
              onClick={() => removeSnippet(sn.id)}
            >
              <XIcon className="h-3 w-3" />
            </IconButton>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="h-[22px] border border-dashed border-line/20 px-2 text-os-2xs"
          leading={<PlusIcon className="h-3 w-3" />}
          onClick={() => setShowAddSnippet(!showAddSnippet)}
        >
          添加
        </Button>
      </div>

      {/* 新增片段快捷表单 */}
      {showAddSnippet && (
        <form
          onSubmit={handleCreateSnippet}
          className="flex flex-wrap items-center gap-2 rounded-os-md border border-line/10 bg-surface p-2"
        >
          <Input
            type="text"
            placeholder="名称 (如: 读取传感器)"
            value={newSnippetName}
            onChange={(e) => setNewSnippetName(e.target.value)}
            className="h-[28px] w-[160px] text-os-2xs"
          />
          <Input
            type="text"
            mono
            placeholder={newSnippetIsHex ? "HEX (如: 01 03 00 00)" : "内容 (如: AT+CSQ\\r\\n)"}
            value={newSnippetPayload}
            onChange={(e) => setNewSnippetPayload(e.target.value)}
            className="h-[28px] min-w-[160px] flex-1 text-os-2xs"
          />
          <Checkbox
            checked={newSnippetIsHex}
            onChange={setNewSnippetIsHex}
            label={<span className="text-os-2xs">HEX</span>}
            className="gap-1.5"
          />
          <Button type="submit" variant="primary" size="sm" className="h-[26px]">
            保存
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-[26px]"
            onClick={() => setShowAddSnippet(false)}
          >
            取消
          </Button>
        </form>
      )}

      {/* 主发送工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<SendMode>
          value={sendIsHex ? "hex" : "ascii"}
          onChange={(mode) => setSendIsHex(mode === "hex")}
          size="sm"
          ariaLabel="串口发送输入模式"
          options={[
            { value: "ascii", label: "ASCII" },
            { value: "hex", label: "HEX" },
          ]}
        />

        <Input
          type="text"
          mono
          value={sendText}
          onChange={(e) => setSendText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            sendIsHex
              ? "输入 HEX 字节（如 01 03 00 00 00 0A），回车发送"
              : "输入串口指令（按上下方向键切换历史），回车发送"
          }
          className="min-w-[200px] flex-1"
        />

        {/* 换行符映射选择器 */}
        {!sendIsHex && (
          <div className="w-[120px] shrink-0">
            <Select
              value={newlineMode}
              onChange={(e) => setNewlineMode(e.target.value as SerialNewlineMode)}
              className="h-[30px] text-os-2xs"
              title="追加换行符"
            >
              <option value="none">无换行</option>
              <option value="crlf">CRLF (\r\n)</option>
              <option value="lf">LF (\n)</option>
              <option value="cr">CR (\r)</option>
            </Select>
          </div>
        )}

        {/* 循环定时发送 */}
        <div className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-os-md border border-line/10 bg-surface px-2">
          <span className="text-os-2xs text-ink-tertiary">循环</span>
          <Input
            type="number"
            min={10}
            max={60000}
            step={100}
            value={timerIntervalMs}
            onChange={(e) => setTimerIntervalMs(parseInt(e.target.value) || 1000)}
            className="h-[22px] w-[56px] border-transparent bg-transparent px-1 text-right font-mono text-os-2xs tabular-nums"
          />
          <span className="text-os-2xs text-ink-tertiary">ms</span>
          <button
            type="button"
            onClick={() => (isTimerRunning ? stopTimer() : startTimer(cardId))}
            className={cn(
              "flex h-[20px] items-center gap-1 rounded-[6px] px-1.5 text-os-2xs font-semibold transition-colors duration-os",
              isTimerRunning
                ? "bg-state-danger text-white"
                : "bg-line/5 text-ink-secondary hover:bg-line/10",
            )}
            title={isTimerRunning ? "停止循环发送" : "启动循环发送"}
          >
            {isTimerRunning ? <PauseIcon className="h-2.5 w-2.5" /> : <PlayIcon className="h-2.5 w-2.5" />}
            {isTimerRunning ? "停止" : "启动"}
          </button>
        </div>

        <Button
          type="button"
          variant="primary"
          size="sm"
          leading={<SendIcon className="h-3.5 w-3.5" />}
          onClick={() => sendCurrent(cardId)}
        >
          发送
        </Button>
      </div>
    </div>
  );
};
