import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";
import {
  allThemes,
  resolveTheme,
  useSettingsStore,
  type ThemeMap,
} from "../stores/settingsStore";
import { useVaultStore } from "../stores/vaultStore";
import type { Session, SessionInput } from "../types/ipc";
import { Badge } from "./ui/Surface";
import { cn } from "./ui/cn";
import {
  ActivityIcon,
  ArrowUpDownIcon,
  CloudIcon,
  DatabaseIcon,
  LockIcon,
  PaletteIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  StarIcon,
  TerminalIcon,
} from "./ui/icons";

interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNewSession: (initialValues?: Partial<SessionInput>) => void;
  onOpenPortForward: () => void;
  onOpenSync: () => void;
  onOpenPortChecker: () => void;
  onOpenImportExport: () => void;
  onToggleMultiExec: () => void;
}

type PaletteItem =
  | { type: "quick_connect"; text: string; isSerial: boolean }
  | { type: "session"; session: Session }
  | { type: "action"; id: string; title: string; desc: string; icon: React.ReactNode; run: () => void }
  | { type: "theme"; theme: string };

interface PaletteSection {
  key: string;
  label: string;
  items: PaletteItem[];
}

export const CommandPaletteModal: React.FC<CommandPaletteModalProps> = ({
  isOpen,
  onClose,
  onNewSession,
  onOpenPortForward,
  onOpenSync,
  onOpenPortChecker,
  onOpenImportExport,
  onToggleMultiExec,
}) => {
  const { sessions } = useSessionStore();
  const { openSession } = useTerminalStore();
  const { setTheme, setSettingsModalOpen, customThemes } = useSettingsStore();
  const { status: vaultStatus, lock: lockVault } = useVaultStore();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, onClose]);

  const trimmed = query.trim().toLowerCase();

  const sections = useMemo<PaletteSection[]>(() => {
    if (!isOpen) return [];

    const isSshPattern =
      trimmed.includes("@") ||
      /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::\d+)?$/.test(trimmed) ||
      trimmed.startsWith("ssh ");
    const isSerialPattern = /^com\d+$/i.test(trimmed);

    const quickItems: PaletteItem[] = [];
    if (query.trim() && (isSshPattern || isSerialPattern)) {
      quickItems.push({
        type: "quick_connect",
        text: query.trim(),
        isSerial: isSerialPattern,
      });
    }

    const sessionItems: PaletteItem[] = sessions
      .filter(
        (s) =>
          s.name.toLowerCase().includes(trimmed) ||
          (s.host && s.host.toLowerCase().includes(trimmed)) ||
          (s.username && s.username.toLowerCase().includes(trimmed)),
      )
      .slice(0, 8)
      .map((session) => ({ type: "session", session }));

    const actions: PaletteItem[] = [
      {
        type: "action",
        id: "act_new_session",
        title: "新建连接会话",
        desc: "创建 SSH 或串口连接配置",
        icon: <PlusIcon className="h-4 w-4" />,
        run: () => onNewSession(),
      },
      {
        type: "action",
        id: "act_port_forward",
        title: "端口转发与隧道",
        desc: "本地 / 远端 / 动态 SOCKS 转发",
        icon: <ArrowUpDownIcon className="h-4 w-4" />,
        run: onOpenPortForward,
      },
      {
        type: "action",
        id: "act_multi_exec",
        title: "切换多会话同步输入",
        desc: "向多个终端广播同一条命令",
        icon: <SendIcon className="h-4 w-4" />,
        run: onToggleMultiExec,
      },
      {
        type: "action",
        id: "act_port_checker",
        title: "网络连通探测",
        desc: "测试远程主机端口存活与延迟",
        icon: <ActivityIcon className="h-4 w-4" />,
        run: onOpenPortChecker,
      },
      {
        type: "action",
        id: "act_sync",
        title: "端到端同步设置",
        desc: "多设备会话密文同步与自建端点",
        icon: <CloudIcon className="h-4 w-4" />,
        run: onOpenSync,
      },
      {
        type: "action",
        id: "act_import_export",
        title: "导入 / 导出备份",
        desc: "导入 OpenSSH、FinalShell 配置或导出 JSON",
        icon: <DatabaseIcon className="h-4 w-4" />,
        run: onOpenImportExport,
      },
      {
        type: "action",
        id: "act_settings",
        title: "系统偏好设置",
        desc: "字体、外观、终端行为与主题",
        icon: <SettingsIcon className="h-4 w-4" />,
        run: () => setSettingsModalOpen(true),
      },
    ];

    if (vaultStatus?.state === "unlocked") {
      actions.push({
        type: "action",
        id: "act_lock_vault",
        title: "立即锁定主保险库",
        desc: "锁闭所有凭据与密钥",
        icon: <LockIcon className="h-4 w-4" />,
        run: lockVault,
      });
    }

    const actionItems = actions.filter(
      (action) =>
        action.type === "action" &&
        (action.title.toLowerCase().includes(trimmed) ||
          action.desc.toLowerCase().includes(trimmed)),
    );

    const themeItems: PaletteItem[] = Object.entries(allThemes(customThemes))
      .filter(([, config]) => config.name.toLowerCase().includes(trimmed))
      .map(([key]) => ({ type: "theme", theme: key }));

    return [
      { key: "quick", label: "快速连接", items: quickItems },
      { key: "sessions", label: "会话", items: sessionItems },
      { key: "actions", label: "操作", items: actionItems },
      { key: "themes", label: "终端主题", items: themeItems },
    ].filter((section) => section.items.length > 0);
  }, [
    isOpen,
    trimmed,
    query,
    sessions,
    vaultStatus,
    customThemes,
    setSettingsModalOpen,
    lockVault,
    onNewSession,
    onOpenPortForward,
    onOpenSync,
    onOpenPortChecker,
    onOpenImportExport,
    onToggleMultiExec,
  ]);

  const flatItems = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, selectedIndex]);

  if (!isOpen) return null;

  const handleSelect = async (item: PaletteItem | undefined) => {
    if (!item) return;

    if (item.type === "quick_connect") {
      if (item.isSerial) {
        onClose();
        onNewSession({
          protocol: "serial",
          name: `Serial-${item.text.toUpperCase()}`,
          protocol_options_json: { port_name: item.text.toUpperCase(), baud_rate: 115200 },
        });
      } else {
        // 解析 SSH: [ssh ]user@host:port
        const clean = item.text.replace(/^ssh\s+/i, "").trim();
        let user = "root";
        let host = clean;
        let port = 22;
        if (clean.includes("@")) {
          const parts = clean.split("@");
          user = parts[0];
          host = parts[1];
        }
        if (host.includes(":")) {
          const parts = host.split(":");
          host = parts[0];
          port = parseInt(parts[1], 10) || 22;
        }
        onClose();
        onNewSession({
          protocol: "ssh",
          name: `${user}@${host}:${port}`,
          username: user,
          host,
          port,
        });
      }
      return;
    }

    if (item.type === "session") {
      onClose();
      await openSession(item.session);
      return;
    }

    if (item.type === "action") {
      onClose();
      item.run();
      return;
    }

    if (item.type === "theme") {
      await setTheme(item.theme);
      onClose();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, flatItems.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + flatItems.length) % Math.max(1, flatItems.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      handleSelect(flatItems[selectedIndex]);
    }
  };

  let runningIndex = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-line/20 px-4 pt-20 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-os-xl border border-line/10 bg-surface shadow-os-lg animate-[fade-in_180ms_var(--os-ease)]"
      >
        <div className="flex items-center gap-2.5 border-b border-line/10 px-4 py-3">
          <SearchIcon className="h-4 w-4 shrink-0 text-ink-tertiary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索会话、执行操作，或输入 root@192.168.1.1 快速连接"
            className="w-full bg-transparent text-os-sm text-ink placeholder:text-ink-tertiary focus:outline-none"
          />
          <kbd className="shrink-0 rounded-[5px] border border-line/10 bg-surface-muted px-1.5 py-px font-mono text-os-2xs text-ink-tertiary">
            ESC
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-2">
          {flatItems.length === 0 ? (
            <div className="px-4 py-10 text-center text-os-xs text-ink-tertiary">
              未找到匹配内容，可直接输入{" "}
              <span className="font-mono text-accent">root@host:port</span> 快速连接
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key} className="mb-1.5 last:mb-0">
                <div className="px-2 py-1 text-os-2xs font-medium text-ink-tertiary">
                  {section.label}
                </div>
                {section.items.map((item) => {
                  runningIndex += 1;
                  const index = runningIndex;
                  const selected = index === selectedIndex;
                  return (
                    <div
                      key={itemKey(item, index)}
                      role="option"
                      aria-selected={selected}
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={cn(
                        "flex cursor-pointer items-center justify-between gap-3 rounded-os-md px-2.5 py-2 text-os-xs transition-colors duration-os",
                        selected
                          ? "bg-accent/10 text-ink"
                          : "text-ink-secondary hover:bg-line/5 hover:text-ink",
                      )}
                    >
                      {renderItem(item, customThemes)}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line/10 bg-surface-muted px-4 py-2 text-os-2xs text-ink-tertiary">
          <div className="flex items-center gap-3">
            <span>↑↓ 导航</span>
            <span>Enter 确认</span>
            <span>Esc 关闭</span>
          </div>
          <span className="font-medium text-accent">Ctrl K</span>
        </div>
      </div>
    </div>
  );
};

function itemKey(item: PaletteItem, index: number): string {
  if (item.type === "quick_connect") return `quick-${index}`;
  if (item.type === "session") return `session-${item.session.id}`;
  if (item.type === "action") return item.id;
  return `theme-${item.theme}`;
}

function renderItem(item: PaletteItem, customThemes: ThemeMap): React.ReactNode {
  if (item.type === "quick_connect") {
    return (
      <>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-os-sm bg-accent/10 text-accent">
            {item.isSerial ? <PlugIcon className="h-3.5 w-3.5" /> : <TerminalIcon className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">
              快速连接 <span className="font-mono text-accent">{item.text}</span>
            </div>
            <div className="text-os-2xs text-ink-tertiary">
              {item.isSerial ? "打开本地串口连接" : "解析地址并新建 SSH 会话"}
            </div>
          </div>
        </div>
        <Badge tone="accent">新建</Badge>
      </>
    );
  }

  if (item.type === "session") {
    const session = item.session;
    return (
      <>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-os-sm border border-line/10 bg-surface text-ink-tertiary">
            {session.protocol === "serial" ? (
              <PlugIcon className="h-3.5 w-3.5" />
            ) : (
              <TerminalIcon className="h-3.5 w-3.5" />
            )}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-ink">{session.name}</span>
              {session.favorite && <StarIcon className="h-3 w-3 shrink-0 text-state-warning" />}
            </div>
            <div className="truncate font-mono text-os-2xs text-ink-tertiary">
              {session.protocol === "serial"
                ? session.protocol_options_json?.port_name || "COM1"
                : `${session.username || "root"}@${session.host || "localhost"}:${session.port || 22}`}
            </div>
          </div>
        </div>
        <span className="shrink-0 text-os-2xs text-ink-tertiary">连接</span>
      </>
    );
  }

  if (item.type === "action") {
    return (
      <>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-os-sm border border-line/10 bg-surface text-ink-tertiary">
            {item.icon}
          </span>
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{item.title}</div>
            <div className="truncate text-os-2xs text-ink-tertiary">{item.desc}</div>
          </div>
        </div>
        <PencilIcon className="h-3 w-3 shrink-0 opacity-0" />
      </>
    );
  }

  const terminalTheme = resolveTheme(item.theme, customThemes);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-line/20"
          style={{ backgroundColor: terminalTheme.background }}
        />
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">{terminalTheme.name}</div>
          <div className="text-os-2xs text-ink-tertiary">终端主题</div>
        </div>
      </div>
      <PaletteIcon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
    </>
  );
}
