import React, { useEffect, useRef, useState } from "react";
import type { ProxyServerConfig, ProxyServerInput, ProxyTestResult, ProxyType } from "../types/ipc";
import * as ipcModule from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { RequiredMark } from "./ui/Field";

function getIpcFn<K extends keyof typeof ipcModule>(key: K): (typeof ipcModule)[K] | undefined {
  try {
    const fn = ipcModule[key];
    return typeof fn === "function" ? fn : undefined;
  } catch {
    return undefined;
  }
}

function checkTauriRuntime(): boolean {
  const fn = getIpcFn("isTauriRuntime");
  return fn ? fn() : typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
import {
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
  XIcon,
} from "./ui/icons";

export interface ProxyManagerModalProps {
  open: boolean;
  onClose: () => void;
  onChanged?: (proxies: ProxyServerConfig[]) => void;
}

function generateProxyId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `proxy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const PROXY_TYPE_BADGE: Record<ProxyType, { label: string; className: string }> = {
  socks5: {
    label: "SOCKS5",
    className: "bg-accent/10 text-accent border-accent/30",
  },
  socks4: {
    label: "SOCKS4",
    className: "bg-amber-500/10 text-amber-500 border-amber-500/30",
  },
  http: {
    label: "HTTP",
    className: "bg-emerald-500/10 text-emerald-500 border-emerald-500/30",
  },
};

const LEGACY_PROXY_KEY = "openshell_proxy_list_fallback_v1";
const LEGACY_INVALID = "历史代理数据无法安全导入，请手动处理；原数据已保留";
const LEGACY_VERIFY = "历史代理已保存，但确认失败，请刷新列表并手动处理保留的原数据";

function legacyInputs(raw: string): ProxyServerInput[] {
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { throw new Error(LEGACY_INVALID); }
  if (!Array.isArray(rows)) throw new Error(LEGACY_INVALID);
  const ids = new Set<string>();
  const allowed = new Set([
    "id", "name", "proxy_type", "host", "port", "username", "password", "notes",
    "created_at", "updated_at", "password_ref", "has_password", "clear_password",
  ]);
  return rows.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(LEGACY_INVALID);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !allowed.has(key))
      || ["id", "name", "host"].some((key) => typeof row[key] !== "string" || !(row[key] as string).trim())
      || !["http", "socks4", "socks5"].includes(row.proxy_type as string)
      || typeof row.port !== "number" || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535
      || /[\r\n\0]/.test(row.host as string)
      || ["username", "password", "notes"].some((key) => row[key] != null && typeof row[key] !== "string")
      || ["created_at", "updated_at"].some((key) => row[key] != null && !Number.isSafeInteger(row[key]))
      || row.password_ref != null || (row.has_password != null && typeof row.has_password !== "boolean")
      || (row.has_password === true && !row.password)
      || (row.clear_password != null && row.clear_password !== false)
      || ids.has(row.id as string)) throw new Error(LEGACY_INVALID);
    ids.add(row.id as string);
    // Legacy references cannot establish ownership of a backend secret.
    const { password_ref: _reference, has_password: _hasPassword, ...input } = row;
    return { ...input, clear_password: false } as unknown as ProxyServerInput;
  });
}

function publicConfig(input: ProxyServerInput): ProxyServerConfig {
  const { password: _password, clear_password: _clearPassword, ...config } = input;
  return config;
}

function confirmsProxy(actual: ProxyServerConfig | undefined, expected: ProxyServerInput): boolean {
  if (!actual) return false;
  const fields = ["id", "name", "proxy_type", "host", "port", "username", "notes", "created_at", "updated_at"] as const;
  if (fields.some((key) => (actual[key] ?? null) !== (expected[key] ?? null))) return false;
  if (expected.password) return actual.has_password === true && Boolean(actual.password_ref);
  return (actual.password_ref ?? null) === (expected.password_ref ?? null)
    && Boolean(actual.has_password) === Boolean(expected.has_password);
}

/**
 * 代理服务器管理弹窗（HTTP / SOCKS4 / SOCKS5）
 */
export function ProxyManagerModal({
  open,
  onClose,
  onChanged,
}: ProxyManagerModalProps): JSX.Element | null {
  const [proxies, setProxies] = useState<ProxyServerConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const activeLoad = useRef<number | null>(null);
  const mutationGeneration = useRef(0);
  const activeMutation = useRef<number | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const migrationJob = useRef<Promise<{ list: ProxyServerConfig[]; error?: string }> | null>(null);
  // A successful write is never repeated after a failed verification. No credentials are retained here.
  const migrationCommitted = useRef(false);

  // 编辑/新建表单状态
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [proxyType, setProxyType] = useState<ProxyType>("socks5");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(1080);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [notes, setNotes] = useState("");

  // 连通性测试状态：key 为 proxy.id 或 "__form__"
  const [testingMap, setTestingMap] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, ProxyTestResult>>({});

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setProxyType("socks5");
    setHost("");
    setPort(1080);
    setUsername("");
    setPassword("");
    setClearPassword(false);
    setHasStoredPassword(false);
    setShowPassword(false);
    setNotes("");
    setErrorMsg(null);
  };

  const loadProxies = async () => {
    if (activeMutation.current !== null) return;
    const generation = ++loadGeneration.current;
    activeLoad.current = generation;
    setLoading(true);
    setErrorMsg(null);
    try {
      const proxyListGetFn = getIpcFn("proxyListGet");
      if (!proxyListGetFn) throw new Error("proxyListGet unavailable");
      let result: { list: ProxyServerConfig[]; error?: string };
      if (migrationJob.current) {
        result = await migrationJob.current;
      } else {
        const list = await proxyListGetFn();
        if (generation !== loadGeneration.current) return;
        if (!Array.isArray(list)) throw new Error("无法读取代理列表，请刷新后重试");
        const normalized = list.map(publicConfig);
        setProxies(normalized);
        const raw = localStorage.getItem(LEGACY_PROXY_KEY);
        result = { list: normalized };
        if (raw !== null && migrationCommitted.current) {
          result.error = LEGACY_VERIFY;
        } else if (raw !== null) {
          const migrate = async (): Promise<typeof result> => {
            let candidates: ProxyServerInput[];
            try { candidates = legacyInputs(raw); } catch { return { list: normalized, error: LEGACY_INVALID }; }
            if (candidates.some((candidate) => normalized.some((proxy) => proxy.id === candidate.id))) {
              return { list: normalized, error: "历史代理与已有代理冲突，请手动处理；原数据已保留" };
            }
            if (candidates.length === 0) {
              if (localStorage.getItem(LEGACY_PROXY_KEY) === raw) localStorage.removeItem(LEGACY_PROXY_KEY);
              return { list: normalized };
            }
            const proxyListSaveFn = getIpcFn("proxyListSave");
            if (!proxyListSaveFn) return { list: normalized, error: "proxyListSave unavailable" };
            const inputs: ProxyServerInput[] = [
              ...normalized.map((proxy) => ({ ...proxy, clear_password: false })), ...candidates,
            ];
            let saved: ProxyServerConfig[];
            try {
              const output = await proxyListSaveFn(inputs);
              migrationCommitted.current = true;
              saved = Array.isArray(output) ? output.map(publicConfig) : normalized;
            } catch (err) { return { list: normalized, error: formatFriendlyError(err) }; }
            let notificationError: string | undefined;
            try { onChanged?.(saved); } catch { notificationError = "历史代理已保存，请刷新列表"; }
            try {
              const verified = await proxyListGetFn();
              if (!Array.isArray(verified) || !inputs.every((expected) =>
                confirmsProxy(verified.find((proxy) => proxy.id === expected.id), expected))) {
                return { list: saved, error: LEGACY_VERIFY };
              }
              const finalList = verified.map(publicConfig);
              if (localStorage.getItem(LEGACY_PROXY_KEY) !== raw) {
                return { list: finalList, error: "历史代理数据已变化，请手动处理；当前原数据已保留" };
              }
              localStorage.removeItem(LEGACY_PROXY_KEY);
              return { list: finalList, error: notificationError };
            } catch { return { list: saved, error: LEGACY_VERIFY }; }
          };
          const job = migrate();
          migrationJob.current = job;
          try { result = await job; } finally {
            if (migrationJob.current === job) migrationJob.current = null;
          }
        }
      }
      if (generation !== loadGeneration.current) return;
      setProxies(result.list);
      setErrorMsg(result.error ?? null);
    } catch (err) {
      if (generation === loadGeneration.current && checkTauriRuntime()) {
        setErrorMsg(formatFriendlyError(err));
      }
    } finally {
      if (activeLoad.current === generation) activeLoad.current = null;
      if (generation === loadGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      resetForm();
      setSaving(activeMutation.current !== null);
      void loadProxies();
    }
    return () => {
      loadGeneration.current += 1;
      mutationGeneration.current += 1;
      activeLoad.current = null;
    };
  }, [open]);

  if (!open) return null;

  const handleSelectProxyType = (nextType: ProxyType) => {
    setProxyType(nextType);
    if (nextType === "http" && port === 1080) {
      setPort(7890);
    } else if ((nextType === "socks5" || nextType === "socks4") && port === 7890) {
      setPort(1080);
    }
  };

  const handleStartEdit = (proxy: ProxyServerConfig) => {
    setEditingId(proxy.id);
    setName(proxy.name);
    setProxyType(proxy.proxy_type);
    setHost(proxy.host);
    setPort(proxy.port);
    setUsername(proxy.username || "");
    setPassword("");
    setClearPassword(false);
    setHasStoredPassword(Boolean((proxy as any).has_password || (proxy as any).password_ref));
    setShowPassword(false);
    setNotes(proxy.notes || "");
    setErrorMsg(null);
  };

  const persistList = async (nextList: ProxyServerInput[], generation: number): Promise<string | undefined> => {
    const proxyListSaveFn = getIpcFn("proxyListSave");
    if (!proxyListSaveFn) throw new Error("proxyListSave unavailable");
    const saved = await proxyListSaveFn(nextList);
    if (!Array.isArray(saved)) throw new Error("无法确认代理保存结果，请刷新列表");
    const finalList = saved.map(publicConfig);
    if (generation === mutationGeneration.current) setProxies(finalList);
    try { onChanged?.(finalList); } catch { return "代理已保存，请刷新列表"; }
  };

  const finishMutation = (generation: number) => {
    if (activeMutation.current !== generation) return;
    activeMutation.current = null;
    setSaving(false);
    if (generation !== mutationGeneration.current && openRef.current) void loadProxies();
  };

  const handleSaveProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!openRef.current || activeLoad.current !== null || migrationJob.current || activeMutation.current !== null) return;
    const trimmedName = name.trim();
    const trimmedHost = host.trim();
    const numericPort = Number(port);

    if (!trimmedName) {
      setErrorMsg("请输入代理名称");
      return;
    }
    if (!trimmedHost) {
      setErrorMsg("请输入代理服务器地址 (Host)");
      return;
    }
    if (!Number.isFinite(numericPort) || numericPort < 1 || numericPort > 65535) {
      setErrorMsg("端口必须在 1 ~ 65535 之间");
      return;
    }

    const generation = ++mutationGeneration.current;
    activeMutation.current = generation;
    setSaving(true);
    setErrorMsg(null);
    const now = Math.floor(Date.now() / 1000);

    try {
      let nextList: any[];
      if (editingId) {
        nextList = proxies.map((item) => {
          if (item.id !== editingId) return item;
          const updated: any = {
            ...item,
            name: trimmedName,
            proxy_type: proxyType,
            host: trimmedHost,
            port: numericPort,
            username: username.trim() ? username.trim() : null,
            notes: notes.trim() ? notes.trim() : null,
            updated_at: now,
          };
          if (clearPassword) {
            updated.clear_password = true;
            updated.password = null;
          } else if (password) {
            updated.password = password;
            updated.clear_password = false;
          } else {
            delete updated.password;
            updated.clear_password = false;
          }
          return updated;
        });
      } else {
        const newItem: any = {
          id: generateProxyId(),
          name: trimmedName,
          proxy_type: proxyType,
          host: trimmedHost,
          port: numericPort,
          username: username.trim() ? username.trim() : null,
          password: password ? password : null,
          clear_password: false,
          notes: notes.trim() ? notes.trim() : null,
          created_at: now,
          updated_at: now,
        };
        nextList = [...proxies, newItem];
      }

      const notificationError = await persistList(nextList, generation);
      if (generation === mutationGeneration.current) {
        resetForm();
        if (notificationError) setErrorMsg(notificationError);
      }
    } catch (err) {
      if (generation === mutationGeneration.current) setErrorMsg(formatFriendlyError(err));
    } finally {
      finishMutation(generation);
    }
  };

  const handleDeleteProxy = async (target: ProxyServerConfig) => {
    if (!openRef.current || activeLoad.current !== null || migrationJob.current || activeMutation.current !== null) return;
    const generation = ++mutationGeneration.current;
    activeMutation.current = generation;
    setSaving(true);
    setErrorMsg(null);
    try {
      const nextList = proxies.filter((item) => item.id !== target.id);
      const notificationError = await persistList(nextList, generation);
      if (generation === mutationGeneration.current) {
        if (editingId === target.id) resetForm();
        if (notificationError) setErrorMsg(notificationError);
      }
    } catch (err) {
      if (generation === mutationGeneration.current) setErrorMsg(formatFriendlyError(err));
    } finally {
      finishMutation(generation);
    }
  };

  const runProxyTest = async (key: string, config: ProxyServerConfig) => {
    if (!config.host.trim()) {
      setErrorMsg("请先填写代理服务器地址后再测试连接");
      return;
    }
    setTestingMap((prev) => ({ ...prev, [key]: true }));
    try {
      const proxyTestFn = getIpcFn("proxyTest");
      if (!proxyTestFn) throw new Error("当前环境未连接后端代理测试服务");
      const result = await proxyTestFn(config);
      setTestResults((prev) => ({ ...prev, [key]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [key]: {
          ok: false,
          latency_ms: null,
          message: formatFriendlyError(err),
        },
      }));
    } finally {
      setTestingMap((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleTestFormProxy = () => {
    const draft: any = {
      id: editingId || "__form__",
      name: name.trim() || "未命名代理",
      proxy_type: proxyType,
      host: host.trim(),
      port: Number(port) || 1080,
      username: username.trim() ? username.trim() : null,
      notes: notes.trim() ? notes.trim() : null,
      clear_password: clearPassword,
    };
    if (password) {
      draft.password = password;
    } else if (editingId && hasStoredPassword && !clearPassword) {
      const existing = proxies.find((p) => p.id === editingId);
      if (existing) {
        draft.password_ref = (existing as any).password_ref;
        draft.has_password = true;
      }
    }
    void runProxyTest("__form__", draft);
  };

  const formTestResult = testResults["__form__"];
  const isFormTesting = !!testingMap["__form__"];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim/65 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="代理服务器管理"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line/15 bg-surface text-ink shadow-2xl"
      >
        {/* 顶部标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-line/15 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <GlobeIcon className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-ink">代理服务器管理</h3>

            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-ink-tertiary transition hover:bg-line/5 hover:text-ink"
            title="关闭"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* 主体双栏：左侧已存代理列表 + 右侧新增/编辑表单 */}
        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-line/15 overflow-y-auto md:grid-cols-12 md:divide-x md:divide-y-0">
          {/* 左侧：代理列表 */}
          <div className="flex flex-col p-5 md:col-span-7">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-ink-secondary">
                  已配置代理 ({proxies.length})
                </span>
                <button
                  type="button"
                  onClick={() => void loadProxies()}
                  disabled={saving}
                  className="rounded-md p-1 text-ink-tertiary transition hover:bg-line/5 hover:text-ink"
                  title="刷新代理列表"
                >
                  <RefreshIcon className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </button>
              </div>

              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="inline-flex items-center gap-1 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-1 text-[11px] font-semibold text-accent transition hover:bg-accent/10"
                >
                  <PlusIcon className="h-3 w-3" />
                  <span>切换为新增</span>
                </button>
              )}
            </div>

            {loading ? (
              <div className="flex flex-1 items-center justify-center py-12 text-xs text-ink-tertiary">
                加载代理列表中...
              </div>
            ) : proxies.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-line/20 bg-surface-muted/30 p-8 text-center">
                <GlobeIcon className="mb-2 h-7 w-7 text-ink-tertiary" />
                <p className="text-xs font-medium text-ink-secondary">暂无代理服务器</p>

              </div>
            ) : (
              <div className="space-y-2.5 overflow-y-auto pr-1">
                {proxies.map((proxy) => {
                  const badge = PROXY_TYPE_BADGE[proxy.proxy_type] || PROXY_TYPE_BADGE.socks5;
                  const result = testResults[proxy.id];
                  const isTesting = !!testingMap[proxy.id];
                  const isEditingThis = editingId === proxy.id;

                  return (
                    <div
                      key={proxy.id}
                      className={`rounded-xl border p-3 transition ${
                        isEditingThis
                          ? "border-accent bg-accent/5 ring-1 ring-accent/20"
                          : "border-line/15 bg-surface-muted/30 hover:border-line/25"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-xs font-bold text-ink">
                              {proxy.name}
                            </span>
                            <span
                              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${badge.className}`}
                            >
                              {badge.label}
                            </span>
                            {proxy.username && (
                              <span className="inline-flex items-center gap-1 rounded border border-line/15 bg-surface px-1.5 py-0.5 text-[10px] text-ink-secondary">
                                <KeyIcon className="h-2.5 w-2.5" />
                                {proxy.username}
                              </span>
                            )}
                            {Boolean((proxy as any).has_password || (proxy as any).password_ref) && (
                              <span
                                className="inline-flex items-center gap-1 rounded border border-line/15 bg-surface px-1.5 py-0.5 text-[10px] text-ink-secondary"
                                title="已加密保存凭据"
                              >
                                <LockIcon className="h-2.5 w-2.5 text-accent" />
                              </span>
                            )}
                          </div>

                          <div className="mt-1 font-mono text-[11px] text-ink-secondary">
                            {proxy.host}:{proxy.port}
                          </div>

                          {proxy.notes && (
                            <div className="mt-1 truncate text-[11px] text-ink-tertiary" title={proxy.notes}>
                              备注：{proxy.notes}
                            </div>
                          )}

                          {result && (
                            <div
                              className={`mt-1.5 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
                                result.ok
                                  ? "bg-state-success/10 text-state-success"
                                  : "bg-state-danger/10 text-state-danger"
                              }`}
                            >
                              <span>
                                {result.ok
                                  ? `✓ 连通 (${result.latency_ms ?? 0} ms)`
                                  : `✗ ${result.message || "连接失败"}`}
                              </span>
                            </div>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void runProxyTest(proxy.id, proxy)}
                            disabled={isTesting}
                            className="rounded-lg border border-line/15 bg-surface px-2 py-1 text-[11px] font-medium text-ink-secondary transition hover:bg-surface-muted hover:text-ink disabled:opacity-50"
                          >
                            {isTesting ? "测试中..." : "测试连接"}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleStartEdit(proxy)}
                            className="rounded-lg p-1.5 text-ink-tertiary transition hover:bg-line/10 hover:text-ink"
                            title="编辑代理"
                            aria-label={`编辑代理 ${proxy.name}`}
                          >
                            <PencilIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDeleteProxy(proxy)}
                            disabled={loading || saving}
                            className="rounded-lg p-1.5 text-ink-tertiary transition hover:bg-state-danger/10 hover:text-state-danger"
                            title="删除代理"
                            aria-label={`删除代理 ${proxy.name}`}
                          >
                            <TrashIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 右侧：新增 / 编辑表单 */}
          <form onSubmit={handleSaveProxy} className="flex flex-col justify-between p-5 md:col-span-5">
            <div className="space-y-3.5">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-ink">
                  {editingId ? "编辑代理服务器" : "新增代理服务器"}
                </h4>
                {editingId && (
                  <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    编辑模式
                  </span>
                )}
              </div>

              {errorMsg && (
                <div
                  role="alert"
                  className="rounded-xl border border-state-danger/30 bg-state-danger/10 px-3 py-2 text-xs text-state-danger"
                >
                  {errorMsg}
                </div>
              )}

              <div>
                <label htmlFor="proxy-name" className="mb-1 block text-xs font-semibold text-ink-secondary">
                  代理名称<RequiredMark value={name} />
                </label>
                <input
                  id="proxy-name"
                  aria-required="true"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="代理名称"
                  className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-secondary">
                  代理类型
                </label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["socks5", "socks4", "http"] as ProxyType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleSelectProxyType(t)}
                      className={`rounded-xl border py-1.5 text-xs font-semibold uppercase transition ${
                        proxyType === t
                          ? "border-accent bg-action/10 text-accent shadow-apple-sm"
                          : "border-line/15 bg-surface-muted/40 text-ink-secondary hover:text-ink"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <label htmlFor="proxy-host" className="mb-1 block text-xs font-semibold text-ink-secondary">
                    服务器地址<RequiredMark value={host} />
                  </label>
                  <input
                    id="proxy-host"
                    aria-required="true"
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    aria-label="服务器地址"
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </div>
                <div>
                  <label htmlFor="proxy-port" className="mb-1 block text-xs font-semibold text-ink-secondary">
                    端口<RequiredMark value={port > 0 ? port : ""} />
                  </label>
                  <input
                    id="proxy-port"
                    aria-required="true"
                    type="number"
                    min={1}
                    max={65535}
                    value={port > 0 ? port : ""}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-ink-secondary">
                    用户名
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    aria-label="用户名"
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="block text-xs font-semibold text-ink-secondary">
                      密码
                      {editingId && hasStoredPassword && !clearPassword && (
                        <span className="ml-1.5 font-normal text-accent text-[11px]">已存</span>
                      )}
                    </label>
                    {editingId && hasStoredPassword && (
                      <label className="flex items-center gap-1 text-[11px] text-ink-tertiary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={clearPassword}
                          onChange={(e) => {
                            setClearPassword(e.target.checked);
                            if (e.target.checked) setPassword("");
                          }}
                          className="rounded border-line/20 text-accent"
                        />
                        <span>清除</span>
                      </label>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      disabled={clearPassword}
                      onChange={(e) => setPassword(e.target.value)}
                      aria-label="密码"
                      className="w-full rounded-xl border border-line/15 bg-surface-muted/50 py-2 pl-3 pr-8 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
                    />
                    <button
                      type="button"
                      disabled={clearPassword}
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-2 text-ink-tertiary hover:text-ink-secondary disabled:opacity-30"
                      title={showPassword ? "隐藏密码" : "显示密码"}
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    >
                      {showPassword ? (
                        <EyeOffIcon className="h-3.5 w-3.5" />
                      ) : (
                        <EyeIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-ink-secondary">
                  备注
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  aria-label="备注"
                  className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
              </div>

              {formTestResult && (
                <div
                  className={`rounded-xl border px-3 py-2 text-xs font-medium ${
                    formTestResult.ok
                      ? "border-state-success/30 bg-state-success/10 text-state-success"
                      : "border-state-danger/30 bg-state-danger/10 text-state-danger"
                  }`}
                >
                  {formTestResult.ok
                    ? `✓ 连通 (${formTestResult.latency_ms ?? 0} ms) — ${formTestResult.message}`
                    : `✗ 测试失败：${formTestResult.message}`}
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between gap-2 border-t border-line/15 pt-3.5">
              <button
                type="button"
                onClick={handleTestFormProxy}
                disabled={isFormTesting}
                className="rounded-xl border border-line/20 bg-surface px-3 py-2 text-xs font-semibold text-ink-secondary transition hover:bg-surface-muted hover:text-ink disabled:opacity-50"
              >
                {isFormTesting ? "测试中..." : "测试当前配置"}
              </button>

              <div className="flex items-center gap-2">
                {editingId && (
                  <button
                    type="button"
                    onClick={resetForm}
                    className="rounded-xl border border-line/15 px-3 py-2 text-xs font-medium text-ink-secondary transition hover:bg-line/5"
                  >
                    取消
                  </button>
                )}
                <button
                  type="submit"
                  disabled={loading || saving}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-action px-4 py-2 text-xs font-semibold text-white shadow-apple-sm transition hover:bg-action/90 disabled:opacity-50"
                >
                  <CheckIcon className="h-3.5 w-3.5" />
                  <span>{saving ? "保存中..." : editingId ? "保存修改" : "添加代理"}</span>
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* 底部栏 */}
        <div className="flex shrink-0 items-center justify-end border-t border-line/15 bg-surface-muted/40 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-line/15 bg-surface px-4 py-1.5 text-xs font-semibold text-ink-secondary transition hover:bg-surface-muted"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
