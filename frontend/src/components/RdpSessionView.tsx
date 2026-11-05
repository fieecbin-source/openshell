import React, { useCallback } from "react";
import type { RdpProtocolOptions, Session } from "../types/ipc";
import type { TerminalTab } from "../stores/terminalStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSessionStore } from "../stores/sessionStore";
import { toast } from "../stores/toastStore";
import {
  ActivityIcon,
  CopyIcon,
  MonitorIcon,
  PlayIcon,
  RefreshIcon,
  SettingsIcon,
} from "./ui/icons";
import { cn } from "./ui/cn";

interface RdpSessionViewProps {
  tab: TerminalTab;
  /** 直接打开 SessionModal 编辑当前 RDP 会话配置 */
  onEditSession?: (session: Session) => void;
  /** 打开连接详情与诊断面板 */
  onOpenConnectionDetails?: () => void;
}

const STATUS_META: Record<
  string,
  { label: string; dot: string; text: string; tone: string }
> = {
  connecting: {
    label: "正在唤起远程桌面客户端…",
    dot: "bg-state-warning animate-pulse",
    text: "text-state-warning",
    tone: "border-state-warning/30 bg-state-warning/10",
  },
  connected: {
    label: "已唤起 Windows 远程桌面客户端 (mstsc.exe)",
    dot: "bg-state-success",
    text: "text-state-success",
    tone: "border-state-success/30 bg-state-success/10",
  },
  error: {
    label: "远程桌面启动失败",
    dot: "bg-state-danger",
    text: "text-state-danger",
    tone: "border-state-danger/30 bg-state-danger/10",
  },
  disconnected: {
    label: "远程桌面会话已结束",
    dot: "bg-state-danger",
    text: "text-state-danger",
    tone: "border-state-danger/30 bg-state-danger/10",
  },
  reconnecting: {
    label: "正在重新唤起远程桌面客户端…",
    dot: "bg-state-warning animate-pulse",
    text: "text-state-warning",
    tone: "border-state-warning/30 bg-state-warning/10",
  },
};

const BadgePill: React.FC<{ children: React.ReactNode; tone?: "accent" | "muted" }> = ({
  children,
  tone = "muted",
}) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold",
      tone === "accent"
        ? "border-accent/30 bg-accent/10 text-accent"
        : "border-line/15 bg-surface text-ink-secondary"
    )}
  >
    {children}
  </span>
);

/**
 * Windows 远程桌面会话面板。
 *
 * RDP 由系统 `mstsc.exe` 承载，无法嵌入 webview 渲染，
 * 因此标签页内展示的是「启动状态面板」：连接信息、进程 PID、临时 .rdp 路径与显示参数，
 * 并提供一键重新唤起与配置入口。
 */
