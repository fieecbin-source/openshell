import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

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
        error: String(err?.message || err),
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-xl border border-surface-800 bg-surface-900 p-6 shadow-2xl">
        {/* 顶部标题栏与 Tab 切换 */}
        <div className="flex items-center justify-between pb-4 border-b border-surface-800">
          <div className="flex items-center space-x-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-white">网络探测与扩展机制</h2>
              <p className="text-xs text-slate-400 font-mono">架构 §21 扩展机制示例验证模块</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-surface-800 hover:text-white transition"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 选项卡 */}
        <div className="flex border-b border-surface-800 mt-4 text-xs">
          <button
            onClick={() => setActiveTab("checker")}
            className={`px-4 py-2 border-b-2 font-medium transition ${
              activeTab === "checker"
                ? "border-teal-400 text-teal-400"
                : "border-transparent text-slate-400 hover:text-white"
            }`}
          >
            TCP 连通性探测
          </button>
          <button
            onClick={() => setActiveTab("plugins")}
            className={`px-4 py-2 border-b-2 font-medium transition ${
              activeTab === "plugins"
                ? "border-teal-400 text-teal-400"
                : "border-transparent text-slate-400 hover:text-white"
            }`}
          >
            扩展组件清单 ({tools.length + actions.length})
          </button>
        </div>

        {activeTab === "checker" ? (
          <form onSubmit={handleProbe} className="space-y-4 mt-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <label className="text-xs font-medium text-slate-300">目标主机 / IP</label>
                <input
                  type="text"
                  required
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="例如: 127.0.0.1 或 192.168.1.1"
                  className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-300">目标端口</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  placeholder="22"
                  className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-300">探测超时 (毫秒)</label>
              <input
                type="number"
                min={200}
                max={10000}
                step={100}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-teal-500 focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center space-x-2 rounded-lg bg-teal-600 px-4 py-2 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50 transition"
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
                className={`rounded-lg border p-3 mt-3 text-xs transition ${
                  result.is_open
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                <div className="flex items-center justify-between font-semibold">
                  <div className="flex items-center space-x-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        result.is_open ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                      }`}
                    />
                    <span>{result.is_open ? "端口开放 (OPEN)" : "端口不可达 / 关闭 (CLOSED)"}</span>
                  </div>
                  <span className="font-mono text-[11px] bg-black/30 px-2 py-0.5 rounded">
                    耗时: {result.latency_ms} ms
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-300 font-mono">
                  目标: {result.host}:{result.port}
                </div>
                {result.error && (
                  <div className="mt-1 text-[11px] text-rose-400/90 font-mono break-all">
                    原因: {result.error}
                  </div>
                )}
              </div>
            )}
          </form>
        ) : (
          <div className="mt-4 space-y-3 max-h-72 overflow-y-auto pr-1">
            <div className="text-xs font-medium text-slate-400">已注册独立工具页 (ToolPageProvider)</div>
            {tools.map((t) => (
              <div
                key={t.tool_id}
                className="flex items-center justify-between p-2.5 rounded-lg border border-surface-800 bg-surface-950 text-xs"
              >
                <div>
                  <div className="font-semibold text-white">{t.display_name}</div>
                  <div className="text-[11px] text-slate-400 font-mono">路由: {t.route} ({t.window_mode})</div>
                </div>
                <button
                  onClick={() => toggleFeature("tool", t.tool_id, t.enabled)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition ${
                    t.enabled
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
                      : "bg-surface-800 text-slate-400 border border-surface-700 hover:text-white"
                  }`}
                >
                  {t.enabled ? "已启用" : "已禁用"}
                </button>
              </div>
            ))}

            <div className="text-xs font-medium text-slate-400 pt-2">已注册快捷动作 (QuickActionProvider)</div>
            {actions.map((a) => (
              <div
                key={a.action_id}
                className="flex items-center justify-between p-2.5 rounded-lg border border-surface-800 bg-surface-950 text-xs"
              >
                <div>
                  <div className="font-semibold text-white">{a.action_id}</div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    快捷键: {a.default_shortcut || "无"}
                  </div>
                </div>
                <button
                  onClick={() => toggleFeature("action", a.action_id, a.enabled)}
                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition ${
                    a.enabled
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
                      : "bg-surface-800 text-slate-400 border border-surface-700 hover:text-white"
                  }`}
                >
                  {a.enabled ? "已启用" : "已禁用"}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-end border-t border-surface-800 pt-4">
          <button
            onClick={onClose}
            className="rounded-lg bg-surface-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-surface-700 hover:text-white transition"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
};
