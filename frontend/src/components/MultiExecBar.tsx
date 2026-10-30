import React, { useMemo, useState } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { sendSerial, writeTerminal } from "../lib/ipc";
import { Badge } from "./ui/Surface";
import { Button, IconButton } from "./ui/Button";
import { Input } from "./ui/Field";
import { ConfirmDialog } from "./ui/Overlay";
import { cn } from "./ui/cn";
import { ActivityIcon, CheckIcon, SendIcon, XIcon } from "./ui/icons";

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
  const connectedTabs = useMemo(
    () => tabs.filter((t) => t.status === "connected"),
    [tabs]
  );

  // 只记录「用户手动勾选过」的标签，实际生效的选中集在下面与已连接标签求交集。
  // 历史实现把初始快照直接塞进 state，标签关闭后 id 仍残留，
  // 会导致向已失效的 tabId 广播，并且全选按钮的文案永远错乱。
  const [pickedTabIds, setPickedTabIds] = useState<string[]>(() =>
    connectedTabs.map((t) => t.tabId)
  );
  const selectedTabIds = useMemo(() => {
    const live = new Set(connectedTabs.map((t) => t.tabId));
    return pickedTabIds.filter((id) => live.has(id));
  }, [pickedTabIds, connectedTabs]);
  const allSelected =
    connectedTabs.length > 0 && selectedTabIds.length === connectedTabs.length;

  const [command, setCommand] = useState("");
  const [dangerModal, setDangerModal] = useState<string | null>(null);

  const toggleSelectTab = (tabId: string) => {
    setPickedTabIds((prev) =>
      prev.includes(tabId) ? prev.filter((id) => id !== tabId) : [...prev, tabId]
    );
  };

  const handleSelectAll = () => {
    setPickedTabIds(allSelected ? [] : connectedTabs.map((t) => t.tabId));
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
    const selected = new Set(selectedTabIds);
    for (const tab of connectedTabs) {
      if (!selected.has(tab.tabId)) continue;
      if (tab.protocol === "serial") {
        // 串口会话没有 SSH PTY 通道，必须走串口发送接口，否则广播对它完全无效
        const serialBytes = new TextEncoder().encode(cmd + "\r\n");
        sendSerial(tab.cardId || tab.tabId, serialBytes).catch(console.warn);
      } else {
        const bytes = new TextEncoder().encode(cmd + "\n");
        writeTerminal(tab.tabId, bytes).catch(console.warn);
      }
    }
    setCommand("");
    setDangerModal(null);
  };

  return (
    <div className="shrink-0 select-none border-t border-line/10 bg-surface">
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {/* 顶部目标选择 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ActivityIcon className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span className="truncate text-os-xs font-semibold text-ink">多会话同步输入</span>
            <Badge className="font-mono">
              {selectedTabIds.length} / {connectedTabs.length}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              className="h-[22px] shrink-0 px-1.5 text-accent"
              onClick={handleSelectAll}
            >
              {allSelected ? "取消全选" : "全选"}
            </Button>
          </div>

          <IconButton label="关闭多会话输入" size="sm" onClick={onClose}>
            <XIcon className="h-3.5 w-3.5" />
          </IconButton>
        </div>

        {/* 终端选择 Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {connectedTabs.map((t) => {
            const isSelected = selectedTabIds.includes(t.tabId);
            return (
              <button
                key={t.tabId}
                type="button"
                onClick={() => toggleSelectTab(t.tabId)}
                className={cn(
                  "flex h-[24px] items-center gap-1 rounded-full border px-2.5 font-mono text-os-2xs",
                  "transition-[background-color,border-color,color] duration-os ease-os",
                  isSelected
                    ? "border-accent/30 bg-accent/10 font-semibold text-accent"
                    : "border-line/10 bg-surface text-ink-tertiary hover:border-line/20 hover:text-ink-secondary",
                )}
              >
                {isSelected && <CheckIcon className="h-3 w-3" />}
                <span className="max-w-[160px] truncate">{t.sessionName}</span>
              </button>
            );
          })}
          {connectedTabs.length === 0 && (
            <span className="text-os-2xs text-ink-tertiary">暂无已连接的终端会话</span>
          )}
        </div>

        {/* 命令输入框与执行按钮 */}
        <div className="flex items-center gap-2">
          <Input
            type="text"
            mono
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend();
            }}
            placeholder="输入命令，将同时发送到所选终端并回车..."
            className="flex-1"
          />
          <Button
            variant="primary"
            leading={<SendIcon className="h-3.5 w-3.5" />}
            disabled={!command.trim() || selectedTabIds.length === 0}
            onClick={handleSend}
          >
            广播执行
          </Button>
        </div>
      </div>

      {/* 危险命令警告弹窗 */}
      <ConfirmDialog
        open={dangerModal !== null}
        title="高危多机同步广播警告"
        tone="danger"
        confirmText="仍然广播执行"
        cancelText="取消执行"
        onCancel={() => setDangerModal(null)}
        onConfirm={() => {
          if (dangerModal) dispatchCommand(dangerModal);
        }}
        message={
          <div className="space-y-3">
            <p>
              您即将在{" "}
              <span className="font-mono font-semibold text-state-danger">
                {selectedTabIds.length}
              </span>{" "}
              台远端服务器上同时执行高危破坏性指令。
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-os-sm border border-state-danger/30 bg-state-danger/5 p-2.5 font-mono text-os-xs text-state-danger">
              {dangerModal}
            </pre>
          </div>
        }
      />
    </div>
  );
};
