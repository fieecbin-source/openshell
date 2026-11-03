import React, { useState, useEffect } from "react";
import type {
  AuthMethod,
  HostKeyPolicy,
  Protocol,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialStopBits,
  Session,
  SessionInput,
  SshKey,
} from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useSerialStore } from "../stores/serialStore";
import { useVaultStore } from "../stores/vaultStore";
import {
  createCredential,
  deleteSshKey,
  listSshKeys,
} from "../lib/ipc";
import { formatFriendlyError, parseIpcError } from "../lib/errors";
import { SshKeyImportModal } from "./SshKeyImportModal";
import { Button, IconButton } from "./ui/Button";
import { Select } from "./ui/Field";
import { KeyRound, Trash2 } from "lucide-react";

interface SessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingSession?: Session | null;
  initialValues?: Partial<SessionInput>;
  onConnectSession?: (session: Session) => void;
}

const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

interface VaultInlineUnlockProps {
  /** 说明当前为什么要解锁（保存密码 / 导入私钥） */
  reason: string;
  uninitialized: boolean;
  password: string;
  onPasswordChange: (value: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * 弹窗内的保险库解锁卡片。
 *
 * 保存密码和导入私钥都要写入加密保险库，两者共用同一个解锁入口：
 * 否则用户只会看到「主保险库已锁定」，却在弹窗里找不到解锁的地方。
 */
const VaultInlineUnlock: React.FC<VaultInlineUnlockProps> = ({
  reason,
  uninitialized,
  password,
  onPasswordChange,
  busy,
  error,
  onSubmit,
}) => (
  <div className="mt-2 p-2.5 rounded-xl border border-state-warning/30 bg-state-warning/10 space-y-2 text-xs">
    <div className="flex items-center gap-1.5 font-semibold text-state-warning">
      <span>⚠️ 主保险库当前未解锁</span>
    </div>
    <p className="text-[11px] text-state-warning leading-relaxed">
      {uninitialized
        ? `检测到主保险库尚未初始化。请输入主密码一键创建保险库，${reason}将以 XChaCha20 密文安全加密保存：`
        : `需要解锁主保险库才能${reason}。请输入主密码即刻解锁：`}
    </p>
    <div className="flex gap-2">
      <input
        type="password"
        aria-label="保险库主密码"
        value={password}
        onChange={(e) => onPasswordChange(e.target.value)}
        className="flex-1 rounded-lg border border-state-warning/30 bg-surface px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:border-state-warning/30"
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || !password}
        className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-semibold text-xs hover:bg-amber-700 disabled:opacity-50 transition"
      >
        {busy ? "处理中..." : uninitialized ? "设置主密码并初始化" : "即刻解锁"}
      </button>
    </div>
    {error && <div className="text-[11px] text-state-danger">{error}</div>}
  </div>
);

export const SessionModal: React.FC<SessionModalProps> = ({
  isOpen,
  onClose,
  editingSession,
  initialValues,
  onConnectSession,
}) => {
  const { sessions, groups, createSession, updateSession } = useSessionStore();
  const { ports, loadPorts, loadingPorts } = useSerialStore();
  const {
    status: vaultStatus,
    unlock: unlockVault,
    init: initVault,
    checkStatus: refreshVaultStatus,
  } = useVaultStore();

  const [activeTab, setActiveTab] = useState<"general" | "advanced">("general");

  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // SSH Fields
  const [host, setHost] = useState("");
  // 端口/用户名为空时按默认值处理（22 / root），输入框本身不预填，保持界面干净
  const [port, setPort] = useState(0);
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hostKeyPolicy, setHostKeyPolicy] = useState<HostKeyPolicy>("accept_new");
  const [keepaliveSec, setKeepaliveSec] = useState<number>(30);
  const [jumpHostSessionId, setJumpHostSessionId] = useState<string>("");

  // 已保存的私钥仅按名称选择；导入在独立弹窗中完成。
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [connectAfterSave, setConnectAfterSave] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [keyImportOpen, setKeyImportOpen] = useState(false);

