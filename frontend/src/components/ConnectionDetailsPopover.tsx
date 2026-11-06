import React, { useEffect, useMemo, useState } from "react";
import type {
  ForwardStatus,
  PortForwardRule,
  Protocol,
  ProxyServerConfig,
  Session,
} from "../types/ipc";
import { useTerminalStore, type TerminalTab } from "../stores/terminalStore";
import { useSessionStore } from "../stores/sessionStore";
import * as ipcModule from "../lib/ipc";
import { HostIcon } from "./ui/HostIcon";
import {
  CheckIcon,
  ClockIcon,
  CopyIcon,
  GlobeIcon,
  KeyIcon,
  NetworkIcon,
  PencilIcon,
  RefreshIcon,
  ServerIcon,
  ShieldIcon,
  TriangleAlertIcon,
  WifiIcon,
  WifiOffIcon,
  XIcon,
} from "./ui/icons";

export interface ConnectionDetailsPopoverProps {
  open: boolean;
  onClose: () => void;
  tab: TerminalTab | null;
  session?: Session | null;
  /** 触发重新连接当前标签 */
  onReconnect?: (tabId: string) => void;
  /** 打开连接配置编辑弹窗 */
  onEditSession?: (session: Session) => void;
  /** 打开端口转发/隧道管理弹窗 */
  onOpenPortForward?: () => void;
  /** 打开全局代理服务器管理弹窗 */
  onOpenProxyManager?: () => void;
}

function getIpcFn<K extends keyof typeof ipcModule>(
  key: K
): (typeof ipcModule)[K] | undefined {
  try {
    const fn = ipcModule[key];
    return typeof fn === "function" ? fn : undefined;
  } catch {
    return undefined;
  }
}

function formatDurationClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

function formatProtocolBadge(protocol: Protocol): string {
  switch (protocol) {
    case "ssh":
    case "sftp":
      return "SSH";
    case "rdp":
      return "Windows RDP";
    case "local_shell":
      return "本地终端";
    case "telnet":
      return "Telnet";
    case "serial":
      return "串口 COM";
    default:
      return String(protocol).toUpperCase();
  }
}

function formatAuthMethodLabel(authMethod?: string | null): string {
  switch (authMethod) {
    case "password":
      return "password (密码认证)";
    case "publickey":
    case "public_key":
      return "publickey (公钥认证)";
    case "keyboard_interactive":
      return "keyboard_interactive (交互式验证)";
    case "agent":
      return "agent (SSH Agent)";
    case "none":
      return "none (无认证)";
    default:
      return authMethod || "password";
  }
}

