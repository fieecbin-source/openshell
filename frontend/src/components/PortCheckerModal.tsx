import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatFriendlyError } from "../lib/errors";

export interface PortCheckResult {
  host: string;
  port: number;
  is_open: boolean;
  latency_ms: number;
  error?: string;
}

export interface ExtensionTool {
  tool_id: string;
  route: string;
  display_name: string;
  icon: string;
  window_mode: string;
  enabled: boolean;
}

export interface ExtensionAction {
  action_id: string;
  label_key: string;
  default_shortcut?: string;
  enabled: boolean;
}

interface PortCheckerModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultHost?: string;
  defaultPort?: number;
}

export const PortCheckerModal: React.FC<PortCheckerModalProps> = ({
  isOpen,
  onClose,
  defaultHost = "127.0.0.1",
  defaultPort = 22,
}) => {
  const [activeTab, setActiveTab] = useState<"checker" | "plugins">("checker");
  const [host, setHost] = useState(defaultHost);
  const [port, setPort] = useState(defaultPort);
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PortCheckResult | null>(null);

  // 扩展管理列表
  const [tools, setTools] = useState<ExtensionTool[]>([]);
  const [actions, setActions] = useState<ExtensionAction[]>([]);

  useEffect(() => {
    if (isOpen) {
      setHost(defaultHost);
      setPort(defaultPort);
      setResult(null);
      loadExtensions();
    }
  }, [isOpen, defaultHost, defaultPort]);

  const loadExtensions = async () => {
    try {
      const t = await invoke<ExtensionTool[]>("plugin_list_tools");
      const a = await invoke<ExtensionAction[]>("plugin_list_quick_actions");
      setTools(t);
      setActions(a);
    } catch (e) {
      console.error("Failed to load extensions:", e);
    }
  };

  const handleProbe = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setResult(null);
    try {
      const res = await invoke<PortCheckResult>("plugin_check_port", {
        host: host.trim(),
        port: Number(port),
        timeoutMs: Number(timeoutMs),
      });
      setResult(res);
    } catch (err: any) {
      setResult({
        host,
        port,
        is_open: false,
        latency_ms: timeoutMs,
        error: formatFriendlyError(err),
      });
    } finally {
      setLoading(false);
    }
  };

  const toggleFeature = async (kind: string, id: string, current: boolean) => {
    try {
      await invoke("plugin_toggle_feature", {
        kind,
        id,
        enabled: !current,
      });
      await loadExtensions();
    } catch (err) {
      console.error("Toggle feature failed:", err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-black/[0.08] bg-white/95 p-6 shadow-apple-lg backdrop-blur-2xl text-[#1d1d1f] animate-in zoom-in-95 duration-150">
        {/* 顶部标题栏与 Tab 切换 */}
        <div className="flex items-center justify-between pb-4 border-b border-black/[0.06]">
          <div className="flex items-center space-x-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 border border-teal-200/60 text-teal-600 shadow-sm">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-[#1d1d1f] tracking-tight">网络探测与扩展机制</h2>
              <p className="text-xs text-[#86868b] font-mono">TCP 连通性测试与核心插件扩展管理</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#86868b] hover:bg-black/[0.05] hover:text-[#1d1d1f] active:scale-95 transition"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 选项卡 (Apple 风格分段胶囊) */}
        <div className="mt-4 flex bg-black/[0.06] p-0.5 rounded-xl text-xs font-medium w-fit">
          <button
            onClick={() => setActiveTab("checker")}
            className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
              activeTab === "checker"
                ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                : "text-[#86868b] hover:text-[#1d1d1f]"
            }`}
          >
            TCP 连通性探测
          </button>
          <button
            onClick={() => setActiveTab("plugins")}
            className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
              activeTab === "plugins"
                ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                : "text-[#86868b] hover:text-[#1d1d1f]"
            }`}
          >
            扩展组件清单 ({tools.length + actions.length})
          </button>
        </div>

        {activeTab === "checker" ? (
          <form onSubmit={handleProbe} className="space-y-4 mt-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <label className="text-xs font-semibold text-[#1d1d1f]">目标主机 / IP</label>
                <input
                  type="text"
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="例如: 127.0.0.1 或 192.168.1.1"
                  className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-2 text-xs text-[#1d1d1f] placeholder-[#86868b]/60 focus:border-[#0071e3] focus:bg-white focus:outline-none transition"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#1d1d1f]">目标端口</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  placeholder="22"
                  className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-2 text-xs text-[#1d1d1f] placeholder-[#86868b]/60 focus:border-[#0071e3] focus:bg-white focus:outline-none transition"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#1d1d1f]">探测超时 (毫秒)</label>
              <input
                type="number"
                min={200}
                max={10000}
                step={100}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-full rounded-xl border border-black/[0.08] bg-[#f5f5f7] px-3 py-2 text-xs text-[#1d1d1f] placeholder-[#86868b]/60 focus:border-[#0071e3] focus:bg-white focus:outline-none transition"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center space-x-2 rounded-xl bg-[#0071e3] px-4 py-2 text-xs font-semibold text-white hover:bg-[#0077ed] active:scale-[0.98] disabled:opacity-50 transition shadow-sm"
            >
              {loading ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>探测中...</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span>立即探测端口</span>
                </>
              )}
            </button>

            {/* 探测结果面板 */}
            {result && (
              <div
                className={`rounded-xl border p-3.5 mt-3 text-xs transition shadow-apple-sm ${
                  result.is_open
                    ? "border-emerald-500/30 bg-emerald-50/60 text-emerald-900"
                    : "border-red-500/30 bg-red-50/60 text-red-900"
                }`}
              >
                <div className="flex items-center justify-between font-semibold">
                  <div className="flex items-center space-x-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        result.is_open ? "bg-emerald-500 animate-pulse" : "bg-red-500"
                      }`}
                    />
                    <span className="font-bold">{result.is_open ? "端口开放 (OPEN)" : "端口不可达 / 关闭 (CLOSED)"}</span>
                  </div>
                  <span className="font-mono text-[11px] bg-black/[0.06] px-2 py-0.5 rounded-md text-[#1d1d1f]">
                    耗时: {result.latency_ms} ms
                  </span>
                </div>
                <div className="mt-1.5 text-[11px] text-[#424245] font-mono">
                  目标: {result.host}:{result.port}
                </div>
                {result.error && (
                  <div className="mt-1 text-[11px] text-red-700 font-mono break-all">
                    原因: {result.error}
                  </div>
                )}
              </div>
            )}
          </form>
        ) : (
          <div className="mt-4 space-y-3 max-h-72 overflow-y-auto pr-1">
            <div className="text-xs font-semibold text-[#1d1d1f]">已注册独立工具页 (ToolPageProvider)</div>
            {tools.map((t) => (
              <div
                key={t.tool_id}
                className="flex items-center justify-between p-3 rounded-xl border border-black/[0.06] bg-[#f5f5f7] text-xs shadow-apple-sm"
              >
                <div>
                  <div className="font-semibold text-[#1d1d1f]">{t.display_name}</div>
                  <div className="text-[11px] text-[#86868b] font-mono">路由: {t.route} ({t.window_mode})</div>
                </div>
                <button
                  onClick={() => toggleFeature("tool", t.tool_id, t.enabled)}
                  className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition active:scale-[0.98] ${
                    t.enabled
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      : "bg-white text-[#86868b] border border-black/[0.08] hover:text-[#1d1d1f]"
                  }`}
                >
                  {t.enabled ? "已启用" : "已禁用"}
                </button>
              </div>
            ))}

            <div className="text-xs font-semibold text-[#1d1d1f] pt-2">已注册快捷动作 (QuickActionProvider)</div>
            {actions.map((a) => (
              <div
                key={a.action_id}
                className="flex items-center justify-between p-3 rounded-xl border border-black/[0.06] bg-[#f5f5f7] text-xs shadow-apple-sm"
              >
                <div>
                  <div className="font-semibold text-[#1d1d1f]">{a.action_id}</div>
                  <div className="text-[11px] text-[#86868b] font-mono">
                    快捷键: {a.default_shortcut || "无"}
                  </div>
                </div>
                <button
                  onClick={() => toggleFeature("action", a.action_id, a.enabled)}
                  className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition active:scale-[0.98] ${
                    a.enabled
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                      : "bg-white text-[#86868b] border border-black/[0.08] hover:text-[#1d1d1f]"
                  }`}
                >
                  {a.enabled ? "已启用" : "已禁用"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-end border-t border-black/[0.06] pt-4">
          <button
            onClick={onClose}
            className="rounded-xl border border-black/[0.08] bg-black/[0.04] px-4 py-2 text-xs font-semibold text-[#1d1d1f] hover:bg-black/[0.08] active:scale-[0.98] transition"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