  // Serial Fields
  const [serialPort, setSerialPort] = useState("COM1");
  const [baudRate, setBaudRate] = useState(115200);
  const [customBaud, setCustomBaud] = useState(false);
  const [dataBits, setDataBits] = useState<SerialDataBits>("eight");
  const [stopBits, setStopBits] = useState<SerialStopBits>("one");
  const [parity, setParity] = useState<SerialParity>("none");
  const [flowControl, setFlowControl] = useState<SerialFlowControl>("none");
  const [dtrOnOpen, setDtrOnOpen] = useState(true);
  const [rtsOnOpen, setRtsOnOpen] = useState(true);
  const [autoReconnect, setAutoReconnect] = useState(false);

  // Vault Inline State
  const [vaultPassword, setVaultPassword] = useState("");
  const [unlockingVault, setUnlockingVault] = useState(false);
  const [vaultUnlockError, setVaultUnlockError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = async (preferId?: string) => {
    try {
      const keys = await listSshKeys();
      setSshKeys(keys);
      if (preferId && keys.some((k) => k.id === preferId)) {
        setSelectedKeyId(preferId);
      } else {
        setSelectedKeyId((prev) => {
          if (prev && keys.some((k) => k.id === prev)) {
            return prev;
          }
          return keys.length > 0 ? keys[0].id : "";
        });
      }
    } catch {
      // ignore
    }
  };

  /** 删除即清理：移除配置记录并解除当前会话绑定（不动磁盘文件） */
  const handleDeleteKey = async (key: SshKey) => {
    if (
      !window.confirm(
        `确认移除私钥配置「${key.name}」？\n\n只会删除 OpenShell 内的配置记录，不会改动硬盘上的私钥文件。`
      )
    ) {
      return;
    }
    try {
      await deleteSshKey(key.id);
      if (selectedKeyId === key.id) {
        setSelectedKeyId("");
      }
      await loadKeys();
      setKeyMsg(`已移除私钥配置「${key.name}」`);
    } catch (err) {
      setKeyMsg(formatFriendlyError(err));
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadPorts();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      if (editingSession) {
        setName(editingSession.name);
        setGroupId(editingSession.group_id || "");
        setProtocol(editingSession.protocol || "ssh");
        setNotes(editingSession.notes || "");

        if (editingSession.protocol === "serial") {
          const opts = editingSession.protocol_options_json || {};
          setSerialPort(opts.port_name || "COM1");
          setBaudRate(opts.baud_rate || 115200);
          setDataBits(opts.data_bits || "eight");
          setStopBits(opts.stop_bits || "one");
          setParity(opts.parity || "none");
          setFlowControl(opts.flow_control || "none");
          setDtrOnOpen(opts.dtr_on_open !== false);
          setRtsOnOpen(opts.rts_on_open !== false);
          setAutoReconnect(opts.auto_reconnect || false);
          setCustomBaud(!COMMON_BAUD_RATES.includes(opts.baud_rate || 115200));
        } else {
          setHost(editingSession.host || "");
          setPort(editingSession.port || 22);
          setUsername(editingSession.username || "");
          setAuthMethod(editingSession.auth_method || "password");
          setHostKeyPolicy(editingSession.host_key_policy || "accept_new");
          const keyId = editingSession.ssh_key_id || "";
          setSelectedKeyId(keyId);
          loadKeys(keyId);
          setKeepaliveSec(editingSession.keepalive_sec || 30);
          setPassword("");

          if (editingSession.proxy_jump_json?.session_id) {
            setJumpHostSessionId(editingSession.proxy_jump_json.session_id);
          } else {
            setJumpHostSessionId("");
          }
        }
      } else {
        // 智能解析从快速连接传入的 initialValues
        const parsedName = initialValues?.name || "";
        let parsedHost = initialValues?.host || "";
        // 不预填默认值：解析不到就留空，保存时再回落到 22 / root
        let parsedPort = initialValues?.port || 0;
        let parsedUser = initialValues?.username || "";

        if (parsedName && !parsedHost && parsedName.includes("@")) {
          const [u, rest] = parsedName.split("@");
          parsedUser = u;
          if (rest.includes(":")) {
            const [h, p] = rest.split(":");
            parsedHost = h;
            parsedPort = parseInt(p, 10) || 22;
          } else {
            parsedHost = rest;
          }
        }

        setName(parsedName);
        setGroupId(initialValues?.group_id || "");
        setProtocol(initialValues?.protocol || "ssh");
        setNotes(initialValues?.notes || "");
        setHost(parsedHost);
        setPort(parsedPort);
        setUsername(parsedUser);
        setAuthMethod(initialValues?.auth_method || "password");
        setHostKeyPolicy(initialValues?.host_key_policy || "accept_new");
        const keyId = initialValues?.ssh_key_id || "";
        setSelectedKeyId(keyId);
        loadKeys(keyId);
        setPassword("");
        setJumpHostSessionId("");
        setKeepaliveSec(30);

        setSerialPort(ports[0]?.name || "COM1");
        setBaudRate(115200);
        setDataBits("eight");
        setStopBits("one");
        setParity("none");
        setFlowControl("none");
        setDtrOnOpen(true);
        setRtsOnOpen(true);
        setAutoReconnect(false);
        setCustomBaud(false);
      }
      setError(null);
      setKeyImportOpen(false);
      setVaultUnlockError(null);
      setShowPassword(false);
    }
  }, [editingSession, isOpen, initialValues]);