function formatRuleTypeFlag(ruleType: string): string {
  if (ruleType === "local") return "-L 本地转发";
  if (ruleType === "remote") return "-R 远端转发";
  if (ruleType === "dynamic") return "-D 动态 SOCKS5";
  return ruleType.toUpperCase();
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * 连接详情与诊断查看面板（由员工1 gemini4 在 Task 2 中完整实现）
 */
export const ConnectionDetailsPopover: React.FC<ConnectionDetailsPopoverProps> = ({
  open,
  onClose,
  tab,
  session,
  onReconnect,
  onEditSession,
  onOpenPortForward,
  onOpenProxyManager,
}) => {
  const { sessions } = useSessionStore();
  const effectiveSession = useMemo(() => {
    if (session) return session;
    if (!tab?.sessionId) return null;
    return sessions.find((s) => s.id === tab.sessionId) ?? null;
  }, [session, tab?.sessionId, sessions]);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [fallbackConnectedAt, setFallbackConnectedAt] = useState<number>(() => Date.now());
  const [proxies, setProxies] = useState<ProxyServerConfig[]>([]);
  const [tunnels, setTunnels] = useState<PortForwardRule[]>([]);
  const [tunnelStatuses, setTunnelStatuses] = useState<Record<string, ForwardStatus>>({});
  const [copiedTarget, setCopiedTarget] = useState(false);
  const [copiedDiag, setCopiedDiag] = useState(false);

  // 记录连接态的兜底起始时间并在面板打开且已连接时每秒刷新在线时长
  useEffect(() => {
    if (tab?.status === "connected") {
      setFallbackConnectedAt(tab.connectedAt || Date.now());
    }
  }, [tab?.tabId, tab?.status, tab?.connectedAt]);

  useEffect(() => {
    if (!open || tab?.status !== "connected") return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [open, tab?.status, tab?.connectedAt]);

  // 打开面板时读取全局代理列表与当前会话的端口转发规则状态
  useEffect(() => {
    if (!open) return;
    setCopiedTarget(false);
    setCopiedDiag(false);

    const loadProxies = async () => {
      try {
        const fn = getIpcFn("proxyListGet");
        if (fn) {
          const list = await fn();
          if (Array.isArray(list)) {
            setProxies(list);
            return;
          }
        }
      } catch {
        // fallback to localStorage
      }
      try {
        const raw = localStorage.getItem("openshell_proxy_list_fallback_v1");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setProxies(parsed);
        }
      } catch {
        // ignore
      }
    };

    const loadTunnels = async () => {
      const proto = tab?.protocol || effectiveSession?.protocol || "ssh";
      const sid = effectiveSession?.id || tab?.sessionId;
      if ((proto !== "ssh" && proto !== "sftp") || !sid) {
        setTunnels([]);
        setTunnelStatuses({});
        return;
      }
      try {
        const listFn = getIpcFn("forwardList");
        if (listFn) {
          const rules = await listFn(sid);
          if (Array.isArray(rules)) {
            setTunnels(rules);
          }
        }
      } catch {
        // ignore
      }
      try {
        const statusFn = getIpcFn("forwardListStatuses");
        if (typeof statusFn === "function") {
          const st = await statusFn();
          if (st && typeof st === "object") {
            setTunnelStatuses(st);
          }
        }
      } catch {
        // ignore
      }
    };

    void loadProxies();
    void loadTunnels();
  }, [open, tab?.protocol, tab?.sessionId, effectiveSession?.id, effectiveSession?.protocol]);

  if (!open) return null;

  if (!tab) {
    return (
      <div
        role="dialog"
        aria-label="连接详情与诊断面板"
        className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim/60 backdrop-blur-xs p-4"
        onClick={onClose}
      >
        <div
          className="w-full max-w-md rounded-2xl border border-line/15 bg-surface p-5 text-ink shadow-2xl space-y-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold">连接详情与诊断</h3>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-ink-tertiary hover:bg-line/10 hover:text-ink"
              title="关闭"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-ink-secondary">当前暂无活动的连接会话标签。</p>
        </div>
      </div>
    );
  }

  const protocol: Protocol = tab.protocol || effectiveSession?.protocol || "ssh";
  const isSshLike = protocol === "ssh" || protocol === "sftp";
  const defaultPort = protocol === "rdp" ? 3389 : protocol === "telnet" ? 23 : 22;
  const host =
    effectiveSession?.host ||
    tab.rdpInfo?.host ||
    (protocol === "local_shell" ? "localhost" : protocol === "serial" ? "COM1" : "127.0.0.1");
  const port = effectiveSession?.port || tab.rdpInfo?.port || defaultPort;
  const username =
    effectiveSession?.username ||
    (protocol === "rdp" ? "Administrator" : protocol === "ssh" ? "root" : "");

  const targetAddress =
    protocol === "serial"
      ? `${effectiveSession?.protocol_options_json?.port_name || "COM1"} @ ${
          tab.baudRate || effectiveSession?.protocol_options_json?.baud_rate || 115200
        } bps`
      : protocol === "local_shell"
        ? `local://${tab.shellKind || effectiveSession?.protocol_options_json?.shell_kind || "powershell"}`
        : username
          ? `${username}@${host}:${port}`
          : `${host}:${port}`;

  const matchedProxy = effectiveSession?.proxy_id
    ? proxies.find((p) => p.id === effectiveSession.proxy_id) ?? null
    : null;

  const jumpSessionId = effectiveSession?.proxy_jump_json?.session_id as string | undefined;
  const matchedJumpSession = jumpSessionId
    ? sessions.find((s) => s.id === jumpSessionId) ?? null
    : null;

  const topologyText = effectiveSession?.proxy_id
    ? matchedProxy
      ? `本机 ──► 代理服务器 [${matchedProxy.name} (${matchedProxy.proxy_type.toUpperCase()} ${matchedProxy.host}:${matchedProxy.port})] ──► 目标主机`
      : `本机 ──► 代理服务器 [${effectiveSession.proxy_id}] ──► 目标主机`
    : jumpSessionId
      ? matchedJumpSession
        ? `本机 ──► 跳板机 [${matchedJumpSession.name} (${matchedJumpSession.host}:${matchedJumpSession.port || 22})] ──► 目标主机`
        : `本机 ──► 跳板机 [${jumpSessionId}] ──► 目标主机`
      : "本机 ──► 直连 (Direct TCP_NODELAY 低延迟模式) ──► 目标主机";

  const keepaliveSec = effectiveSession?.keepalive_sec ?? 30;
  const keepaliveMaxMiss = effectiveSession?.keepalive_max_miss ?? 3;
  const keepaliveSummary = `每 ${keepaliveSec} 秒探测 · 容忍 ${keepaliveMaxMiss} 次丢包`;

  const reconnectMax = effectiveSession?.reconnect_max ?? 5;
  const autoReconnectEnabled = effectiveSession?.auto_reconnect !== false;
  const autoReconnectSummary = autoReconnectEnabled
    ? `已启用 (最多 ${reconnectMax} 次)`
    : "未启用";

  const connectedOrigin = tab.connectedAt ?? fallbackConnectedAt;
  const onlineDurationText =
    tab.status === "connected" ? formatDurationClock(nowMs - connectedOrigin) : "00:00:00";

  const handleCopyTarget = async () => {
    const ok = await copyTextSafe(targetAddress);
    if (ok) {
      setCopiedTarget(true);
      window.setTimeout(() => setCopiedTarget(false), 1800);
    }
  };

  const handleCopyDiagnostics = async () => {
    const diagLines = [
      `=== OpenShell 连接诊断信息 ===`,
      `会话名称: ${tab.sessionName}`,
      `连接状态: ${tab.status}${tab.status === "connected" ? ` (在线时长 ${onlineDurationText})` : ""}`,
      `协议类型: ${formatProtocolBadge(protocol)}`,
      `目标地址: ${targetAddress}`,
      `认证方式: ${formatAuthMethodLabel(effectiveSession?.auth_method)}`,
      `字符编码: ${effectiveSession?.encoding || "utf-8"}`,
      `连接 ID: ${tab.connectionId || "—"}`,
      `网络拓扑: ${topologyText}`,
      `心跳保活: ${keepaliveSummary}`,
      `自动重连: ${autoReconnectSummary}`,
      ...(isSshLike
        ? [
            `数据压缩: ${effectiveSession?.compression ? "开启" : "关闭"}`,
            `Agent 转发: ${effectiveSession?.agent_forwarding ? "开启" : "关闭"}`,
          ]
        : []),
      ...(tab.error ? [`错误原因: ${tab.error}`] : []),
      ...(tab.exitCode !== null && tab.exitCode !== undefined
        ? [`退出码 (Exit Code): ${tab.exitCode}`]
        : []),
    ];
    const ok = await copyTextSafe(diagLines.join("\n"));
    if (ok) {
      setCopiedDiag(true);
      window.setTimeout(() => setCopiedDiag(false), 2000);
    }
  };

  const handleReconnectClick = () => {
    if (onReconnect) {
      onReconnect(tab.tabId);
    } else {
      void useTerminalStore.getState().reconnectTab(tab.tabId);
    }
  };

  const handleEditSessionClick = () => {
    if (effectiveSession && onEditSession) {
      onEditSession(effectiveSession);
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="连接详情与诊断面板"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-scrim/60 backdrop-blur-xs p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-line/15 bg-surface p-5 text-ink shadow-2xl flex flex-col max-h-[88vh] space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-line/15 pb-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <HostIcon
              iconKey={effectiveSession?.icon_key}
              protocol={protocol}
              className="h-6 w-6 shrink-0"
            />
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-ink truncate">
                连接详情与诊断 · {tab.sessionName}
              </h3>
              <p className="text-[11px] text-ink-tertiary font-mono truncate">
                {targetAddress}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-tertiary hover:bg-line/10 hover:text-ink transition"
            title="关闭详情面板"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 主体滚动区 */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3.5 pr-1">
          {/* 1. 顶部连接状态横幅（绿 / 红 / 琥珀色） */}
          {tab.status === "connected" && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-emerald-500 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <WifiIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>已连接</span>
                  </div>

                </div>
              </div>
              <div className="shrink-0 text-right font-mono">
                <div className="text-[10px] text-emerald-500/80 flex items-center justify-end gap-1">
                  <ClockIcon className="h-3 w-3" />
                  <span>在线时长</span>
                </div>
                <div className="text-sm font-bold tracking-wider">{onlineDurationText}</div>
              </div>
            </div>
          )}

          {(tab.status === "error" || tab.status === "disconnected") && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3.5 py-3 text-red-500 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-bold text-xs">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-500 shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.7)]" />
                  <WifiOffIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>连接失败 / 已断开</span>
                </div>
                {tab.exitCode !== null && tab.exitCode !== undefined && (
                  <span className="rounded-md border border-red-500/30 bg-red-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold">
                    退出码: {tab.exitCode}
                  </span>
                )}
              </div>
              <div className="rounded-lg bg-surface/80 border border-red-500/20 px-2.5 py-2 text-xs text-red-500 font-mono break-words leading-relaxed">
                {tab.error || "连接已断开，可点击下方「立即重连」重新建立会话。"}
              </div>
            </div>
          )}

          {(tab.status === "connecting" || tab.status === "reconnecting") && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-amber-500 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
                <div>
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <TriangleAlertIcon className="h-3.5 w-3.5 shrink-0" />
                    <span>正在建立连接 / 正在自动重连</span>
                  </div>
                  <div className="text-[11px] text-amber-500/80">
                    正在握手协商安全加密通道，请稍候...
                  </div>
                </div>
              </div>
              <div className="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/15 px-2.5 py-1 font-mono text-xs font-bold">
                第 {tab.reconnectAttempt ?? 1} / {reconnectMax} 次
              </div>
            </div>
          )}

          {/* 2. 连接基础属性卡片 */}
          <div className="rounded-xl border border-line/15 bg-surface-muted/40 p-3.5 space-y-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink flex items-center gap-1.5">
                <ServerIcon className="h-3.5 w-3.5 text-accent" />
                <span>连接基础属性</span>
              </span>
              <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">
                {formatProtocolBadge(protocol)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <div className="rounded-lg border border-line/10 bg-surface p-2">
                <div className="text-[10px] text-ink-tertiary">会话名称</div>
                <div className="font-semibold text-ink truncate mt-0.5" title={tab.sessionName}>
                  {tab.sessionName}
                </div>
              </div>

              <div className="rounded-lg border border-line/10 bg-surface p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-ink-tertiary">目标地址</span>
                  <button
                    type="button"
                    onClick={() => void handleCopyTarget()}
                    className="inline-flex items-center gap-1 text-[10px] text-accent hover:underline"
                    title="一键复制目标地址"
                  >
                    {copiedTarget ? (
                      <>
                        <CheckIcon className="h-3 w-3" />
                        <span>已复制</span>
                      </>
                    ) : (
                      <>
                        <CopyIcon className="h-3 w-3" />
                        <span>复制</span>
                      </>
                    )}
                  </button>
                </div>
                <div
                  className="font-mono font-semibold text-ink truncate mt-0.5"
                  title={targetAddress}
                >
                  {targetAddress}
                </div>
              </div>

              <div className="rounded-lg border border-line/10 bg-surface p-2">
                <div className="text-[10px] text-ink-tertiary flex items-center gap-1">
                  <KeyIcon className="h-3 w-3" />
                  <span>认证方式</span>
                </div>
                <div className="font-mono text-ink truncate mt-0.5">
                  {formatAuthMethodLabel(effectiveSession?.auth_method)}
                </div>
              </div>

              <div className="rounded-lg border border-line/10 bg-surface p-2">
                <div className="text-[10px] text-ink-tertiary">字符编码 / 连接 ID</div>
                <div className="font-mono text-ink truncate mt-0.5" title={tab.connectionId || "—"}>
                  <span className=" uppercase font-semibold">
                    {effectiveSession?.encoding || "utf-8"}
                  </span>
                  <span className="mx-1.5 text-ink-tertiary">·</span>
                  <span className="text-ink-secondary">{tab.connectionId || "—"}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 3. 网络链路与代理/跳板拓扑可视化 */}
          <div className="rounded-xl border border-line/15 bg-surface-muted/40 p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink flex items-center gap-1.5">
                <GlobeIcon className="h-3.5 w-3.5 text-accent" />
                <span>网络链路与代理 / 跳板拓扑</span>
              </span>
              {onOpenProxyManager && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenProxyManager();
                    onClose();
                  }}
                  className="text-[11px] font-semibold text-accent hover:underline"
                >
                  代理服务器管理 ↗
                </button>
              )}
            </div>

            <div className="rounded-lg border border-line/15 bg-surface px-3 py-2.5 font-mono text-[11px] text-ink leading-relaxed break-all">
              {topologyText}
            </div>
          </div>

          {/* 4. 连接可靠性与零限速传输指标 */}
          <div className="rounded-xl border border-line/15 bg-surface-muted/40 p-3.5 space-y-2.5 text-xs">
            <div className="font-bold text-ink flex items-center gap-1.5">
              <ShieldIcon className="h-3.5 w-3.5 text-emerald-500" />
              <span>连接可靠性与零限速传输指标</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-line/10 bg-surface p-2">
                <div className="text-[10px] text-ink-tertiary">心跳保活策略</div>
                <div className="font-semibold text-ink mt-0.5">{keepaliveSummary}</div>
              </div>
              <div className="rounded-lg border border-line/10 bg-surface p-2">
                <div className="text-[10px] text-ink-tertiary">断线自动重连</div>
                <div className="font-semibold text-ink mt-0.5">{autoReconnectSummary}</div>
              </div>
            </div>

            {isSshLike && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">


                <span className="inline-flex items-center rounded-lg border border-line/15 bg-surface px-2.5 py-1 text-[11px] font-mono text-ink-secondary">
                  压缩: {effectiveSession?.compression ? "开启" : "关闭"}
                </span>
                <span className="inline-flex items-center rounded-lg border border-line/15 bg-surface px-2.5 py-1 text-[11px] font-mono text-ink-secondary">
                  Agent 转发: {effectiveSession?.agent_forwarding ? "开启" : "关闭"}
                </span>
              </div>
            )}
          </div>

          {/* 5. 当前会话隧道 / 端口转发概览 */}
          {isSshLike && (
            <div className="rounded-xl border border-line/15 bg-surface-muted/40 p-3.5 space-y-2.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-bold text-ink flex items-center gap-1.5">
                  <NetworkIcon className="h-3.5 w-3.5 text-accent" />
                  <span>当前会话隧道 / 端口转发 ({tunnels.length})</span>
                </span>
                {(onOpenPortForward || (effectiveSession && onEditSession)) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (onOpenPortForward) {
                        onOpenPortForward();
                        onClose();
                      } else if (effectiveSession && onEditSession) {
                        onEditSession(effectiveSession);
                        onClose();
                      }
                    }}
                    className="text-[11px] font-semibold text-accent hover:underline"
                  >
                    管理隧道 ↗
                  </button>
                )}
              </div>

              {tunnels.length === 0 ? (
                <div className="rounded-lg border border-dashed border-line/20 bg-surface/60 py-3 text-center text-[11px] text-ink-tertiary">
                  当前会话暂未配置绑定的端口转发规则 (-L / -R / -D)
                </div>
              ) : (
                <div className="space-y-1.5">
                  {tunnels.map((rule) => {
                    const st = tunnelStatuses[rule.id];
                    const isListening = st?.state === "Listening";
                    const isError = st?.state === "Error";
                    return (
                      <div
                        key={rule.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-line/15 bg-surface px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-ink truncate">{rule.name}</span>
                            <span className="rounded bg-accent/10 px-1.5 py-0.2 font-mono text-[10px] font-bold text-accent">
                              {formatRuleTypeFlag(rule.rule_type)}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-ink-secondary truncate mt-0.5">
                            {rule.bind_host}:{rule.bind_port}
                            {rule.rule_type !== "dynamic"
                              ? ` → ${rule.dest_host}:${rule.dest_port}`
                              : " (SOCKS5)"}
                          </div>
                        </div>

                        <span
                          className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            isListening
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                              : isError
                                ? "border-red-500/30 bg-red-500/10 text-red-500"
                                : "border-line/20 bg-line/10 text-ink-secondary"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isListening
                                ? "bg-emerald-500"
                                : isError
                                  ? "bg-red-500"
                                  : "bg-ink-tertiary"
                            }`}
                          />
                          <span>{isListening ? "运行中" : isError ? "错误" : "未启动"}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 6. 底部快捷操作栏 */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/15 pt-3 shrink-0">
          <button
            type="button"
            onClick={() => void handleCopyDiagnostics()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line/20 bg-surface px-3 py-2 text-xs font-semibold text-ink-secondary hover:bg-surface-muted hover:text-ink transition"
          >
            {copiedDiag ? (
              <>
                <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />
                <span className="text-emerald-500">已复制诊断信息</span>
              </>
            ) : (
              <>
                <CopyIcon className="h-3.5 w-3.5" />
                <span>复制诊断信息</span>
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            {effectiveSession && onEditSession && (
              <button
                type="button"
                onClick={handleEditSessionClick}
                className="inline-flex items-center gap-1.5 rounded-xl border border-line/20 bg-surface px-3.5 py-2 text-xs font-semibold text-ink-secondary hover:bg-surface-muted hover:text-ink transition"
              >
                <PencilIcon className="h-3.5 w-3.5" />
                <span>修改连接配置</span>
              </button>
            )}

            <button
              type="button"
              onClick={handleReconnectClick}
              className="inline-flex items-center gap-1.5 rounded-xl bg-action px-4 py-2 text-xs font-semibold text-white shadow-apple-sm hover:bg-action/90 transition"
            >
              <RefreshIcon className="h-3.5 w-3.5" />
              <span>立即重连</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
