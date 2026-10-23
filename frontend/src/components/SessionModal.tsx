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
import { createCredential, listSshKeys, setSshKeyPassphrase } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { SshKeyManagerModal } from "./SshKeyManagerModal";

interface SessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingSession?: Session | null;
  initialValues?: Partial<SessionInput>;
  onConnectSession?: (session: Session) => void;
}

const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

export const SessionModal: React.FC<SessionModalProps> = ({
  isOpen,
  onClose,
  editingSession,
  initialValues,
  onConnectSession,
}) => {
  const { sessions, groups, createSession, updateSession } = useSessionStore();
  const { ports, loadPorts, loadingPorts } = useSerialStore();
  const { status: vaultStatus, unlock: unlockVault, init: initVault } = useVaultStore();

  const [activeTab, setActiveTab] = useState<"general" | "advanced">("general");

  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // SSH Fields
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("root");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [hostKeyPolicy, setHostKeyPolicy] = useState<HostKeyPolicy>("accept_new");
  const [keepaliveSec, setKeepaliveSec] = useState<number>(30);
  const [jumpHostSessionId, setJumpHostSessionId] = useState<string>("");

  // SSH Key management
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [isKeyManagerModalOpen, setIsKeyManagerModalOpen] = useState(false);
  const [connectAfterSave, setConnectAfterSave] = useState(false);
  // 私钥口令（选中私钥后在其下方录入并加密保存）
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [keyPassphraseMsg, setKeyPassphraseMsg] = useState<string | null>(null);
  const [savingKeyPassphrase, setSavingKeyPassphrase] = useState(false);

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

  const handleSaveKeyPassphrase = async () => {
    const key = sshKeys.find((k) => k.id === selectedKeyId);
    if (!key) return;
    if (!keyPassphrase) {
      setKeyPassphraseMsg("请输入私钥口令 (Passphrase)");
      return;
    }
    setSavingKeyPassphrase(true);
    setKeyPassphraseMsg(null);
    try {
      const updated = await setSshKeyPassphrase(key.id, keyPassphrase);
      await loadKeys(updated.id);
      setKeyPassphrase("");
      setKeyPassphraseMsg("口令已加密保存，连接该服务器时会自动使用。");
    } catch (err: any) {
      setKeyPassphraseMsg(formatFriendlyError(err));
    } finally {
      setSavingKeyPassphrase(false);
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
          setUsername(editingSession.username || "root");
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
        let parsedName = initialValues?.name || "";
        let parsedHost = initialValues?.host || "";
        let parsedPort = initialValues?.port || 22;
        let parsedUser = initialValues?.username || "root";

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
      setVaultUnlockError(null);
      setShowPassword(false);
    }
  }, [editingSession, isOpen, initialValues]);

  if (!isOpen) return null;

  const isVaultLocked = vaultStatus && vaultStatus.state !== "unlocked";
  const isVaultUninitialized = vaultStatus?.state === "uninitialized";

  const handleInlineVaultUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
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
      setError(`保存会话失败: ${formatFriendlyError(err)}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 过滤可选跳板机会话（排除自身）
  const candidateJumpHosts = sessions.filter(
    (s) => s.protocol === "ssh" && (!editingSession || s.id !== editingSession.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-white p-6 shadow-2xl flex flex-col max-h-[92vh] text-slate-800 transition-all">
        {/* 顶部标题与协议切换 */}
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3.5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-apple-blue/10 text-apple-blue font-bold text-sm">
              {protocol === "ssh" ? "⚡" : "🔌"}
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900 tracking-tight">
                {editingSession ? "编辑会话配置" : "新建连接会话"}
              </h3>
              <p className="text-[11px] text-slate-500">
                {protocol === "ssh" ? "配置 SSH 远程服务器认证与网络链路" : "配置本地串口/RS232/USB 通信参数"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* 协议类型切换 (Apple Capsule Segment) */}
            <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200/80 text-xs">
              <button
                type="button"
                onClick={() => setProtocol("ssh")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  protocol === "ssh"
                    ? "bg-white text-apple-blue font-semibold shadow-apple-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                SSH 主机
              </button>
              <button
                type="button"
                onClick={() => setProtocol("serial")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  protocol === "serial"
                    ? "bg-white text-apple-blue font-semibold shadow-apple-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                串口 (Serial)
              </button>
            </div>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 p-1.5 rounded-full hover:bg-slate-100 transition"
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
          <div className="flex items-center space-x-1 border-b border-slate-100 mb-4 shrink-0 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("general")}
              className={`pb-2 px-3 border-b-2 font-medium transition ${
                activeTab === "general"
                  ? "border-apple-blue text-apple-blue font-bold"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              基础连接与凭据
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("advanced")}
              className={`pb-2 px-3 border-b-2 font-medium transition flex items-center gap-1.5 ${
                activeTab === "advanced"
                  ? "border-apple-blue text-apple-blue font-bold"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              <span>高级与跳板机</span>
              {jumpHostSessionId && (
                <span className="h-1.5 w-1.5 rounded-full bg-apple-orange" />
              )}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 flex-1 overflow-y-auto pr-1">
          {/* ================= SSH 基础连接与主要凭据 ================= */}
          {protocol === "ssh" && activeTab === "general" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    会话显示名称
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如：生产集群-节点01 (留空自动生成)"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    所属树状分组
                  </label>
                  <select
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs text-slate-900 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                  >
                    <option value="">📁 (根目录 / 无分组)</option>
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
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    主机地址 (IP / 域名) *
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100 或 ssh.example.com"
                    autoFocus
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    SSH 端口 *
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    min={1}
                    max={65535}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs text-slate-900 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  登录用户名 *
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="root"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-xs text-slate-900 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition font-mono"
                />
              </div>

              {/* 核心认证区 (平铺展示密码与公钥管理) */}
              <div className="pt-2 border-t border-slate-100">
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  认证方式与安全凭据
                </label>

                <div className="grid grid-cols-3 gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => setAuthMethod("password")}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${
                      authMethod === "password"
                        ? "bg-apple-blue/5 border-apple-blue text-apple-blue ring-1 ring-apple-blue/30 shadow-apple-sm"
                        : "bg-slate-50/60 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1.5 mb-0.5">
                      <span>🔑 密码认证</span>
                    </div>
                    <div className="text-[10px] text-slate-500">主保险库加密落盘</div>
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
                        ? "bg-apple-blue/5 border-apple-blue text-apple-blue ring-1 ring-apple-blue/30 shadow-apple-sm"
                        : "bg-slate-50/60 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1.5 mb-0.5">
                      <span>🛡️ SSH 密钥</span>
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {sshKeys.length > 0
                        ? `已选: ${sshKeys.find((k) => k.id === selectedKeyId)?.name || sshKeys[0].name}`
                        : "私钥认证"}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAuthMethod("keyboard_interactive")}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${
                      authMethod === "keyboard_interactive"
                        ? "bg-apple-blue/5 border-apple-blue text-apple-blue ring-1 ring-apple-blue/30 shadow-apple-sm"
                        : "bg-slate-50/60 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    <div className="font-bold flex items-center gap-1.5 mb-0.5">
                      <span>💬 交互式验证</span>
                    </div>
                    <div className="text-[10px] text-slate-500">MFA / 动态口令</div>
                  </button>
                </div>

                {/* 密码输入区 */}
                {authMethod === "password" && (
                  <div className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-3 space-y-2">
                    <label className="block text-xs font-medium text-slate-700">
                      连接密码 (留空则保持现有密码，或在终端连接时按需输入)
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••••••"
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-10 text-xs text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-700 text-xs p-0.5"
                        title={showPassword ? "隐藏密码" : "显示密码"}
                      >
                        {showPassword ? "🙈" : "👁️"}
                      </button>
                    </div>

                    {/* 保险库未解锁 / 未初始化提示卡片 */}
                    {isVaultLocked && password && (
                      <div className="mt-2 p-2.5 rounded-xl border border-amber-200 bg-amber-50 space-y-2 text-xs">
                        <div className="flex items-center gap-1.5 font-semibold text-amber-800">
                          <span>⚠️ 主保险库当前未解锁</span>
                        </div>
                        <p className="text-[11px] text-amber-700 leading-relaxed">
                          {isVaultUninitialized
                            ? "检测到主保险库尚未初始化。请输入主密码一键创建保险库，密码凭据将立即以 XChaCha20 密文安全加密保存："
                            : "需要解锁主保险库才能加密保存新密码凭据。请输入主密码即刻解锁："}
                        </p>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            value={vaultPassword}
                            onChange={(e) => setVaultPassword(e.target.value)}
                            placeholder="输入主保险库密码..."
                            className="flex-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus:border-amber-500"
                          />
                          <button
                            type="button"
                            onClick={handleInlineVaultUnlock}
                            disabled={unlockingVault || !vaultPassword}
                            className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-semibold text-xs hover:bg-amber-500 disabled:opacity-50 transition"
                          >
                            {unlockingVault ? "处理中..." : isVaultUninitialized ? "设置主密码并初始化" : "即刻解锁"}
                          </button>
                        </div>
                        {vaultUnlockError && (
                          <div className="text-[11px] text-red-600">{vaultUnlockError}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* 独立模态框选择与管理私钥区 */}
                {isPublicKeyAuth(authMethod) && (
                  <div className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <label className="block text-xs font-bold text-slate-800">
                          SSH 客户端私钥凭据
                        </label>
                        {sshKeys.length > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full bg-apple-blue/10 text-apple-blue font-semibold text-[11px]">
                            {sshKeys.length} 个可用密钥
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsKeyManagerModalOpen(true)}
                        className="text-xs text-apple-blue hover:text-apple-hoverBlue font-semibold flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-xl border border-slate-200 shadow-apple-sm transition hover:border-apple-blue/40"
                      >
                        <span>🔑 打开私钥管理器模态框</span>
                      </button>
                    </div>

                    {/* 当前选中的私钥展示卡片 */}
                    {(() => {
                      const currentKey = sshKeys.find((k) => k.id === selectedKeyId);
                      if (currentKey) {
                        return (
                          <div className="p-3.5 rounded-xl border border-apple-blue/40 bg-white shadow-apple-sm flex items-center justify-between">
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-10 h-10 rounded-xl bg-apple-blue/10 text-apple-blue flex items-center justify-center text-lg shrink-0 font-bold">
                                🔑
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-xs text-slate-900 truncate">
                                    {currentKey.name}
                                  </span>
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-600 shrink-0">
                                    {currentKey.algorithm.toUpperCase()}
                                  </span>
                                  {currentKey.has_passphrase ? (
                                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200 shrink-0">
                                      🔒 密码保护
                                    </span>
                                  ) : (
                                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 shrink-0">
                                      无口令
                                    </span>
                                  )}
                                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-200">
                                    ✓ 已绑定当前会话
                                  </span>
                                </div>
                                <div className="text-[11px] text-slate-400 font-mono truncate mt-0.5">
                                  指纹: {currentKey.fingerprint_sha256}
                                </div>
                              </div>
                            </div>

                            <button
                              type="button"
                              onClick={() => setIsKeyManagerModalOpen(true)}
                              className="px-3.5 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700 hover:bg-slate-100 hover:border-slate-300 transition shrink-0 ml-3 shadow-apple-sm"
                            >
                              更换 / 管理私钥 ↗
                            </button>
                          </div>
                        );
                      }

                      return (
                        <div className="p-5 rounded-xl border border-dashed border-slate-300 bg-white text-center space-y-2.5">
                          <div className="text-2xl">🔑</div>
                          <p className="text-xs font-semibold text-slate-700">尚未选择任何 SSH 私钥凭据</p>
                          <p className="text-[11px] text-slate-400 max-w-sm mx-auto">
                            点击下方按钮打开独立私钥管理器，可查看所有私钥列表、选取本地文件或粘贴导入新私钥，并一键完成绑定。
                          </p>
                          <button
                            type="button"
                            onClick={() => setIsKeyManagerModalOpen(true)}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-apple-blue text-white text-xs font-semibold hover:bg-apple-hoverBlue shadow-apple-md transition"
                          >
                            <span>🔑 打开私钥管理器选择私钥</span>
                          </button>
                        </div>
                      );
                    })()}

                    {/* 私钥口令：必须放在私钥选中后的下方 */}
                    {(() => {
                      const currentKey = sshKeys.find((k) => k.id === selectedKeyId);
                      if (!currentKey || !currentKey.has_passphrase) return null;
                      return (
                        <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2">
                          <label className="block text-[11px] font-semibold text-slate-700">
                            私钥口令 (Passphrase)
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              value={keyPassphrase}
                              onChange={(e) => setKeyPassphrase(e.target.value)}
                              placeholder="输入该私钥的口令"
                              className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 focus:border-apple-blue focus:bg-white focus:outline-none transition"
                            />
                            <button
                              type="button"
                              onClick={handleSaveKeyPassphrase}
                              disabled={savingKeyPassphrase}
                              className="px-3 py-1.5 rounded-lg bg-apple-blue text-white text-xs font-semibold hover:bg-apple-hoverBlue shadow-apple-sm transition disabled:opacity-50 shrink-0"
                            >
                              {savingKeyPassphrase ? "校验中..." : "保存口令"}
                            </button>
                          </div>
                          <p className="text-[10px] text-slate-400">
                            该私钥已加密。口令会保存到主保险库，连接时自动使用；口令不对将无法解密私钥。
                          </p>
                          {keyPassphraseMsg && (
                            <div
                              className={`text-[11px] ${
                                keyPassphraseMsg.includes("已加密保存")
                                  ? "text-emerald-600"
                                  : "text-red-600"
                              }`}
                            >
                              {keyPassphraseMsg}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ================= SSH 高级配置 & 跳板机 ================= */}
          {protocol === "ssh" && activeTab === "advanced" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  跳板机链路 (ProxyJump Bastion)
                </label>
                <select
                  value={jumpHostSessionId}
                  onChange={(e) => setJumpHostSessionId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                >
                  <option value="">(直连目标服务器，不走跳板机)</option>
                  {candidateJumpHosts.map((s) => (
                    <option key={s.id} value={s.id}>
                      🚀 经由 {s.name} ({s.username || "root"}@{s.host}:{s.port || 22})
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 mt-1">
                  流量将经由指定已保存会话的 Direct-TCPIP 通道安全穿透到内网。
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    主机密钥校验策略
                  </label>
                  <select
                    value={hostKeyPolicy}
                    onChange={(e) => setHostKeyPolicy(e.target.value as HostKeyPolicy)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                  >
                    <option value="accept_new">自动接受首次连接 (Accept New - 推荐)</option>
                    <option value="strict">严格校验 (Strict - 仅已知公钥)</option>
                    <option value="insecure">不校验主机密钥 (Insecure - 仅用于开发测试)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    心跳保活间隔 (KeepAlive 秒)
                  </label>
                  <input
                    type="number"
                    value={keepaliveSec}
                    onChange={(e) => setKeepaliveSec(Number(e.target.value))}
                    min={5}
                    max={600}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  备注说明 (Notes)
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="记录该主机的环境信息、用途或操作注意事项..."
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                />
              </div>
            </div>
          )}

          {/* ================= 串口配置区 (Serial) ================= */}
          {protocol === "serial" && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    串口设备 (Port) *
                  </label>
                  <button
                    type="button"
                    onClick={() => loadPorts()}
                    className="text-[11px] text-apple-blue hover:underline flex items-center gap-1"
                  >
                    <span className={loadingPorts ? "animate-spin" : ""}>🔄</span> 刷新设备列表
                  </button>
                </div>
                <div className="flex gap-2">
                  <select
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    className="flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 font-mono focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
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
                    className="w-32 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs font-mono text-slate-900 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    波特率 (Baud Rate) *
                  </label>
                  <button
                    type="button"
                    onClick={() => setCustomBaud(!customBaud)}
                    className="text-[11px] text-slate-500 hover:text-slate-800"
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
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-900 focus:border-apple-blue focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
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
                            ? "bg-apple-blue text-white border-apple-blue font-bold shadow-apple-sm"
                            : "bg-slate-50 text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-100"
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
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    数据位 (Data Bits)
                  </label>
                  <select
                    value={dataBits}
                    onChange={(e) => setDataBits(e.target.value as SerialDataBits)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900 font-mono focus:border-apple-blue focus:outline-none transition"
                  >
                    <option value="eight">8</option>
                    <option value="seven">7</option>
                    <option value="six">6</option>
                    <option value="five">5</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    停止位 (Stop Bits)
                  </label>
                  <select
                    value={stopBits}
                    onChange={(e) => setStopBits(e.target.value as SerialStopBits)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900 font-mono focus:border-apple-blue focus:outline-none transition"
                  >
                    <option value="one">1</option>
                    <option value="one_point_five">1.5</option>
                    <option value="two">2</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    校验位 (Parity)
                  </label>
                  <select
                    value={parity}
                    onChange={(e) => setParity(e.target.value as SerialParity)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900 font-mono focus:border-apple-blue focus:outline-none transition"
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
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    流控方式 (Flow Control)
                  </label>
                  <select
                    value={flowControl}
                    onChange={(e) => setFlowControl(e.target.value as SerialFlowControl)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-900 font-mono focus:border-apple-blue focus:outline-none transition"
                  >
                    <option value="none">None (无流控)</option>
                    <option value="hardware">RTS / CTS 硬件流控</option>
                    <option value="software">XON / XOFF 软件流控</option>
                  </select>
                </div>

                <div className="flex flex-col justify-end gap-1.5">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={dtrOnOpen}
                      onChange={(e) => setDtrOnOpen(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-apple-blue focus:ring-apple-blue"
                    />
                    <span>打开端口时拉高 DTR</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={rtsOnOpen}
                      onChange={(e) => setRtsOnOpen(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-slate-300 text-apple-blue focus:ring-apple-blue"
                    />
                    <span>打开端口时拉高 RTS</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-600 flex items-center gap-2">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end space-x-2.5 pt-3 border-t border-slate-100 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 transition"
            >
              取消
            </button>
            <button
              type="submit"
              onClick={() => setConnectAfterSave(false)}
              disabled={isSubmitting}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition disabled:opacity-50"
            >
              {isSubmitting && !connectAfterSave ? "保存中..." : "仅保存"}
            </button>
            {onConnectSession && (
              <button
                type="submit"
                onClick={() => setConnectAfterSave(true)}
                disabled={isSubmitting}
                className="rounded-xl bg-apple-blue px-5 py-2 text-xs font-semibold text-white shadow-apple-md hover:bg-apple-hoverBlue transition disabled:opacity-50 flex items-center gap-1.5"
              >
                <span>⚡</span>
                <span>{isSubmitting && connectAfterSave ? "保存并连接中..." : "保存并立即连接"}</span>
              </button>
            )}
          </div>
        </form>
      </div>

      <SshKeyManagerModal
        isOpen={isKeyManagerModalOpen}
        onClose={() => setIsKeyManagerModalOpen(false)}
        selectedKeyId={selectedKeyId}
        onSelectKey={(key) => {
          setSelectedKeyId(key.id);
          loadKeys(key.id);
        }}
      />
    </div>
  );
};
