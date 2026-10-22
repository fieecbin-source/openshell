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
import { createCredential, listSshKeys, importSshKey } from "../lib/ipc";

interface SessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingSession?: Session | null;
  initialValues?: Partial<SessionInput>;
}

const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const COLOR_OPTIONS = [
  { label: "默认灰", value: "" },
  { label: "翠绿 (生产)", value: "emerald" },
  { label: "天蓝 (测试)", value: "sky" },
  { label: "琥珀 (预发)", value: "amber" },
  { label: "赤红 (核心)", value: "rose" },
  { label: "紫罗兰", value: "purple" },
];

export const SessionModal: React.FC<SessionModalProps> = ({
  isOpen,
  onClose,
  editingSession,
  initialValues,
}) => {
  const { sessions, groups, createSession, updateSession } = useSessionStore();
  const { ports, loadPorts, loadingPorts } = useSerialStore();
  const { status: vaultStatus, unlock: unlockVault } = useVaultStore();

  const [activeTab, setActiveTab] = useState<"general" | "auth" | "advanced">("general");

  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState<string>("");
  const [colorTag, setColorTag] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // SSH Fields
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("root");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [hostKeyPolicy, setHostKeyPolicy] = useState<HostKeyPolicy>("accept_new");
  const [keepaliveSec, setKeepaliveSec] = useState<number>(30);
  const [jumpHostSessionId, setJumpHostSessionId] = useState<string>("");

  // SSH Key management
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [showKeyImport, setShowKeyImport] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPem, setNewKeyPem] = useState("");
  const [newKeyPassphrase, setNewKeyPassphrase] = useState("");
  const [keyImporting, setKeyImporting] = useState(false);
  const [keyImportError, setKeyImportError] = useState<string | null>(null);

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

  // Vault Unlock Inline State
  const [vaultPassword, setVaultPassword] = useState("");
  const [unlockingVault, setUnlockingVault] = useState(false);
  const [vaultUnlockError, setVaultUnlockError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = async () => {
    try {
      const keys = await listSshKeys();
      setSshKeys(keys);
      if (keys.length > 0 && !selectedKeyId) {
        setSelectedKeyId(keys[0].id);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadPorts();
      loadKeys();
    }
  }, [isOpen]);

  useEffect(() => {
    if (editingSession) {
      setName(editingSession.name);
      setGroupId(editingSession.group_id || "");
      setProtocol(editingSession.protocol || "ssh");
      setColorTag(editingSession.color || "");
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
        setSelectedKeyId(editingSession.ssh_key_id || "");
        setKeepaliveSec(editingSession.keepalive_sec || 30);
        setPassword("");

        if (editingSession.proxy_jump_json?.session_id) {
          setJumpHostSessionId(editingSession.proxy_jump_json.session_id);
        } else {
          setJumpHostSessionId("");
        }
      }
    } else {
      setName(initialValues?.name || "");
      setGroupId(initialValues?.group_id || "");
      setProtocol(initialValues?.protocol || "ssh");
      setColorTag(initialValues?.color || "");
      setNotes(initialValues?.notes || "");
      setHost(initialValues?.host || "");
      setPort(initialValues?.port || 22);
      setUsername(initialValues?.username || "root");
      setAuthMethod(initialValues?.auth_method || "password");
      setHostKeyPolicy(initialValues?.host_key_policy || "accept_new");
      setSelectedKeyId(initialValues?.ssh_key_id || "");
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
    setShowKeyImport(false);
  }, [editingSession, isOpen, initialValues]);

  if (!isOpen) return null;

  const isVaultLocked = vaultStatus && vaultStatus.state !== "unlocked";

  const handleInlineVaultUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vaultPassword) return;
    setUnlockingVault(true);
    setVaultUnlockError(null);
    try {
      await unlockVault(vaultPassword);
      setVaultPassword("");
    } catch (err: any) {
      setVaultUnlockError(err?.message || "解锁失败，密码错误");
    } finally {
      setUnlockingVault(false);
    }
  };

  const handleImportNewKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim() || !newKeyPem.trim()) {
      setKeyImportError("请填写密钥名称与 PEM 私钥内容");
      return;
    }
    setKeyImporting(true);
    setKeyImportError(null);
    try {
      const imported = await importSshKey(
        newKeyName.trim(),
        newKeyPem.trim(),
        newKeyPassphrase || undefined
      );
      await loadKeys();
      setSelectedKeyId(imported.id);
      setShowKeyImport(false);
      setNewKeyName("");
      setNewKeyPem("");
      setNewKeyPassphrase("");
    } catch (err: any) {
      setKeyImportError(err?.message || "导入私钥失败");
    } finally {
      setKeyImporting(false);
    }
  };

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
        setError("请输入主机地址");
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

    try {
      if (protocol === "ssh") {
        let credentialId = editingSession?.credential_id || null;

        // 如果设置了密码并且认证方式是密码
        if (password && authMethod === "password") {
          if (isVaultLocked) {
            setError("保险库尚未解锁，请先在下方输入主密码解锁后再保存密码凭据");
            setActiveTab("auth");
            setIsSubmitting(false);
            return;
          }
          const cred = await createCredential(
            `${sessionName} (${username || "root"})`,
            "password",
            password,
            username || "root"
          );
          credentialId = cred.id;
        }

        const effectivePort = port > 0 && port <= 65535 ? port : 22;
        const proxyJumpJson = jumpHostSessionId ? { session_id: jumpHostSessionId } : null;

        if (editingSession) {
          await updateSession(editingSession.id, {
            name: sessionName,
            group_id: groupId ? groupId : null,
            protocol: "ssh",
            host: host.trim(),
            port: effectivePort,
            username: username.trim() || "root",
            auth_method: authMethod,
            credential_id: credentialId,
            ssh_key_id: authMethod === "publickey" ? (selectedKeyId || null) : null,
            host_key_policy: hostKeyPolicy,
            proxy_jump_json: proxyJumpJson,
            color: colorTag || null,
            notes: notes || null,
            keepalive_sec: keepaliveSec,
          });
        } else {
          const input: SessionInput = {
            name: sessionName,
            group_id: groupId ? groupId : null,
            protocol: "ssh",
            host: host.trim(),
            port: effectivePort,
            username: username.trim() || "root",
            auth_method: authMethod,
            credential_id: credentialId,
            ssh_key_id: authMethod === "publickey" ? (selectedKeyId || null) : null,
            host_key_policy: hostKeyPolicy,
            proxy_jump_json: proxyJumpJson,
            color: colorTag || null,
            notes: notes || null,
            keepalive_sec: keepaliveSec,
          };
          await createSession(input);
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
          await updateSession(editingSession.id, {
            name: sessionName,
            group_id: groupId ? groupId : null,
            protocol: "serial",
            color: colorTag || null,
            notes: notes || null,
            protocol_options_json: serialOptions,
          });
        } else {
          const input: SessionInput = {
            name: sessionName,
            group_id: groupId ? groupId : null,
            protocol: "serial",
            color: colorTag || null,
            notes: notes || null,
            protocol_options_json: serialOptions,
          };
          await createSession(input);
        }
      }

      onClose();
    } catch (err: any) {
      setError(err?.message || "保存会话失败，请核对输入参数");
    } finally {
      setIsSubmitting(false);
    }
  };

  // 过滤可选跳板机会话（排除自身）
  const candidateJumpHosts = sessions.filter(
    (s) => s.protocol === "ssh" && (!editingSession || s.id !== editingSession.id)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl rounded-2xl border border-surface-700 bg-surface-900 p-6 shadow-2xl flex flex-col max-h-[90vh]">
        {/* 顶部标题与协议切换 */}
        <div className="mb-4 flex items-center justify-between border-b border-surface-800 pb-3 shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400 font-bold text-xs">
                {protocol === "ssh" ? "⚡" : "🔌"}
              </span>
              <span>{editingSession ? "编辑会话属性" : "新建连接会话"}</span>
            </h3>

            {/* 协议类型切换 */}
            <div className="flex bg-surface-950 p-0.5 rounded-lg border border-surface-800 text-xs">
              <button
                type="button"
                onClick={() => setProtocol("ssh")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  protocol === "ssh"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                SSH 连接
              </button>
              <button
                type="button"
                onClick={() => setProtocol("serial")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  protocol === "serial"
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                串口 (Serial)
              </button>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-surface-800 transition"
          >
            ✕
          </button>
        </div>

        {/* SSH 模式下的多标签页导航 */}
        {protocol === "ssh" && (
          <div className="flex items-center space-x-2 border-b border-surface-800 mb-4 shrink-0 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab("general")}
              className={`pb-2 px-3 border-b-2 font-medium transition ${
                activeTab === "general"
                  ? "border-emerald-500 text-emerald-400 font-bold"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              基础连接
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("auth")}
              className={`pb-2 px-3 border-b-2 font-medium transition flex items-center gap-1.5 ${
                activeTab === "auth"
                  ? "border-emerald-500 text-emerald-400 font-bold"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>身份凭据</span>
              {authMethod === "publickey" && selectedKeyId && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("advanced")}
              className={`pb-2 px-3 border-b-2 font-medium transition flex items-center gap-1.5 ${
                activeTab === "advanced"
                  ? "border-emerald-500 text-emerald-400 font-bold"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <span>高级与跳板机</span>
              {jumpHostSessionId && (
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              )}
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 flex-1 overflow-y-auto pr-1">
          {/* ================= SSH 基础连接 ================= */}
          {protocol === "ssh" && activeTab === "general" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    会话显示名称
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="如：Web-Prod-01 (留空自动生成)"
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    所属树状分组
                  </label>
                  <select
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="">(根目录 / 无分组)</option>
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
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    主机地址 (IP / 域名) *
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="192.168.1.100 或 server.example.com"
                    autoFocus
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    SSH 端口 *
                  </label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    min={1}
                    max={65535}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    登录用户名
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="root"
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    色彩标记 (Tag)
                  </label>
                  <select
                    value={colorTag}
                    onChange={(e) => setColorTag(e.target.value)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                  >
                    {COLOR_OPTIONS.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}

          {/* ================= SSH 身份凭据 ================= */}
          {protocol === "ssh" && activeTab === "auth" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  身份验证方式
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setAuthMethod("password")}
                    className={`p-2.5 rounded-lg border text-xs font-medium text-left transition ${
                      authMethod === "password"
                        ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-300"
                        : "bg-surface-950 border-surface-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <div className="font-bold mb-0.5">🔑 密码认证</div>
                    <div className="text-[10px] text-slate-500">主保险库加密存储</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAuthMethod("publickey")}
                    className={`p-2.5 rounded-lg border text-xs font-medium text-left transition ${
                      authMethod === "publickey"
                        ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-300"
                        : "bg-surface-950 border-surface-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <div className="font-bold mb-0.5">🛡️ SSH 私钥</div>
                    <div className="text-[10px] text-slate-500">Ed25519 / RSA</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAuthMethod("keyboard_interactive")}
                    className={`p-2.5 rounded-lg border text-xs font-medium text-left transition ${
                      authMethod === "keyboard_interactive"
                        ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-300"
                        : "bg-surface-950 border-surface-800 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <div className="font-bold mb-0.5">💬 交互式问答</div>
                    <div className="text-[10px] text-slate-500">MFA / 动态口令</div>
                  </button>
                </div>
              </div>

              {/* 密码输入与保险库状态 */}
              {authMethod === "password" && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    密码 (留空则保持现有密码，或在连接时提示输入)
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />

                  {/* 保险库锁定报警与即时解锁卡片 */}
                  {isVaultLocked && password && (
                    <div className="mt-3 p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-2">
                      <div className="flex items-center gap-2 text-xs text-amber-300 font-semibold">
                        <span>⚠️ 主保险库当前已锁定</span>
                      </div>
                      <p className="text-[11px] text-amber-200/80">
                        需要解锁主保险库才能加密保存新密码。请输入主密码解锁：
                      </p>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          value={vaultPassword}
                          onChange={(e) => setVaultPassword(e.target.value)}
                          placeholder="主密码..."
                          className="flex-1 rounded border border-amber-500/40 bg-surface-950 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
                        />
                        <button
                          type="button"
                          onClick={handleInlineVaultUnlock}
                          disabled={unlockingVault || !vaultPassword}
                          className="px-3 py-1.5 rounded bg-amber-500 text-black font-bold text-xs hover:bg-amber-400 disabled:opacity-50"
                        >
                          {unlockingVault ? "解锁中..." : "即刻解锁"}
                        </button>
                      </div>
                      {vaultUnlockError && (
                        <div className="text-[11px] text-red-400">{vaultUnlockError}</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 私钥选择与导入 */}
              {authMethod === "publickey" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-semibold text-slate-300">
                      选择已绑定的 SSH 密钥
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowKeyImport(!showKeyImport)}
                      className="text-xs text-emerald-400 hover:text-emerald-300 font-medium"
                    >
                      {showKeyImport ? "返回密钥列表" : "+ 导入新私钥"}
                    </button>
                  </div>

                  {!showKeyImport ? (
                    <div>
                      {sshKeys.length === 0 ? (
                        <div className="p-4 rounded-xl border border-surface-800 bg-surface-950 text-center text-xs text-slate-400">
                          <p>暂无已存储的私钥，请点击上方“+ 导入新私钥”录入。</p>
                        </div>
                      ) : (
                        <select
                          value={selectedKeyId}
                          onChange={(e) => setSelectedKeyId(e.target.value)}
                          className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 font-mono focus:border-emerald-500 focus:outline-none"
                        >
                          {sshKeys.map((k) => (
                            <option key={k.id} value={k.id}>
                              {k.name} ({k.algorithm} · {k.fingerprint_sha256?.substring(0, 16)}...)
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl border border-surface-700 bg-surface-950 space-y-3">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-300 mb-1">
                          密钥别名 *
                        </label>
                        <input
                          type="text"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          placeholder="如 id_ed25519_prod"
                          className="w-full rounded border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-slate-300 mb-1">
                          PEM 格式私钥内容 *
                        </label>
                        <textarea
                          rows={4}
                          value={newKeyPem}
                          onChange={(e) => setNewKeyPem(e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                          className="w-full rounded border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] font-medium text-slate-300 mb-1">
                          私钥口令 Passphrase (若有)
                        </label>
                        <input
                          type="password"
                          value={newKeyPassphrase}
                          onChange={(e) => setNewKeyPassphrase(e.target.value)}
                          placeholder="可选口令..."
                          className="w-full rounded border border-surface-700 bg-surface-900 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-500"
                        />
                      </div>

                      {keyImportError && (
                        <div className="text-[11px] text-red-400">{keyImportError}</div>
                      )}

                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShowKeyImport(false)}
                          className="px-3 py-1 text-xs text-slate-400 hover:text-white"
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          onClick={handleImportNewKey}
                          disabled={keyImporting}
                          className="px-3 py-1 rounded bg-emerald-600 text-white font-medium text-xs hover:bg-emerald-500 disabled:opacity-50"
                        >
                          {keyImporting ? "导入中..." : "保存私钥"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ================= SSH 高级配置 & 跳板机 ================= */}
          {protocol === "ssh" && activeTab === "advanced" && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  跳板机链路 (ProxyJump Bastion)
                </label>
                <select
                  value={jumpHostSessionId}
                  onChange={(e) => setJumpHostSessionId(e.target.value)}
                  className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
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
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    主机密钥校验策略
                  </label>
                  <select
                    value={hostKeyPolicy}
                    onChange={(e) => setHostKeyPolicy(e.target.value as HostKeyPolicy)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="accept_new">自动接受首次连接 (Accept New - 推荐)</option>
                    <option value="strict">严格校验 (Strict - 仅已知公钥)</option>
                    <option value="insecure">不校验主机密钥 (Insecure - 仅测试)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    心跳保活间隔 (KeepAlive 秒)
                  </label>
                  <input
                    type="number"
                    value={keepaliveSec}
                    onChange={(e) => setKeepaliveSec(Number(e.target.value))}
                    min={5}
                    max={600}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  备注说明 (Notes)
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="记录该主机的环境信息、用途或操作注意事项..."
                  className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* ================= 串口配置区 (Serial) ================= */}
          {protocol === "serial" && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-300">
                    串口设备 (Port) *
                  </label>
                  <button
                    type="button"
                    onClick={() => loadPorts()}
                    className="text-[11px] text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                  >
                    <span className={loadingPorts ? "animate-spin" : ""}>🔄</span> 刷新设备
                  </button>
                </div>
                <div className="flex gap-2">
                  <select
                    value={serialPort}
                    onChange={(e) => setSerialPort(e.target.value)}
                    className="flex-1 rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs text-slate-100 font-mono focus:border-emerald-500 focus:outline-none"
                  >
                    {ports.length === 0 ? (
                      <option value="COM1">COM1 (模拟硬件回环模式)</option>
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
                    className="w-32 rounded-lg border border-surface-700 bg-surface-950 px-2 py-2 text-xs font-mono text-slate-200 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-300">
                    波特率 (Baud Rate) *
                  </label>
                  <button
                    type="button"
                    onClick={() => setCustomBaud(!customBaud)}
                    className="text-[11px] text-slate-400 hover:text-slate-200"
                  >
                    {customBaud ? "常用列表" : "自定义波特率"}
                  </button>
                </div>
                {customBaud ? (
                  <input
                    type="number"
                    value={baudRate}
                    onChange={(e) => setBaudRate(Number(e.target.value))}
                    placeholder="如 1500000"
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-3 py-2 text-xs font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {COMMON_BAUD_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => setBaudRate(rate)}
                        className={`px-2.5 py-1 rounded text-xs font-mono border transition ${
                          baudRate === rate
                            ? "bg-emerald-600 text-white border-emerald-500 font-bold shadow-sm"
                            : "bg-surface-950 text-slate-400 border-surface-800 hover:border-surface-700 hover:text-slate-200"
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
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    数据位 (Data Bits)
                  </label>
                  <select
                    value={dataBits}
                    onChange={(e) => setDataBits(e.target.value as SerialDataBits)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-slate-100 font-mono focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="eight">8</option>
                    <option value="seven">7</option>
                    <option value="six">6</option>
                    <option value="five">5</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    停止位 (Stop Bits)
                  </label>
                  <select
                    value={stopBits}
                    onChange={(e) => setStopBits(e.target.value as SerialStopBits)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-slate-100 font-mono focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="one">1</option>
                    <option value="one_point_five">1.5</option>
                    <option value="two">2</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    校验位 (Parity)
                  </label>
                  <select
                    value={parity}
                    onChange={(e) => setParity(e.target.value as SerialParity)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-slate-100 font-mono focus:border-emerald-500 focus:outline-none"
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
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    流控方式 (Flow Control)
                  </label>
                  <select
                    value={flowControl}
                    onChange={(e) => setFlowControl(e.target.value as SerialFlowControl)}
                    className="w-full rounded-lg border border-surface-700 bg-surface-950 px-2 py-1.5 text-xs text-slate-100 font-mono focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="none">None (无流控)</option>
                    <option value="hardware">RTS / CTS 硬件流控</option>
                    <option value="software">XON / XOFF 软件流控</option>
                  </select>
                </div>

                <div className="flex flex-col justify-end gap-1.5">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={dtrOnOpen}
                      onChange={(e) => setDtrOnOpen(e.target.checked)}
                      className="w-3.5 h-3.5 rounded bg-surface-950 border-surface-700 text-emerald-600 focus:ring-0"
                    />
                    <span>默认拉高 DTR</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                    <input
                      type="checkbox"
                      checked={rtsOnOpen}
                      onChange={(e) => setRtsOnOpen(e.target.checked)}
                      className="w-3.5 h-3.5 rounded bg-surface-950 border-surface-700 text-emerald-600 focus:ring-0"
                    />
                    <span>默认拉高 RTS</span>
                  </label>
                </div>
              </div>
            </>
          )}

          {error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-2.5 text-xs text-red-400">
              {error}
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-3 border-t border-surface-800 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-surface-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-surface-800 transition"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-emerald-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-emerald-950 hover:bg-emerald-500 transition disabled:opacity-50"
            >
              {isSubmitting ? "保存中..." : "保存会话"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