  if (!isOpen) return null;

  const isVaultLocked = vaultStatus && vaultStatus.state !== "unlocked";
  const isVaultUninitialized = vaultStatus?.state === "uninitialized";

  const handleInlineVaultUnlock = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault();
    if (!vaultPassword) return;
    setUnlockingVault(true);
    setVaultUnlockError(null);
    try {
      if (isVaultUninitialized) {
        await initVault(vaultPassword);
      } else {
        await unlockVault(vaultPassword);
      }
      setVaultPassword("");
    } catch (err: any) {
      setVaultUnlockError(formatFriendlyError(err));
    } finally {
      setUnlockingVault(false);
    }
  };

  const isPublicKeyAuth = (m?: string) => m === "publickey" || m === "public_key";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 自动补全名称
    let sessionName = name.trim();
    if (!sessionName) {
      if (protocol === "ssh") {
        sessionName = host.trim() ? `${username || "root"}@${host.trim()}` : "未命名 SSH 会话";
      } else {
        sessionName = serialPort.trim() ? `Serial-${serialPort.trim()}` : "未命名串口会话";
      }
    }

    if (protocol === "ssh") {
      if (!host.trim()) {
        setError("请输入主机地址 (IP 或域名)");
        setActiveTab("general");
        return;
      }
    } else if (protocol === "serial") {
      if (!serialPort.trim()) {
        setError("请选择或输入串口设备名称");
        return;
      }
    }

    setIsSubmitting(true);
    setError(null);

    let savedSession: Session | undefined;

    try {
      const effectiveGroupId = groupId && groupId.trim() ? groupId.trim() : null;

      if (protocol === "ssh") {
        let credentialId = editingSession?.credential_id || null;

        // 如果设置了密码并且认证方式是密码
        if (authMethod === "password") {
          if (password) {
            if (isVaultLocked) {
              setError("主保险库尚未解锁，请在下方输入主密码快速解锁后再加密保存密码");
              setActiveTab("general");
              setIsSubmitting(false);
              return;
            }
            try {
              const cred = await createCredential(
                `${sessionName} (${username || "root"})`,
                "password",
                password,
                username || "root"
              );
              credentialId = cred.id;
            } catch (credErr: any) {
              console.warn("保存凭据失败", credErr);
              // 前端状态可能没跟上自动锁定：先把真实状态拉回来，解锁卡片才会出现
              if (parseIpcError(credErr).code === "VAULT_LOCKED") {
                await refreshVaultStatus();
                setActiveTab("general");
              }
              throw new Error(`保存密码凭据失败：${formatFriendlyError(credErr)}`);
            }
          }
        } else if (isPublicKeyAuth(authMethod)) {
          // 公钥认证时清理残留密码凭据，避免外键和凭据不一致
          credentialId = null;
        }

        const effectivePort = port > 0 && port <= 65535 ? port : 22;
        const proxyJumpJson = jumpHostSessionId ? { session_id: jumpHostSessionId } : null;

        let effectiveKeyId: string | null = null;
        if (isPublicKeyAuth(authMethod)) {
          if (selectedKeyId && selectedKeyId.trim()) {
            effectiveKeyId = selectedKeyId.trim();
          } else if (sshKeys.length > 0) {
            effectiveKeyId = sshKeys[0].id;
            setSelectedKeyId(sshKeys[0].id);
          } else {
            setError("请先导入或选择一个 SSH 私钥后再保存会话");
            setIsSubmitting(false);
            return;
          }
        }

        const effectiveAuthMethod: AuthMethod = isPublicKeyAuth(authMethod) ? "public_key" : (authMethod as AuthMethod);

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, {
            name: sessionName,
            group_id: effectiveGroupId,
            protocol: "ssh",
            host: host.trim(),
            port: effectivePort,
            username: username.trim() || "root",
            auth_method: effectiveAuthMethod,
            credential_id: credentialId,
            ssh_key_id: effectiveKeyId,
            host_key_policy: hostKeyPolicy,
            proxy_jump_json: proxyJumpJson,
            color: null,
            notes: notes && notes.trim() ? notes.trim() : null,
            keepalive_sec: keepaliveSec,
          });
        } else {
          const input: SessionInput = {
            name: sessionName,
            group_id: effectiveGroupId,
            protocol: "ssh",
            host: host.trim(),
            port: effectivePort,
            username: username.trim() || "root",
            auth_method: effectiveAuthMethod,
            credential_id: credentialId,
            ssh_key_id: effectiveKeyId,
            host_key_policy: hostKeyPolicy,
            proxy_jump_json: proxyJumpJson,
            color: null,
            notes: notes && notes.trim() ? notes.trim() : null,
            keepalive_sec: keepaliveSec,
          };
          savedSession = await createSession(input);
        }
      } else if (protocol === "serial") {
        const serialOptions = {
          port_name: serialPort.trim(),
          baud_rate: Number(baudRate),
          data_bits: dataBits,
          stop_bits: stopBits,
          parity: parity,
          flow_control: flowControl,
          dtr_on_open: dtrOnOpen,
          rts_on_open: rtsOnOpen,
          auto_reconnect: autoReconnect,
          input_newline: "crlf",
          output_newline: "lf_to_crlf",
          local_echo: false,
          reconnect_interval_ms: 1500,
        };

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, {
            name: sessionName,
            group_id: effectiveGroupId,
            protocol: "serial",
            color: null,
            notes: notes && notes.trim() ? notes.trim() : null,
            protocol_options_json: serialOptions,
          });
        } else {
          const input: SessionInput = {
            name: sessionName,
            group_id: effectiveGroupId,
            protocol: "serial",
            color: null,
            notes: notes && notes.trim() ? notes.trim() : null,
            protocol_options_json: serialOptions,
          };
          savedSession = await createSession(input);
        }
      }

      onClose();

      if (connectAfterSave && savedSession && onConnectSession) {
        onConnectSession(savedSession);
      }
    } catch (err: any) {
      console.error("保存会话失败详情:", err);
      setError(formatFriendlyError(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // 过滤可选跳板机会话（排除自身）
  const selectedKey = sshKeys.find((key) => key.id === selectedKeyId);
  const candidateJumpHosts = sessions.filter(
    (s) => s.protocol === "ssh" && (!editingSession || s.id !== editingSession.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-line/10 bg-surface p-6 shadow-2xl flex flex-col max-h-[92vh] text-ink transition-all">
        {/* 顶部标题与协议切换 */}
        <div className="mb-4 flex items-center justify-between border-b border-line/15 pb-3.5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-action/10 text-accent font-bold text-sm">
              {protocol === "ssh" ? "⚡" : "🔌"}
            </div>
            <h3 className="text-base font-semibold text-ink tracking-tight">
              {editingSession ? "编辑会话配置" : "新建连接会话"}
            </h3>
          </div>

          <div className="flex items-center gap-2">
            {/* 协议类型切换 (Apple Capsule Segment) */}
            <div className="flex bg-line/5 p-0.5 rounded-lg border border-line/15 text-xs">
              <button
                type="button"
                onClick={() => setProtocol("ssh")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  protocol === "ssh"
                    ? "bg-surface text-accent font-semibold shadow-apple-sm"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                SSH 主机
              </button>
              <button
                type="button"
                onClick={() => setProtocol("serial")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  protocol === "serial"
                    ? "bg-surface text-accent font-semibold shadow-apple-sm"
                    : "text-ink-secondary hover:text-ink"
                }`}
              >
                串口 (Serial)
              </button>
            </div>

            <button
              onClick={onClose}
              className="text-ink-tertiary hover:text-ink-secondary p-1.5 rounded-full hover:bg-line/5 transition"
              title="关闭"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* SSH 模式下的标签页导航 */}
        {protocol === "ssh" && (
          <div className="flex items-center space-x-1 border-b border-line/15 mb-4 shrink-0 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("general")}
              className={`pb-2 px-3 border-b-2 font-medium transition ${
                activeTab === "general"
                  ? "border-accent text-accent font-bold"
                  : "border-transparent text-ink-secondary hover:text-ink"
              }`}
            >
              基础连接与凭据
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("advanced")}
              className={`pb-2 px-3 border-b-2 font-medium transition flex items-center gap-1.5 ${
                activeTab === "advanced"
                  ? "border-accent text-accent font-bold"
                  : "border-transparent text-ink-secondary hover:text-ink"
              }`}
            >
              <span>高级与跳板机</span>
              {jumpHostSessionId && (
                <span className="h-1.5 w-1.5 rounded-full bg-state-warning" />
              )}
            </button>
          </div>
        )}

        <form
          id="session-modal-form"
          onSubmit={handleSubmit}
          className="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1"
        >
          {/* ================= SSH 基础连接与主要凭据 ================= */}
          {protocol === "ssh" && activeTab === "general" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    会话显示名称
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    所属树状分组
                  </label>
                  <select
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    <option value="">无分组</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        📁 {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    主机地址 (IP / 域名) *
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    autoFocus
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    SSH 端口
                  </label>
                  <input
                    type="number"
                    value={port > 0 ? port : ""}
                    onChange={(e) => setPort(e.target.value === "" ? 0 : Number(e.target.value))}
                    min={1}
                    max={65535}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  登录用户名
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink placeholder-ink-tertiary focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                />
              </div>

              {/* 核心认证区 (平铺展示密码与公钥管理) */}
              <div className="pt-2 border-t border-line/15">
                <label className="block text-xs font-semibold text-ink-secondary mb-2">
                  认证方式与安全凭据
                </label>

                <div className="grid grid-cols-3 gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => setAuthMethod("password")}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${
                      authMethod === "password"
                        ? "bg-action/5 border-accent text-accent ring-1 ring-accent/30 shadow-apple-sm"
                        : "bg-surface-muted/60 border-line/15 text-ink-secondary hover:bg-line/5"
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1.5">
                      <span>🔑 密码认证</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setAuthMethod("public_key");
                      if (!selectedKeyId && sshKeys.length > 0) {
                        setSelectedKeyId(sshKeys[0].id);
                      }
                    }}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${
                      isPublicKeyAuth(authMethod)
                        ? "bg-action/5 border-accent text-accent ring-1 ring-accent/30 shadow-apple-sm"
                        : "bg-surface-muted/60 border-line/15 text-ink-secondary hover:bg-line/5"
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1.5">
                      <span>🛡️ 公钥连接</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAuthMethod("keyboard_interactive")}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${
                      authMethod === "keyboard_interactive"
                        ? "bg-action/5 border-accent text-accent ring-1 ring-accent/30 shadow-apple-sm"
                        : "bg-surface-muted/60 border-line/15 text-ink-secondary hover:bg-line/5"
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1.5">
                      <span>💬 交互式验证</span>
                    </div>
                  </button>
                </div>

                {/* 密码输入区 */}
                {authMethod === "password" && (
                  <div className="rounded-xl border border-line/15 bg-surface-muted/40 p-3 space-y-2">
                    <label className="block text-xs font-medium text-ink-secondary">
                      连接密码
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full rounded-lg border border-line/15 bg-surface px-3 py-2 pr-10 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2.5 top-2 text-ink-tertiary hover:text-ink-secondary text-xs p-0.5"
                        title={showPassword ? "隐藏密码" : "显示密码"}
                      >
                        {showPassword ? "🙈" : "👁️"}
                      </button>
                    </div>

                    {/* 保险库未解锁 / 未初始化提示卡片 */}
                    {isVaultLocked && password && (
                      <VaultInlineUnlock
                        reason="加密保存新密码凭据"
                        uninitialized={!!isVaultUninitialized}
                        password={vaultPassword}
                        onPasswordChange={setVaultPassword}
                        busy={unlockingVault}
                        error={vaultUnlockError}
                        onSubmit={handleInlineVaultUnlock}
                      />
                    )}
                  </div>
                )}

                {isPublicKeyAuth(authMethod) && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Select
                          aria-label="已保存的私钥"
                          value={selectedKeyId}
                          onChange={(e) => { setSelectedKeyId(e.target.value); setKeyMsg(null); }}
                        >
                          <option value="">{sshKeys.length ? "请选择私钥" : "暂无已保存的私钥"}</option>
                          {sshKeys.map((key) => <option key={key.id} value={key.id}>{key.name}</option>)}
                        </Select>
                      </div>
                      <Button onClick={() => setKeyImportOpen(true)}>导入私钥</Button>
                      {selectedKeyId && (
                        <IconButton label="移除选中的私钥配置" onClick={() => {
                          const key = sshKeys.find((item) => item.id === selectedKeyId);
                          if (key) handleDeleteKey(key);
                        }}><Trash2 className="h-4 w-4" /></IconButton>
                      )}
                    </div>
                    {selectedKey && (
                      <div role="status" aria-label="当前私钥" className="flex min-w-0 items-center gap-2.5 rounded-xl bg-action/5 px-4 py-3 text-accent">
                        <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate text-sm font-semibold" title={selectedKey.name}>
                          {selectedKey.name}
                        </span>
                      </div>
                    )}
                    {keyMsg && <p role="status" className="text-xs text-ink-secondary">{keyMsg}</p>}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================= SSH 高级配置 & 跳板机 ================= */}
          {protocol === "ssh" && activeTab === "advanced" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  跳板机链路 (ProxyJump Bastion)
                </label>
                <select
                  value={jumpHostSessionId}
                  disabled
                  onChange={(e) => setJumpHostSessionId(e.target.value)}
                  className="w-full cursor-not-allowed rounded-xl border border-line/15 bg-line/5 px-3 py-2 text-xs text-ink-secondary focus:outline-none"
                >
                  <option value="">不使用跳板机</option>
                  {candidateJumpHosts.map((s) => (
                    <option key={s.id} value={s.id}>
                      🚀 经由 {s.name} ({s.username || "root"}@{s.host}:{s.port || 22})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    主机密钥校验策略
                  </label>
                  <select
                    value={hostKeyPolicy}
                    onChange={(e) => setHostKeyPolicy(e.target.value as HostKeyPolicy)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    <option value="accept_new">自动接受首次连接 (Accept New - 推荐)</option>
                    <option value="strict">严格校验 (Strict - 仅已知公钥)</option>
                    <option value="insecure">不校验主机密钥 (Insecure - 仅用于开发测试)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    心跳保活间隔 (KeepAlive 秒)
                  </label>
                  <input
                    type="number"
                    value={keepaliveSec}
                    onChange={(e) => setKeepaliveSec(Number(e.target.value))}
                    min={5}
                    max={600}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  备注说明 (Notes)
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                />
              </div>
            </div>
          )}

          {/* ================= 串口配置区 (Serial) ================= */}
          {protocol === "serial" && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-ink-secondary">
                    串口设备 (Port) *
                  </label>
                  <button
                    type="button"
                    onClick={() => loadPorts()}
                    className="text-[11px] text-accent hover:underline flex items-center gap-1"
                  >
                    <span className={loadingPorts ? "animate-spin" : ""}>🔄</span> 刷新设备列表
                  </button>
                </div>
                <div className="flex gap-2">
                  <select
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    className="flex-1 rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink font-mono focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    {ports.length === 0 ? (
                      <option value="COM1">COM1 (自动回环/模拟串口)</option>
                    ) : (
                      ports.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.name} {p.manufacturer ? `(${p.manufacturer})` : ""}
                        </option>
                      ))
                    )}
                  </select>
                  <input
                    type="text"
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    placeholder="或手动输入"
                    className="w-32 rounded-xl border border-line/15 bg-surface px-2.5 py-2 text-xs font-mono text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-ink-secondary">
                    波特率 (Baud Rate) *
                  </label>
                  <button
                    type="button"
                    onClick={() => setCustomBaud(!customBaud)}
                    className="text-[11px] text-ink-secondary hover:text-ink"
                  >
                    {customBaud ? "返回常用列表" : "自定义数值"}
                  </button>
                </div>
                {customBaud ? (
                  <input
                    type="number"
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    placeholder="如 1500000"
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs font-mono text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {COMMON_BAUD_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => setBaudRate(rate)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition ${
                          baudRate === rate
                            ? "bg-action text-white border-accent font-bold shadow-apple-sm"
                            : "bg-surface-muted text-ink-secondary border-line/15 hover:border-line/25 hover:bg-line/5"
                        }`}
                      >
                        {rate}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    数据位 (Data Bits)
                  </label>
                  <select
                    value={dataBits}
                    onChange={(e) => setDataBits(e.target.value as SerialDataBits)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-2 py-1.5 text-xs text-ink font-mono focus:border-accent focus:outline-none transition"
                  >
                    <option value="eight">8</option>
                    <option value="seven">7</option>
                    <option value="six">6</option>
                    <option value="five">5</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    停止位 (Stop Bits)
                  </label>
                  <select
                    value={stopBits}
                    onChange={(e) => setStopBits(e.target.value as SerialStopBits)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-2 py-1.5 text-xs text-ink font-mono focus:border-accent focus:outline-none transition"
                  >
                    <option value="one">1</option>
                    <option value="one_point_five">1.5</option>
                    <option value="two">2</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    校验位 (Parity)
                  </label>
                  <select
                    value={parity}
                    onChange={(e) => setParity(e.target.value as SerialParity)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-2 py-1.5 text-xs text-ink font-mono focus:border-accent focus:outline-none transition"
                  >
                    <option value="none">None (无校验)</option>
                    <option value="even">Even (偶校验)</option>
                    <option value="odd">Odd (奇校验)</option>
                    <option value="mark">Mark</option>
                    <option value="space">Space</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    流控方式 (Flow Control)
                  </label>
                  <select
                    value={flowControl}
                    onChange={(e) => setFlowControl(e.target.value as SerialFlowControl)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-2 py-1.5 text-xs text-ink font-mono focus:border-accent focus:outline-none transition"
                  >
                    <option value="none">None (无流控)</option>
                    <option value="hardware">RTS / CTS 硬件流控</option>
                    <option value="software">XON / XOFF 软件流控</option>
                  </select>
                </div>

                <div className="flex flex-col justify-end gap-1.5">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={dtrOnOpen}
                      onChange={(e) => setDtrOnOpen(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent focus:ring-accent"
                    />
                    <span>打开端口时拉高 DTR</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={rtsOnOpen}
                      onChange={(e) => setRtsOnOpen(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent focus:ring-accent"
                    />
                    <span>打开端口时拉高 RTS</span>
                  </label>
                </div>
              </div>
            </div>
          )}

        </form>

        {/* 错误提示固定在底部操作栏上方：不随表单滚动，保证一定能看到 */}
        {error && (
          <div
            role="alert"
            className="mt-3 flex shrink-0 items-start gap-2 rounded-xl border border-state-danger/30 bg-state-danger/10 px-3 py-2.5 text-xs text-state-danger shadow-apple-sm"
          >
            <span className="mt-0.5 shrink-0 text-sm leading-none">⛔</span>
            <span className="font-medium leading-relaxed break-words">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-auto shrink-0 rounded-md px-1 text-state-danger hover:bg-state-danger/10 hover:text-state-danger"
              title="关闭提示"
            >
              ✕
            </button>
          </div>
        )}

        {/* 常驻底部操作栏：不随内容滚动，「保存并连接」永远可见 */}
        <div className="mt-3 flex shrink-0 items-center justify-between gap-3 border-t border-line/15 pt-3">
          <div className="min-w-0 text-[11px] text-ink-tertiary">
            {isPublicKeyAuth(authMethod) && protocol === "ssh" ? (
              selectedKey ? (
                <span>公钥连接</span>
              ) : (
                <span className="text-state-warning">⚠️ 尚未选择私钥，可能无法免密登录</span>
              )
            ) : (
              <span>{protocol === "ssh" ? "🔑 密码认证" : "🔌 串口会话"}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-line/15 px-4 py-2 text-xs font-medium text-ink-secondary hover:bg-line/5 transition"
            >
              取消
            </button>
            <button
              type="submit"
              form="session-modal-form"
              onClick={() => setConnectAfterSave(false)}
              disabled={isSubmitting}
              className="rounded-xl border border-line/25 bg-surface px-4 py-2 text-xs font-semibold text-ink-secondary hover:bg-surface-muted transition disabled:opacity-50"
            >
              {isSubmitting && !connectAfterSave ? "保存中..." : "仅保存"}
            </button>
            {onConnectSession && (
              <button
                type="submit"
                form="session-modal-form"
                onClick={() => setConnectAfterSave(true)}
                disabled={isSubmitting}
                className="flex items-center gap-1.5 rounded-xl bg-action px-5 py-2 text-xs font-semibold text-white shadow-apple-md hover:bg-action transition disabled:opacity-50"
              >
                <span>⚡</span>
                <span>{isSubmitting && connectAfterSave ? "保存并连接中..." : "保存并立即连接"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {keyImportOpen && (
        <SshKeyImportModal
          onClose={() => { setKeyImportOpen(false); setVaultPassword(""); setVaultUnlockError(null); }}
          onSaved={(key) => {
            setSshKeys((keys) => keys.some((item) => item.id === key.id)
              ? keys.map((item) => item.id === key.id ? key : item)
              : [...keys, key]);
            setSelectedKeyId(key.id);
            setKeyMsg(null);
            setKeyImportOpen(false);
          }}
          vaultUnlock={isVaultLocked ? (
            <VaultInlineUnlock
              reason="导入 SSH 私钥"
              uninitialized={!!isVaultUninitialized}
              password={vaultPassword}
              onPasswordChange={setVaultPassword}
              busy={unlockingVault}
              error={vaultUnlockError}
              onSubmit={handleInlineVaultUnlock}
            />
          ) : null}
        />
      )}
    </div>
  );
};