export const RdpSessionView: React.FC<RdpSessionViewProps> = ({
  tab,
  onEditSession,
  onOpenConnectionDetails,
}) => {
  const reconnectTab = useTerminalStore((state) => state.reconnectTab);
  const session = useSessionStore((state) =>
    state.sessions.find((item) => item.id === tab.sessionId)
  );

  const options: RdpProtocolOptions =
    (session?.protocol_options_json as RdpProtocolOptions | null) ?? {};
  const host = tab.rdpInfo?.host ?? session?.host ?? "127.0.0.1";
  const port = tab.rdpInfo?.port ?? session?.port ?? 3389;
  const username = session?.username || "Administrator";
  const fullscreen = options.fullscreen !== false;
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const diskRedirect = !!options.drivestoredirect;
  const clipboardShare = options.redirect_clipboard !== false;

  const meta = STATUS_META[tab.status] ?? STATUS_META.disconnected;
  const busy = tab.status === "connecting" || tab.status === "reconnecting";

  const copy = useCallback(async (text: string, label: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`已复制${label}`, text);
    } catch {
      toast.error("复制失败，请检查剪贴板权限");
    }
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-canvas p-6">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line/15 bg-surface shadow-apple-xl">
        {/* 头部：图标 + 主机名 + 状态 */}
        <div className="flex items-start justify-between gap-3 border-b border-line/10 bg-surface-muted/60 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <MonitorIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-ink">{tab.sessionName}</h2>
              <p className="truncate font-mono text-[11px] text-ink-secondary">
                {username}@{host}:{port}
              </p>
            </div>
          </div>

          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
              meta.tone,
              meta.text
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
            {tab.status === "connected" ? "已启动" : busy ? "启动中" : "未启动"}
          </span>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* 状态说明 */}
          <div className={cn("rounded-xl border px-3 py-2.5 text-xs", meta.tone, meta.text)}>
            <div className="flex items-center gap-1.5 font-semibold">
              <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
              {meta.label}
            </div>
            {(tab.status === "error" || tab.status === "disconnected") && tab.error && (
              <p className="mt-1.5 break-all font-mono text-[11px] opacity-90">{tab.error}</p>
            )}
            {tab.status === "connected" && (
              <p className="mt-1.5 text-[11px] text-ink-secondary">
                远程桌面窗口由 Windows 独立承载，切换到其它标签不会中断连接；关闭 mstsc 窗口后点击下方按钮可重新唤起。
              </p>
            )}
          </div>

          {/* 显示配置徽章 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <BadgePill tone="accent">
              {fullscreen ? "全屏模式" : `${width} × ${height} 窗口`}
            </BadgePill>
            <BadgePill tone={diskRedirect ? "accent" : "muted"}>
              {diskRedirect ? "本地磁盘映射已开启" : "本地磁盘映射未开启"}
            </BadgePill>
            <BadgePill tone={clipboardShare ? "accent" : "muted"}>
              {clipboardShare ? "剪贴板共享" : "剪贴板不共享"}
            </BadgePill>
            {options.admin_session && <BadgePill tone="muted">管理员会话</BadgePill>}
          </div>

          {/* 进程与配置文件信息 */}
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-line/15 bg-surface-muted/40 px-3 py-2">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
                客户端进程 PID
              </dt>
              <dd className="mt-0.5 flex items-center justify-between gap-2 font-mono text-xs text-ink">
                <span className="truncate">{tab.rdpInfo?.pid ?? "—"}</span>
              </dd>
            </div>

            <div className="rounded-xl border border-line/15 bg-surface-muted/40 px-3 py-2">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-ink-tertiary">
                临时 .rdp 配置文件
              </dt>
              <dd className="mt-0.5 flex items-center gap-1.5">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink"
                  title={tab.rdpInfo?.rdp_file_path ?? ""}
                >
                  {tab.rdpInfo?.rdp_file_path ?? "尚未生成"}
                </span>
                {tab.rdpInfo?.rdp_file_path && (
                  <button
                    type="button"
                    onClick={() => void copy(tab.rdpInfo!.rdp_file_path, "配置文件路径")}
                    className="shrink-0 rounded-md p-1 text-ink-tertiary transition hover:bg-line/10 hover:text-ink"
                    title="复制配置文件路径"
                    aria-label="复制配置文件路径"
                  >
                    <CopyIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </dd>
            </div>
          </dl>

          {/* 主操作区 */}
          <div className="flex flex-wrap items-center gap-2 border-t border-line/10 pt-3.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void reconnectTab(tab.tabId)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-action px-3.5 py-2 text-xs font-semibold text-white shadow-apple-sm transition hover:bg-action/90 disabled:opacity-50"
              title="重新生成 .rdp 并调用 mstsc.exe"
            >
              {tab.status === "connected" ? (
                <RefreshIcon className="h-3.5 w-3.5" />
              ) : (
                <PlayIcon className="h-3.5 w-3.5" />
              )}
              <span>{busy ? "正在唤起…" : "重新唤起远程桌面窗口 (mstsc)"}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (session && onEditSession) {
                  onEditSession(session);
                } else {
                  toast.info(
                    "在左侧主机列表右键该会话 → 编辑配置",
                    "可在连接弹窗的「远程桌面」页调整分辨率、全屏、磁盘映射与剪贴板共享。"
                  );
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line/15 bg-surface px-3.5 py-2 text-xs font-semibold text-ink-secondary shadow-apple-sm transition hover:bg-surface-muted hover:text-ink"
              title="修改该连接的远程桌面配置"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
              <span>修改连接配置</span>
            </button>

            {onOpenConnectionDetails && (
              <button
                type="button"
                onClick={() => onOpenConnectionDetails()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-line/15 bg-surface px-3.5 py-2 text-xs font-semibold text-ink-secondary shadow-apple-sm transition hover:bg-surface-muted hover:text-ink"
                title="查看连接状态、链路拓扑与诊断信息"
              >
                <ActivityIcon className="h-3.5 w-3.5" />
                <span>查看连接详情</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
