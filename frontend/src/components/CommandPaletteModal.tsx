import React, { useState, useEffect, useRef } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore, THEMES, type TerminalTheme } from "../stores/settingsStore";
import { useVaultStore } from "../stores/vaultStore";
import type { Session, SessionInput } from "../types/ipc";

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
  const { theme, setTheme, setSettingsModalOpen } = useSettingsStore();
  const { status: vaultStatus, lock: lockVault } = useVaultStore();

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmed = query.trim();

  // 解析是否为直连模式：如 root@192.168.1.1 或 192.168.1.1:22 或 COM1
  const isSshPattern =
    trimmed.includes("@") ||
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::\d+)?$/.test(trimmed) ||
    trimmed.startsWith("ssh ");
  const isSerialPattern = /^com\d+$/i.test(trimmed);

  // 1. 过滤已保存会话
  const matchedSessions = sessions.filter(
    (s) =>
      s.name.toLowerCase().includes(trimmed.toLowerCase()) ||
      (s.host && s.host.toLowerCase().includes(trimmed.toLowerCase())) ||
      (s.username && s.username.toLowerCase().includes(trimmed.toLowerCase()))
  );

  // 2. 预置快捷操作
  const systemActions = [
    {
      id: "act_new_session",
      title: "新建连接会话...",
      desc: "创建 SSH 或串口长连接配置",
      icon: "➕",
      action: () => {
        onClose();
        onNewSession();
      },
    },
    {
      id: "act_port_forward",
      title: "端口转发与隧道管理器...",
      desc: "本地 / 远端 / 动态 SOCKS 转发",
      icon: "🔀",
      action: () => {
        onClose();
        onOpenPortForward();
      },
    },
    {
      id: "act_multi_exec",
      title: "切换多会话同步输入栏",
      desc: "一键向所有或选定终端广播命令",
      icon: "⚡",
      action: () => {
        onClose();
        onToggleMultiExec();
      },
    },
    {
      id: "act_port_checker",
      title: "网络连通探测与延迟测试 (Ping / TCP)...",
      desc: "测试远程主机端口存活与响应时间",
      icon: "🌐",
      action: () => {
        onClose();
        onOpenPortChecker();
      },
    },
    {
      id: "act_sync",
      title: "E2EE 端到端同步与备份设置...",
      desc: "多设备会话密文同步、自建端点配置",
      icon: "☁️",
      action: () => {
        onClose();
        onOpenSync();
      },
    },
    {
      id: "act_import_export",
      title: "导入 / 导出备份包...",
      desc: "导入 OpenSSH、FinalShell 配置或导出 JSON 备份",
      icon: "📦",
      action: () => {
        onClose();
        onOpenImportExport();
      },
    },
    {
      id: "act_settings",
      title: "系统偏好设置与主题配置...",
      desc: "修改字体、外观、终端行为与主题",
      icon: "⚙️",
      action: () => {
        onClose();
        setSettingsModalOpen(true);
      },
    },
  ];

  if (vaultStatus?.state === "unlocked") {
    systemActions.push({
      id: "act_lock_vault",
      title: "立即锁定主保险库",
      desc: "安全锁闭所有凭据与密钥",
      icon: "🔒",
      action: () => {
        onClose();
        lockVault();
      },
    });
  }

  const matchedActions = systemActions.filter(
    (a) =>
      a.title.toLowerCase().includes(trimmed.toLowerCase()) ||
      a.desc.toLowerCase().includes(trimmed.toLowerCase())
  );

  // 3. 配色主题切换候选
  const themeCandidates = (Object.keys(THEMES) as TerminalTheme[]).filter((key) =>
    THEMES[key].name.toLowerCase().includes(trimmed.toLowerCase())
  );

  // 整合所有可选项目
  const allItems: Array<{
    type: "quick_connect" | "session" | "action" | "theme";
    data: any;
  }> = [];

  // 如果输入了快速连接表达式
  if (trimmed && (isSshPattern || isSerialPattern)) {
    allItems.push({
      type: "quick_connect",
      data: { text: trimmed, isSerial: isSerialPattern },
    });
  }

  // 会话列表
  matchedSessions.slice(0, 8).forEach((s) => {
    allItems.push({ type: "session", data: s });
  });

  // 快捷动作
  matchedActions.forEach((a) => {
    allItems.push({ type: "action", data: a });
  });

  // 主题候选
  themeCandidates.forEach((t) => {
    allItems.push({ type: "theme", data: t });
  });

  const handleSelect = async (item: typeof allItems[0]) => {
    if (!item) return;

    if (item.type === "quick_connect") {
      const text = item.data.text as string;
      if (item.data.isSerial) {
        // 直连串口
        onClose();
        onNewSession({
          protocol: "serial",
          name: `Serial-${text.toUpperCase()}`,
          protocol_options_json: { port_name: text.toUpperCase(), baud_rate: 115200 },
        });
      } else {
        // 解析 SSH: [ssh ]user@host:port
        let clean = text.replace(/^ssh\s+/i, "").trim();
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
    } else if (item.type === "session") {
      onClose();
      await openSession(item.data as Session);
    } else if (item.type === "action") {
      item.data.action();
    } else if (item.type === "theme") {
      await setTheme(item.data as TerminalTheme);
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, allItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + allItems.length) % Math.max(1, allItems.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (allItems[selectedIndex]) {
        handleSelect(allItems[selectedIndex]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/25 backdrop-blur-sm p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-black/10 bg-white/95 shadow-apple-xl backdrop-blur-xl flex flex-col overflow-hidden text-slate-800"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 输入框 */}
        <div className="flex items-center px-4 py-3.5 border-b border-slate-100 gap-3">
          <svg
            className="w-4 h-4 text-apple-blue shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="搜索会话、执行命令，或输入 root@192.168.1.1 快速直连..."
            className="w-full bg-transparent text-sm text-slate-900 placeholder-slate-400 focus:outline-none"
          />
          <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 border border-slate-200 rounded-md text-slate-400 shrink-0">
            ESC
          </kbd>
        </div>

        {/* 候选列表 */}
        <div className="max-h-[60vh] overflow-y-auto p-2 space-y-1">
          {allItems.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400">
              未找到匹配会话或命令，可直接输入 <span className="text-apple-blue font-mono font-medium">root@host:port</span> 快速连接
            </div>
          ) : (
            allItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;

              if (item.type === "quick_connect") {
                return (
                  <div
                    key="quick_connect"
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer text-xs transition ${
                      isSelected
                        ? "bg-apple-blue text-white shadow-apple-sm"
                        : "bg-apple-blue/5 text-apple-blue border border-apple-blue/20"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base">⚡</span>
                      <div>
                        <div className="font-bold">
                          快速直连并新建会话: <span className="font-mono underline">{item.data.text}</span>
                        </div>
                        <div className="text-[11px] opacity-85">
                          {item.data.isSerial
                            ? "立即打开本地串口通信会话"
                            : "解析地址并录入 SSH 主机连接属性"}
                        </div>
                      </div>
                    </div>
                    <span className="text-[10px] font-mono opacity-80">Enter ↵</span>
                  </div>
                );
              }

              if (item.type === "session") {
                const s = item.data as Session;
                return (
                  <div
                    key={s.id}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer text-xs transition ${
                      isSelected
                        ? "bg-apple-blue text-white shadow-apple-sm"
                        : "text-slate-800 hover:bg-slate-100"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 truncate">
                      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs ${
                        isSelected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"
                      }`}>
                        {s.protocol === "serial" ? "🔌" : "⚡"}
                      </span>
                      <div className="truncate">
                        <div className="font-semibold truncate flex items-center gap-1.5">
                          <span>{s.name}</span>
                          {s.favorite && <span className="text-[10px] text-apple-orange">★</span>}
                        </div>
                        <div className={`text-[10px] truncate font-mono ${isSelected ? "text-white/80" : "text-slate-400"}`}>
                          {s.protocol === "serial"
                            ? s.protocol_options_json?.port_name || "COM1"
                            : `${s.username || "root"}@${s.host || "localhost"}:${s.port || 22}`}
                        </div>
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono ${isSelected ? "text-white/80" : "text-slate-400"}`}>连接</span>
                  </div>
                );
              }

              if (item.type === "action") {
                const a = item.data;
                return (
                  <div
                    key={a.id}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer text-xs transition ${
                      isSelected
                        ? "bg-apple-blue text-white shadow-apple-sm"
                        : "text-slate-800 hover:bg-slate-100"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-base shrink-0">{a.icon}</span>
                      <div>
                        <div className="font-semibold">{a.title}</div>
                        <div className={`text-[10px] ${isSelected ? "text-white/80" : "text-slate-500"}`}>{a.desc}</div>
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono ${isSelected ? "text-white/80" : "text-slate-400"}`}>操作</span>
                  </div>
                );
              }

              if (item.type === "theme") {
                const themeKey = item.data as TerminalTheme;
                const t = THEMES[themeKey];
                const isCurrent = theme === themeKey;
                return (
                  <div
                    key={themeKey}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer text-xs transition ${
                      isSelected
                        ? "bg-apple-blue text-white shadow-apple-sm"
                        : "text-slate-800 hover:bg-slate-100"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span
                        className="w-3.5 h-3.5 rounded-full border border-slate-300 shrink-0"
                        style={{ backgroundColor: t.background }}
                      />
                      <span className="font-semibold">
                        终端主题: {t.name} {isCurrent && "(当前)"}
                      </span>
                    </div>
                    <span className={`text-[10px] font-mono ${isSelected ? "text-white/80" : "text-slate-400"}`}>主题</span>
                  </div>
                );
              }

              return null;
            })
          )}
        </div>

        {/* 底部按键提示 */}
        <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
          <div className="flex items-center gap-3">
            <span>↑↓ 导航</span>
            <span>↵ 确认选择</span>
            <span>ESC 关闭</span>
          </div>
          <span className="font-medium text-apple-blue">⌘K 全局搜索</span>
        </div>
      </div>
    </div>
  );
};
