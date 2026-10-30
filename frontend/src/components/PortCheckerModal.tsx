import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { Panel, SectionHeader } from "./ui/Surface";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Segmented } from "./ui/Controls";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";
import { CheckIcon, ActivityIcon, PlugIcon } from "./ui/icons";

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

type CheckerTab = "checker" | "plugins";

export const PortCheckerModal: React.FC<PortCheckerModalProps> = ({
  isOpen,
  onClose,
  defaultHost = "127.0.0.1",
  defaultPort = 22,
}) => {
  const [activeTab, setActiveTab] = useState<CheckerTab>("checker");
  const [host, setHost] = useState(defaultHost);
  const [port, setPort] = useState(defaultPort);
  const [timeoutMs, setTimeoutMs] = useState(2000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PortCheckResult | null>(null);
  // 探测没有真正执行（例如在浏览器预览里没有 Tauri 运行时）时的说明
  const [failure, setFailure] = useState<string | null>(null);

  // 扩展管理列表
  const [tools, setTools] = useState<ExtensionTool[]>([]);
  const [actions, setActions] = useState<ExtensionAction[]>([]);

  useEffect(() => {
    if (isOpen) {
      setHost(defaultHost);
      setPort(defaultPort);
      setResult(null);
      setFailure(null);
      loadExtensions();
    }
  }, [isOpen, defaultHost, defaultPort]);

  const loadExtensions = async () => {
    if (!isTauriRuntime()) return;
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
    setResult(null);
    setFailure(null);
    if (!isTauriRuntime()) {
      setFailure("当前在浏览器预览中运行，无法执行本地 TCP 探测。请使用 OpenShell 桌面客户端。");
      return;
    }
    setLoading(true);
    try {
      const res = await invoke<PortCheckResult>("plugin_check_port", {
        host: host.trim(),
        port: Number(port),
        timeoutMs: Number(timeoutMs),
      });
      setResult(res);
    } catch (err) {
      // IPC 本身失败时不能伪造「端口关闭」结论，明确告知探测未执行
      setFailure(formatFriendlyError(err));
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
    <Modal
      open
      onClose={onClose}
      title="网络探测与扩展机制"
      description="TCP 连通性测试与核心插件扩展管理"
      widthClassName="w-full max-w-[560px]"
      footer={
        <Button variant="secondary" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="space-y-4">
        <Segmented<CheckerTab>
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel="探测与扩展页签"
          options={[
            { value: "checker", label: "TCP 连通性探测", icon: <ActivityIcon className="h-3.5 w-3.5" /> },
            { value: "plugins", label: `扩展组件 (${tools.length + actions.length})` },
          ]}
        />

        {activeTab === "checker" ? (
          <form onSubmit={handleProbe} className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Field label="目标主机 / IP" required className="col-span-2">
                <Input
                  type="text"
                  required
                  mono
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="例如: 127.0.0.1 或 192.168.1.1"
                />
              </Field>
              <Field label="目标端口" required>
                <Input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  mono
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  placeholder="22"
                />
              </Field>
            </div>

            <Field label="探测超时" hint="单位：毫秒，范围 200 - 10000">
              <Input
                type="number"
                min={200}
                max={10000}
                step={100}
                mono
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
              />
            </Field>

            <Button
              type="submit"
              variant="primary"
              loading={loading}
              className="w-full"
              leading={!loading ? <CheckIcon className="h-3.5 w-3.5" /> : undefined}
            >
              {loading ? "探测中..." : "立即探测端口"}
            </Button>

            {/* 探测未执行（IPC 不可用或调用失败） */}
            {failure && (
              <InlineNotice tone="warning" title="探测未执行">
                <div className="break-all">{failure}</div>
              </InlineNotice>
            )}

            {/* 探测结果面板 */}
            {result && (
              <InlineNotice
                tone={result.is_open ? "success" : "danger"}
                title={
                  <span className="flex items-center gap-1.5">
                    {result.is_open ? (
                      <span className="h-2 w-2 rounded-full bg-state-success" />
                    ) : (
                      <span className="h-2 w-2 rounded-full bg-state-danger" />
                    )}
                    {result.is_open ? "端口开放 (OPEN)" : "端口不可达 / 关闭 (CLOSED)"}
                  </span>
                }
                action={
                  <span className="rounded-os-sm bg-line/5 px-2 py-0.5 font-mono text-os-2xs tabular-nums text-ink-secondary">
                    {result.latency_ms} ms
                  </span>
                }
              >
                <div className="space-y-1 font-mono text-os-2xs">
                  <div>
                    目标: {result.host}:{result.port}
                  </div>
                  {result.error && (
                    <div className="break-all text-state-danger">原因: {result.error}</div>
                  )}
                </div>
              </InlineNotice>
            )}
          </form>
        ) : (
          <div className="max-h-[320px] space-y-3 overflow-y-auto pr-1">
            <section className="space-y-1.5">
              <SectionHeader
                title={
                  <span className="flex items-center gap-1.5 text-os-xs font-semibold text-ink">
                    <PlugIcon className="h-3.5 w-3.5 text-ink-tertiary" />
                    独立工具页
                  </span>
                }
              />
              {tools.length === 0 ? (
                <p className="py-3 text-center text-os-2xs text-ink-tertiary">暂无注册工具页</p>
              ) : (
                tools.map((t) => (
                  <Panel key={t.tool_id} padded={false} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-os-xs font-semibold text-ink">{t.display_name}</div>
                      <div className="truncate font-mono text-os-2xs text-ink-tertiary">
                        {t.route} · {t.window_mode}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={t.enabled ? "secondary" : "ghost"}
                      onClick={() => toggleFeature("tool", t.tool_id, t.enabled)}
                    >
                      {t.enabled ? "已启用" : "已禁用"}
                    </Button>
                  </Panel>
                ))
              )}
            </section>

            <section className="space-y-1.5">
              <SectionHeader
                title={
                  <span className="flex items-center gap-1.5 text-os-xs font-semibold text-ink">
                    <ActivityIcon className="h-3.5 w-3.5 text-ink-tertiary" />
                    快捷动作
                  </span>
                }
              />
              {actions.length === 0 ? (
                <p className="py-3 text-center text-os-2xs text-ink-tertiary">暂无注册快捷动作</p>
              ) : (
                actions.map((a) => (
                  <Panel key={a.action_id} padded={false} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-os-xs font-semibold text-ink">{a.action_id}</div>
                      <div className="font-mono text-os-2xs text-ink-tertiary">
                        快捷键: {a.default_shortcut || "无"}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={a.enabled ? "secondary" : "ghost"}
                      onClick={() => toggleFeature("action", a.action_id, a.enabled)}
                    >
                      {a.enabled ? "已启用" : "已禁用"}
                    </Button>
                  </Panel>
                ))
              )}
            </section>
          </div>
        )}
      </div>
    </Modal>
  );
};
