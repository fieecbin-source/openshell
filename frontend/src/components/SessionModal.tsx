import React, { useState, useEffect } from "react";
import type {
  AuthMethod,
  HostKeyPolicy,
  LocalShellKind,
  LocalShellProtocolOptions,
  PortForwardRule,
  PortForwardRuleInput,
  PortForwardType,
  Protocol,
  ProxyServerConfig,
  RdpProtocolOptions,
  SerialDataBits,
  SerialFlowControl,
  SerialParity,
  SerialStopBits,
  Session,
  SessionInput,
  SocksAuth,
  SshKey,
  SshProtocolOptions,
  TelnetProtocolOptions,
} from "../types/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useSerialStore } from "../stores/serialStore";
import { useVaultStore } from "../stores/vaultStore";
import {
  createCredential,
  deleteSshKey,
  listSshKeys,
} from "../lib/ipc";
import * as ipcModule from "../lib/ipc";
import { formatFriendlyError, parseIpcError } from "../lib/errors";
import { SshKeyImportModal } from "./SshKeyImportModal";
import { ProxyManagerModal } from "./ProxyManagerModal";
import { Button, IconButton } from "./ui/Button";
import { RequiredMark, Select } from "./ui/Field";
import { KeyRound, Trash2 } from "lucide-react";
import { HostIcon } from "./ui/HostIcon";
import { HostIconPicker } from "./ui/HostIconPicker";
import {
  DEFAULT_HOST_ICON_KEY,
  normalizeHostIconKey,
  detectHostIcon,
} from "../lib/hostIcons";
import {
  XIcon,
  KeyIcon,
  PlugIcon,
  PlayIcon,
  TriangleAlertIcon,
  MonitorIcon,
  TerminalIcon,
  GlobeIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
} from "./ui/icons";

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

interface SessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingSession?: Session | null;
  initialValues?: Partial<SessionInput>;
  onConnectSession?: (session: Session) => void;
}

const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const PROTOCOL_TITLES: Record<Protocol, { name: string; create: string; edit: string }> = {
  ssh: {
    name: "SSH",
    create: "新建 SSH 连接",
    edit: "编辑 SSH 连接",
  },
  rdp: {
    name: "Windows 远程桌面 (RDP)",
    create: "新建 Windows 远程桌面 (RDP)",
    edit: "编辑 Windows 远程桌面 (RDP)",
  },
  serial: {
    name: "串口连接 (Serial)",
    create: "新建串口连接 (Serial)",
    edit: "编辑串口连接 (Serial)",
  },
  telnet: {
    name: "Telnet",
    create: "新建 Telnet 连接",
    edit: "编辑 Telnet 连接",
  },
  local_shell: {
    name: "本地终端",
    create: "新建本地终端",
    edit: "编辑本地终端",
  },
  sftp: {
    name: "SFTP",
    create: "新建 SFTP 连接",
    edit: "编辑 SFTP 连接",
  },
};

const RDP_RESOLUTION_PRESETS: Array<{ label: string; width: number; height: number }> = [
  { label: "1920 × 1080 (FHD)", width: 1920, height: 1080 },
  { label: "1600 × 900 (HD+)", width: 1600, height: 900 },
  { label: "1440 × 900", width: 1440, height: 900 },
  { label: "1366 × 768", width: 1366, height: 768 },
  { label: "1280 × 720 (HD)", width: 1280, height: 720 },
];

const ENCODING_OPTIONS = [
  { value: "utf-8", label: "UTF-8 (默认推荐)" },
  { value: "gbk", label: "GBK (简体中文 Windows)" },
  { value: "gb18030", label: "GB18030" },
  { value: "big5", label: "Big5 (繁体中文)" },
  { value: "shift_jis", label: "Shift_JIS (日文)" },
  { value: "iso-8859-1", label: "ISO-8859-1 (Latin-1)" },
];

const SHELL_KIND_OPTIONS: Array<{ value: LocalShellKind; label: string }> = [
  { value: "powershell", label: "Windows PowerShell (powershell.exe)" },
  { value: "pwsh", label: "PowerShell 7+ (pwsh)" },
  { value: "cmd", label: "命令提示符 (cmd.exe)" },
  { value: "wsl", label: "WSL Linux 子系统 (wsl.exe)" },
  { value: "bash", label: "Bash (/bin/bash)" },
  { value: "zsh", label: "Zsh (/bin/zsh)" },
  { value: "custom", label: "自定义可执行程序 (Custom)" },
];

interface PendingTunnelRule extends PortForwardRuleInput {
  tempId: string;
}

interface VaultInlineUnlockProps {
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
  uninitialized,
  password,
  onPasswordChange,
  busy,
  error,
  onSubmit,
}) => (
  <div className="mt-2 p-2.5 rounded-xl border border-state-warning/30 bg-state-warning/10 space-y-2 text-xs">
    <div className="flex items-center gap-1.5 font-semibold text-state-warning">
      <span>{uninitialized ? "设置保险库主密码" : "保险库已锁定"}</span>
    </div>
    <div className="flex gap-2">
      <input
        type="password"
        aria-label="保险库主密码"
        aria-required="true"
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
        {busy ? "处理中..." : uninitialized ? "创建保险库" : "解锁"}
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

  const [activeTab, setActiveTab] = useState<"general" | "advanced" | "tunnel" | "icon">("general");

  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [name, setName] = useState("");
  const [iconKey, setIconKey] = useState(DEFAULT_HOST_ICON_KEY);
  const [groupId, setGroupId] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // 通用网络与代理字段
  const [host, setHost] = useState("");
  const [port, setPort] = useState(0);
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [proxyId, setProxyId] = useState<string>("");
  const [proxies, setProxies] = useState<ProxyServerConfig[]>([]);
  const [proxyManagerOpen, setProxyManagerOpen] = useState(false);

  // SSH 高级与终端字段
  const [hostKeyPolicy, setHostKeyPolicy] = useState<HostKeyPolicy>("strict");
  const [keepaliveSec, setKeepaliveSec] = useState<number>(30);
  const [jumpHostSessionId, setJumpHostSessionId] = useState<string>("");
  const [encoding, setEncoding] = useState<string>("utf-8");
  const [startupCommand, setStartupCommand] = useState<string>("");
  const [workingDir, setWorkingDir] = useState<string>("");
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectMax, setReconnectMax] = useState<number>(5);
  const [compression, setCompression] = useState(false);
  const [agentForwarding, setAgentForwarding] = useState(false);
  const [x11Forwarding, setX11Forwarding] = useState(false);
  const [execChannelEnable, setExecChannelEnable] = useState(true);
  const [sshAccelerate, setSshAccelerate] = useState(false);
  const [backspaceSeq, setBackspaceSeq] = useState<"ascii_del" | "ctrl_h" | "auto">("auto");
  const [deleteSeq, setDeleteSeq] = useState<"vt220" | "ascii_del" | "auto">("auto");

  // 已保存的私钥仅按名称选择；导入在独立弹窗中完成。
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string>("");
  const [connectAfterSave, setConnectAfterSave] = useState(false);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [keyImportOpen, setKeyImportOpen] = useState(false);

  // RDP 字段
  const [rdpDomain, setRdpDomain] = useState("");
  const [rdpFullscreen, setRdpFullscreen] = useState(true);
  const [rdpWidth, setRdpWidth] = useState(1920);
  const [rdpHeight, setRdpHeight] = useState(1080);
  const [rdpDrivesRedirect, setRdpDrivesRedirect] = useState(true);
  const [rdpClipboard, setRdpClipboard] = useState(true);
  const [rdpPrinters, setRdpPrinters] = useState(false);
  const [rdpAudio, setRdpAudio] = useState<"local" | "remote" | "none">("local");
  const [rdpAdminSession, setRdpAdminSession] = useState(false);

  // LocalShell 字段
  const [shellKind, setShellKind] = useState<LocalShellKind>("powershell");
  const [shellPath, setShellPath] = useState("");

  // Telnet 字段
  const [telnetAutoLogin, setTelnetAutoLogin] = useState(false);
  const [telnetLoginPrompt, setTelnetLoginPrompt] = useState("login:");
  const [telnetPasswordPrompt, setTelnetPasswordPrompt] = useState("Password:");
  const [telnetNewlineMode, setTelnetNewlineMode] = useState<"crlf" | "lf" | "cr">("crlf");
  const [telnetLocalEcho, setTelnetLocalEcho] = useState(false);

  // Serial 字段
  const [serialPort, setSerialPort] = useState("COM1");
  const [baudRate, setBaudRate] = useState(115200);
  const [customBaud, setCustomBaud] = useState(false);
  const [dataBits, setDataBits] = useState<SerialDataBits>("eight");
  const [stopBits, setStopBits] = useState<SerialStopBits>("one");
  const [parity, setParity] = useState<SerialParity>("none");
  const [flowControl, setFlowControl] = useState<SerialFlowControl>("none");
  const [dtrOnOpen, setDtrOnOpen] = useState(true);
  const [rtsOnOpen, setRtsOnOpen] = useState(true);

  // SSH 内嵌隧道 / 端口转发状态
  const [existingTunnels, setExistingTunnels] = useState<PortForwardRule[]>([]);
  const [pendingTunnels, setPendingTunnels] = useState<PendingTunnelRule[]>([]);
  const [editingTunnelId, setEditingTunnelId] = useState<string | null>(null);
  const [tunnelName, setTunnelName] = useState("");
  const [tunnelType, setTunnelType] = useState<PortForwardType>("local");
  const [tunnelBindHost, setTunnelBindHost] = useState("127.0.0.1");
  const [tunnelBindPort, setTunnelBindPort] = useState<number>(8080);
  const [tunnelDestHost, setTunnelDestHost] = useState("127.0.0.1");
  const [tunnelDestPort, setTunnelDestPort] = useState<number>(80);
  const [tunnelAutoStart, setTunnelAutoStart] = useState(true);
  const [tunnelSocksAuth, setTunnelSocksAuth] = useState<SocksAuth>("none");
  const [tunnelSocksUsername, setTunnelSocksUsername] = useState("");
  // 仅作为本次表单的临时输入，不写入 localStorage / password_ref
  const [tunnelSocksPassword, setTunnelSocksPassword] = useState("");
  const [tunnelMsg, setTunnelMsg] = useState<string | null>(null);

  // Vault Inline State
  const [vaultPassword, setVaultPassword] = useState("");
  const [unlockingVault, setUnlockingVault] = useState(false);
  const [vaultUnlockError, setVaultUnlockError] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyAutoIcon = () => {
    setIconKey(detectHostIcon({ name, host, username, protocol }));
  };

  const selectIcon = (key: string) => {
    setIconKey(key);
  };

  const loadProxiesList = async () => {
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
      // fallback to localStorage if available
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

  const loadSessionTunnels = async (sid: string) => {
    try {
      const fn = getIpcFn("forwardList");
      if (!fn) return;
      const list = await fn(sid);
      if (Array.isArray(list)) {
        setExistingTunnels(list);
      }
    } catch {
      // ignore
    }
  };

  const resetTunnelForm = () => {
    setEditingTunnelId(null);
    setTunnelName("");
    setTunnelType("local");
    setTunnelBindHost("127.0.0.1");
    setTunnelBindPort(8080);
    setTunnelDestHost("127.0.0.1");
    setTunnelDestPort(80);
    setTunnelAutoStart(true);
    setTunnelSocksAuth("none");
    setTunnelSocksUsername("");
    setTunnelSocksPassword("");
    setTunnelMsg(null);
  };

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
      void loadProxiesList();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setActiveTab("general");
      resetTunnelForm();
      setPendingTunnels([]);
      setExistingTunnels([]);

      if (editingSession) {
        const proto = editingSession.protocol || "ssh";
        setName(editingSession.name);
        setIconKey(normalizeHostIconKey(editingSession.icon_key));
        setGroupId(editingSession.group_id || "");
        setProtocol(proto);
        setNotes(editingSession.notes || "");
        setProxyId(editingSession.proxy_id || "");
        setEncoding(editingSession.encoding || "utf-8");
        setStartupCommand(editingSession.startup_command || "");
        setWorkingDir(editingSession.working_dir || "");
        setAutoReconnect(editingSession.auto_reconnect ?? false);
        setReconnectMax(editingSession.reconnect_max ?? 5);
        setCompression(editingSession.compression ?? false);
        setAgentForwarding(editingSession.agent_forwarding ?? false);
        setX11Forwarding(editingSession.x11_forwarding ?? false);
        setPassword("");

        const opts = editingSession.protocol_options_json || {};

        if (proto === "serial") {
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
        } else if (proto === "rdp") {
          const rdpOpts = opts as RdpProtocolOptions;
          setHost(editingSession.host || "");
          setPort(editingSession.port || 3389);
          setUsername(editingSession.username || "Administrator");
          setRdpDomain(rdpOpts.domain || "");
          setRdpFullscreen(rdpOpts.fullscreen !== false && !rdpOpts.custom_size);
          setRdpWidth(rdpOpts.width || 1920);
          setRdpHeight(rdpOpts.height || 1080);
          setRdpDrivesRedirect(rdpOpts.drivestoredirect !== false);
          setRdpClipboard(rdpOpts.redirect_clipboard !== false);
          setRdpPrinters(rdpOpts.redirect_printers ?? false);
          setRdpAudio(rdpOpts.redirect_audio || "local");
          setRdpAdminSession(rdpOpts.admin_session ?? false);
        } else if (proto === "local_shell") {
          const localOpts = opts as LocalShellProtocolOptions;
          setShellKind(localOpts.shell_kind || "powershell");
          setShellPath(localOpts.shell_path || "");
        } else if (proto === "telnet") {
          const telnetOpts = opts as TelnetProtocolOptions;
          setHost(editingSession.host || "");
          setPort(editingSession.port || 23);
          setUsername(editingSession.username || "");
          setTelnetAutoLogin(telnetOpts.auto_login ?? false);
          setTelnetLoginPrompt(telnetOpts.login_prompt || "login:");
          setTelnetPasswordPrompt(telnetOpts.password_prompt || "Password:");
          setTelnetNewlineMode(telnetOpts.newline_mode || "crlf");
          setTelnetLocalEcho(telnetOpts.local_echo ?? false);
        } else {
          const sshOpts = opts as SshProtocolOptions;
          setHost(editingSession.host || "");
          setPort(editingSession.port || 22);
          setUsername(editingSession.username || "");
          setAuthMethod(editingSession.auth_method || "password");
          setHostKeyPolicy(editingSession.host_key_policy || "strict");
          const keyId = editingSession.ssh_key_id || "";
          setSelectedKeyId(keyId);
          void loadKeys(keyId);
          setKeepaliveSec(editingSession.keepalive_sec || 30);
          setJumpHostSessionId(editingSession.proxy_jump_json?.session_id || "");
          setExecChannelEnable(sshOpts.exec_channel_enable !== false);
          setSshAccelerate(sshOpts.accelerate ?? false);
          setBackspaceSeq(sshOpts.backspace_key_sequence || "auto");
          setDeleteSeq(sshOpts.delete_key_sequence || "auto");
          void loadSessionTunnels(editingSession.id);
        }
      } else {
        // 智能解析从快速连接传入的 initialValues
        const initProto: Protocol = initialValues?.protocol || "ssh";
        const parsedName = initialValues?.name || "";
        let parsedHost = initialValues?.host || "";
        let parsedPort =
          initialValues?.port ??
          (initProto === "rdp" ? 3389 : initProto === "telnet" ? 23 : 0);
        let parsedUser =
          initialValues?.username ?? (initProto === "rdp" ? "Administrator" : "");

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
        setIconKey(normalizeHostIconKey(initialValues?.icon_key));
        setGroupId(initialValues?.group_id || "");
        setProtocol(initProto);
        setNotes(initialValues?.notes || "");
        setHost(parsedHost);
        setPort(parsedPort);
        setUsername(parsedUser);
        setAuthMethod(initialValues?.auth_method || "password");
        setHostKeyPolicy(initialValues?.host_key_policy || "strict");
        const keyId = initialValues?.ssh_key_id || "";
        setSelectedKeyId(keyId);
        void loadKeys(keyId);
        setPassword("");
        setProxyId(initialValues?.proxy_id || "");
        setJumpHostSessionId(initialValues?.proxy_jump_json?.session_id || "");
        setKeepaliveSec(initialValues?.keepalive_sec || 30);
        setEncoding(initialValues?.encoding || "utf-8");
        setStartupCommand(initialValues?.startup_command || "");
        setWorkingDir(initialValues?.working_dir || "");
        setAutoReconnect(initialValues?.auto_reconnect ?? true);
        setReconnectMax(initialValues?.reconnect_max ?? 5);
        setCompression(initialValues?.compression ?? false);
        setAgentForwarding(initialValues?.agent_forwarding ?? false);
        setX11Forwarding(initialValues?.x11_forwarding ?? false);
        setExecChannelEnable(true);
        setSshAccelerate(false);
        setBackspaceSeq("auto");
        setDeleteSeq("auto");

        // RDP 默认值
        setRdpDomain("");
        setRdpFullscreen(true);
        setRdpWidth(1920);
        setRdpHeight(1080);
        setRdpDrivesRedirect(true);
        setRdpClipboard(true);
        setRdpPrinters(false);
        setRdpAudio("local");
        setRdpAdminSession(false);

        // LocalShell 默认值
        setShellKind("powershell");
        setShellPath("");

        // Telnet 默认值
        setTelnetAutoLogin(false);
        setTelnetLoginPrompt("login:");
        setTelnetPasswordPrompt("Password:");
        setTelnetNewlineMode("crlf");
        setTelnetLocalEcho(false);

        // Serial 默认值
        setSerialPort(ports[0]?.name || "COM1");
        setBaudRate(115200);
        setDataBits("eight");
        setStopBits("one");
        setParity("none");
        setFlowControl("none");
        setDtrOnOpen(true);
        setRtsOnOpen(true);
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

  const handleProtocolSwitch = (nextProto: Protocol) => {
    setProtocol(nextProto);
    setError(null);
    if (nextProto === "rdp") {
      if (port === 0 || port === 22 || port === 23) setPort(3389);
      if (!username) setUsername("Administrator");
    } else if (nextProto === "telnet") {
      if (port === 0 || port === 22 || port === 3389) setPort(23);
    } else if (nextProto === "ssh") {
      if (port === 3389 || port === 23) setPort(0);
    }
  };

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

  // 处理内嵌隧道新增/更新
  const handleSaveEmbeddedTunnel = async () => {
    const trimmedName =
      tunnelName.trim() ||
      `${tunnelType.toUpperCase()}-${tunnelBindPort}${tunnelType !== "dynamic" ? `->${tunnelDestPort}` : ""
      }`;
    const input: PortForwardRuleInput = {
      session_id: editingSession?.id || null,
      name: trimmedName,
      rule_type: tunnelType,
      bind_host: tunnelBindHost.trim() || "127.0.0.1",
      bind_port: Number(tunnelBindPort) || 8080,
      dest_host: tunnelType === "dynamic" ? null : tunnelDestHost.trim() || "127.0.0.1",
      dest_port: tunnelType === "dynamic" ? null : Number(tunnelDestPort) || 80,
      auto_start: tunnelAutoStart,
      auto_reconnect: true,
      socks_auth: tunnelType === "dynamic" ? tunnelSocksAuth : "none",
      socks_username:
        tunnelType === "dynamic" && tunnelSocksAuth === "userpass"
          ? tunnelSocksUsername.trim() || null
          : null,
      expose_warning_ack: true,
    };
    // 密码只随本次表单提交，不做本地持久化；留空表示沿用已有凭据
    if (tunnelType === "dynamic" && tunnelSocksAuth === "userpass" && tunnelSocksPassword) {
      input.socks_password = tunnelSocksPassword;
    }

    try {
      if (editingSession) {
        if (editingTunnelId) {
          const updateFn = getIpcFn("forwardUpdate");
          if (updateFn) {
            await updateFn(editingTunnelId, input);
          }
        } else {
          const createFn = getIpcFn("forwardCreate");
          if (createFn) {
            await createFn(input);
          }
        }
        await loadSessionTunnels(editingSession.id);
      } else {
        if (editingTunnelId) {
          setPendingTunnels((prev) =>
            prev.map((item) =>
              item.tempId === editingTunnelId
                ? { ...input, tempId: editingTunnelId }
                : item
            )
          );
        } else {
          setPendingTunnels((prev) => [
            ...prev,
            { ...input, tempId: `temp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` },
          ]);
        }
      }
      resetTunnelForm();
    } catch (err) {
      setTunnelMsg(formatFriendlyError(err));
    }
  };

  const handleEditEmbeddedTunnel = (
    rule: PortForwardRule | PendingTunnelRule,
    isExisting: boolean
  ) => {
    const id = isExisting ? (rule as PortForwardRule).id : (rule as PendingTunnelRule).tempId;
    setEditingTunnelId(id);
    setTunnelName(rule.name || "");
    setTunnelType((rule.rule_type as PortForwardType) || "local");
    setTunnelBindHost(rule.bind_host || "127.0.0.1");
    setTunnelBindPort(rule.bind_port || 8080);
    setTunnelDestHost(rule.dest_host || "127.0.0.1");
    setTunnelDestPort(rule.dest_port || 80);
    setTunnelAutoStart(rule.auto_start ?? true);
    setTunnelSocksAuth((rule.socks_auth as SocksAuth) || "none");
    setTunnelSocksUsername(rule.socks_username || "");
    // 不把已保存的密码回填到输入框
    setTunnelSocksPassword("");
  };

  const handleDeleteEmbeddedTunnel = async (id: string, isExisting: boolean) => {
    try {
      if (isExisting && editingSession) {
        const delFn = getIpcFn("forwardDelete");
        if (delFn) {
          await delFn(id);
        }
        await loadSessionTunnels(editingSession.id);
      } else {
        setPendingTunnels((prev) => prev.filter((item) => item.tempId !== id));
      }
      if (editingTunnelId === id) {
        resetTunnelForm();
      }
    } catch (err) {
      setTunnelMsg(formatFriendlyError(err));
    }
  };

  const savePasswordCredentialIfNeeded = async (
    sessionName: string,
    user: string
  ): Promise<string | null> => {
    const fallbackCredId = editingSession?.credential_id || null;
    if (!password) return fallbackCredId;
    if (isVaultLocked) {
      throw new Error("主保险库尚未解锁，请在下方输入主密码快速解锁后再加密保存密码");
    }
    try {
      const cred = await createCredential(
        `${sessionName} (${user || "user"})`,
        "password",
        password,
        user || undefined
      );
      return cred.id;
    } catch (credErr: any) {
      if (parseIpcError(credErr).code === "VAULT_LOCKED") {
        await refreshVaultStatus();
        setActiveTab("general");
      }
      throw new Error(`保存密码凭据失败：${formatFriendlyError(credErr)}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // 自动补全名称
    let sessionName = name.trim();
    if (!sessionName) {
      if (protocol === "ssh") {
        sessionName = host.trim() ? `${username || "root"}@${host.trim()}` : "未命名 SSH 会话";
      } else if (protocol === "rdp") {
        const rdpPort = port > 0 ? port : 3389;
        sessionName = host.trim()
          ? `${username || "Administrator"}@${host.trim()}:${rdpPort}`
          : "未命名远程桌面";
      } else if (protocol === "local_shell") {
        const shellLabel =
          SHELL_KIND_OPTIONS.find((item) => item.value === shellKind)?.label.split(" (")[0] ||
          "本地终端";
        sessionName = shellLabel;
      } else if (protocol === "telnet") {
        const tPort = port > 0 ? port : 23;
        sessionName = host.trim() ? `Telnet-${host.trim()}:${tPort}` : "未命名 Telnet 会话";
      } else {
        sessionName = serialPort.trim() ? `Serial-${serialPort.trim()}` : "未命名串口会话";
      }
    }

    if (protocol === "ssh" || protocol === "rdp" || protocol === "telnet") {
      if (!host.trim()) {
        setError("请输入主机地址 (IP 或域名)");
        if (protocol === "ssh") setActiveTab("general");
        return;
      }
    } else if (protocol === "serial") {
      if (!serialPort.trim()) {
        setError("请选择或输入串口设备名称");
        return;
      }
    } else if (protocol === "local_shell") {
      if (shellKind === "custom" && !shellPath.trim()) {
        setError("请输入自定义 Shell 可执行文件路径");
        return;
      }
    }

    setIsSubmitting(true);
    setError(null);

    let savedSession: Session | undefined;

    try {
      const effectiveGroupId = groupId && groupId.trim() ? groupId.trim() : null;
      const effectiveIconKey = iconKey === DEFAULT_HOST_ICON_KEY ? null : iconKey;
      const effectiveNotes = notes && notes.trim() ? notes.trim() : null;
      const effectiveProxyId = proxyId && proxyId.trim() ? proxyId.trim() : null;

      if (protocol === "ssh") {
        let credentialId = editingSession?.credential_id || null;

        if (authMethod === "password") {
          if (password) {
            if (isVaultLocked) {
              setError("主保险库尚未解锁，请在下方输入主密码快速解锁后再加密保存密码");
              setActiveTab("general");
              setIsSubmitting(false);
              return;
            }
            credentialId = await savePasswordCredentialIfNeeded(
              sessionName,
              username.trim() || "root"
            );
          }
        } else if (isPublicKeyAuth(authMethod) || authMethod === "agent") {
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

        const effectiveAuthMethod: AuthMethod = isPublicKeyAuth(authMethod)
          ? "public_key"
          : (authMethod as AuthMethod);

        const sshOptions: SshProtocolOptions = {
          exec_channel_enable: execChannelEnable,
          accelerate: sshAccelerate,
          backspace_key_sequence: backspaceSeq,
          delete_key_sequence: deleteSeq,
          forwarding_auto_reconnect: true,
        };

        const sshPayload = {
          name: sessionName,
          group_id: effectiveGroupId,
          protocol: "ssh" as const,
          host: host.trim(),
          port: effectivePort,
          username: username.trim() || "root",
          auth_method: effectiveAuthMethod,
          credential_id: credentialId,
          ssh_key_id: effectiveKeyId,
          host_key_policy: hostKeyPolicy,
          proxy_jump_json: proxyJumpJson,
          proxy_id: effectiveProxyId,
          encoding: encoding || "utf-8",
          startup_command: startupCommand.trim() ? startupCommand.trim() : null,
          working_dir: workingDir.trim() ? workingDir.trim() : null,
          keepalive_sec: keepaliveSec,
          auto_reconnect: autoReconnect,
          reconnect_max: Math.max(1, Math.min(20, Number(reconnectMax) || 5)),
          compression,
          agent_forwarding: agentForwarding,
          x11_forwarding: x11Forwarding,
          color: null,
          icon_key: effectiveIconKey,
          notes: effectiveNotes,
          protocol_options_json: sshOptions,
        };

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, sshPayload);
        } else {
          savedSession = await createSession(sshPayload);
          if (savedSession && pendingTunnels.length > 0) {
            const createTunnelFn = getIpcFn("forwardCreate");
            if (createTunnelFn) {
              for (const rule of pendingTunnels) {
                const { tempId: _unused, ...ruleInput } = rule;
                try {
                  await createTunnelFn({
                    ...ruleInput,
                    session_id: savedSession.id,
                  });
                } catch (e) {
                  console.warn("创建内嵌隧道规则失败:", e);
                }
              }
            }
          }
        }
      } else if (protocol === "rdp") {
        const effectiveUser = username.trim() || "Administrator";
        const credentialId = await savePasswordCredentialIfNeeded(sessionName, effectiveUser);
        const effectivePort = port > 0 && port <= 65535 ? port : 3389;
        const rdpOptions: RdpProtocolOptions = {
          fullscreen: rdpFullscreen,
          custom_size: !rdpFullscreen,
          width: Number(rdpWidth) || 1920,
          height: Number(rdpHeight) || 1080,
          drivestoredirect: rdpDrivesRedirect,
          redirect_clipboard: rdpClipboard,
          redirect_printers: rdpPrinters,
          redirect_audio: rdpAudio,
          domain: rdpDomain.trim() ? rdpDomain.trim() : null,
          admin_session: rdpAdminSession,
        };

        const rdpPayload = {
          name: sessionName,
          group_id: effectiveGroupId,
          protocol: "rdp" as const,
          host: host.trim(),
          port: effectivePort,
          username: effectiveUser,
          auth_method: "password" as const,
          credential_id: credentialId,
          proxy_id: effectiveProxyId,
          color: null,
          icon_key: effectiveIconKey,
          notes: effectiveNotes,
          protocol_options_json: rdpOptions,
        };

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, rdpPayload);
        } else {
          savedSession = await createSession(rdpPayload);
        }
      } else if (protocol === "local_shell") {
        const localOptions: LocalShellProtocolOptions = {
          shell_kind: shellKind,
          shell_path: shellKind === "custom" && shellPath.trim() ? shellPath.trim() : null,
        };

        const localPayload = {
          name: sessionName,
          group_id: effectiveGroupId,
          protocol: "local_shell" as const,
          host: null,
          port: null,
          username: null,
          auth_method: "none" as const,
          encoding: encoding || "utf-8",
          startup_command: startupCommand.trim() ? startupCommand.trim() : null,
          working_dir: workingDir.trim() ? workingDir.trim() : null,
          color: null,
          icon_key: effectiveIconKey,
          notes: effectiveNotes,
          protocol_options_json: localOptions,
        };

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, localPayload);
        } else {
          savedSession = await createSession(localPayload);
        }
      } else if (protocol === "telnet") {
        const effectiveUser = username.trim();
        const credentialId = await savePasswordCredentialIfNeeded(
          sessionName,
          effectiveUser || "telnet"
        );
        const effectivePort = port > 0 && port <= 65535 ? port : 23;
        const telnetOptions: TelnetProtocolOptions = {
          auto_login: telnetAutoLogin,
          login_prompt: telnetLoginPrompt || "login:",
          password_prompt: telnetPasswordPrompt || "Password:",
          newline_mode: telnetNewlineMode,
          local_echo: telnetLocalEcho,
        };

        const telnetPayload = {
          name: sessionName,
          group_id: effectiveGroupId,
          protocol: "telnet" as const,
          host: host.trim(),
          port: effectivePort,
          username: effectiveUser ? effectiveUser : null,
          auth_method: (credentialId ? "password" : "none") as AuthMethod,
          credential_id: credentialId,
          proxy_id: effectiveProxyId,
          encoding: encoding || "utf-8",
          auto_reconnect: autoReconnect,
          color: null,
          icon_key: effectiveIconKey,
          notes: effectiveNotes,
          protocol_options_json: telnetOptions,
        };

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, telnetPayload);
        } else {
          savedSession = await createSession(telnetPayload);
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

        const serialPayload = {
          name: sessionName,
          group_id: effectiveGroupId,
          protocol: "serial" as const,
          color: null,
          icon_key: effectiveIconKey,
          notes: effectiveNotes,
          protocol_options_json: serialOptions,
        };

        if (editingSession) {
          savedSession = await updateSession(editingSession.id, serialPayload);
        } else {
          savedSession = await createSession(serialPayload);
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
  const totalTunnelCount = editingSession ? existingTunnels.length : pendingTunnels.length;

  const renderProxySelectRow = () => (
    <div>
      <label className="block text-xs font-semibold text-ink-secondary mb-1">
        代理服务器
      </label>
      <div className="flex items-center gap-2">
        <select
          value={proxyId}
          onChange={(e) => setProxyId(e.target.value)}
          aria-label="代理服务器"
          className="flex-1 rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
        >
          <option value="">不使用代理 (直连)</option>
          {proxies.map((p) => (
            <option key={p.id} value={p.id}>
              [{p.proxy_type.toUpperCase()}] {p.name} ({p.host}:{p.port})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setProxyManagerOpen(true)}
          className="shrink-0 rounded-xl border border-line/20 bg-surface px-3 py-2 text-xs font-semibold text-ink-secondary hover:bg-surface-muted hover:text-ink transition"
        >
          管理代理...
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-line/10 bg-surface p-6 shadow-2xl flex flex-col max-h-[92vh] text-ink transition-all">
        {/* 顶部标题与专属连接类型 */}
        <div className="mb-4 flex items-center justify-between border-b border-line/15 pb-3.5 shrink-0">
          <div className="flex items-center gap-2.5">
            <HostIcon iconKey={iconKey} protocol={protocol} className="h-7 w-7 shrink-0" />
            <h3 className="text-base font-semibold text-ink tracking-tight">
              {editingSession
                ? PROTOCOL_TITLES[protocol].edit
                : PROTOCOL_TITLES[protocol].create}
            </h3>
            {!editingSession && (
              <select
                aria-label="切换连接类型"
                value={protocol}
                onChange={(e) => handleProtocolSwitch(e.target.value as Protocol)}
                className="ml-1.5 rounded-lg border border-line/15 bg-surface-muted/50 px-2.5 py-1 text-xs text-ink-secondary hover:text-ink focus:border-accent focus:outline-none transition"
              >
                <option value="ssh">SSH</option>
                <option value="rdp">Windows 远程桌面 (RDP)</option>
                <option value="serial">串口 (Serial)</option>
                <option value="telnet">Telnet</option>
                <option value="local_shell">本地终端</option>
              </select>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="text-ink-tertiary hover:text-ink-secondary p-1.5 rounded-full hover:bg-line/5 transition"
            title="关闭"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* SSH 模式下的内部子标签导航（常规与认证 / 高级与终端 / 隧道 / 图标） */}
        {protocol === "ssh" && (
          <div
            role="tablist"
            aria-label="会话设置分类"
            className="flex items-center gap-1 border-b border-line/15 mb-4 shrink-0 text-xs overflow-x-auto"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "general"}
              onClick={() => setActiveTab("general")}
              className={`shrink-0 whitespace-nowrap pb-2 px-3 border-b-2 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-t-md ${activeTab === "general"
                ? "border-accent text-accent font-bold"
                : "border-transparent text-ink-secondary hover:text-ink"
                }`}
            >
              常规与认证
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "advanced"}
              onClick={() => setActiveTab("advanced")}
              className={`shrink-0 whitespace-nowrap pb-2 px-3 border-b-2 font-medium transition flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-t-md ${activeTab === "advanced"
                ? "border-accent text-accent font-bold"
                : "border-transparent text-ink-secondary hover:text-ink"
                }`}
            >
              <span>高级与终端</span>
              {(jumpHostSessionId || proxyId) && (
                <span className="h-1.5 w-1.5 rounded-full bg-state-warning" />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "tunnel"}
              onClick={() => setActiveTab("tunnel")}
              className={`shrink-0 whitespace-nowrap pb-2 px-3 border-b-2 font-medium transition flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-t-md ${activeTab === "tunnel"
                ? "border-accent text-accent font-bold"
                : "border-transparent text-ink-secondary hover:text-ink"
                }`}
            >
              <span>隧道 / 端口转发</span>
              {totalTunnelCount > 0 && (
                <span className="rounded-full bg-accent/15 px-1.5 py-0.2 text-[10px] font-bold text-accent">
                  {totalTunnelCount}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "icon"}
              onClick={() => setActiveTab("icon")}
              className={`shrink-0 whitespace-nowrap pb-2 px-3 border-b-2 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded-t-md ${activeTab === "icon"
                ? "border-accent text-accent font-bold"
                : "border-transparent text-ink-secondary hover:text-ink"
                }`}
            >
              主机图标
            </button>
          </div>
        )}

        <form
          id="session-modal-form"
          onSubmit={handleSubmit}
          className="space-y-4 flex-1 min-h-0 overflow-y-auto pr-1"
        >
          {/* ================= 1. SSH 常规与认证 ================= */}
          {protocol === "ssh" && activeTab === "general" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="session-name" className="block text-xs font-semibold text-ink-secondary mb-1">
                    会话显示名称
                  </label>
                  <input
                    id="session-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    所属分组
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
                  <label htmlFor="session-host" className="block text-xs font-semibold text-ink-secondary mb-1">
                    主机地址<RequiredMark value={host} />
                  </label>
                  <input
                    id="session-host"
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    autoFocus
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                    aria-required="true"
                    aria-label="主机地址"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    端口
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
                  用户名
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink placeholder-ink-tertiary focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                />
              </div>

              {/* 核心认证区 */}
              <div className="pt-2 border-t border-line/15">
                <label className="block text-xs font-semibold text-ink-secondary mb-2">
                  认证方式
                </label>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => setAuthMethod("password")}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${authMethod === "password"
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
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${isPublicKeyAuth(authMethod)
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
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${authMethod === "keyboard_interactive"
                      ? "bg-action/5 border-accent text-accent ring-1 ring-accent/30 shadow-apple-sm"
                      : "bg-surface-muted/60 border-line/15 text-ink-secondary hover:bg-line/5"
                      }`}
                  >
                    <div className="font-bold flex items-center gap-1.5">
                      <span>💬 交互式验证</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAuthMethod("agent")}
                    className={`p-2.5 rounded-xl border text-xs font-medium text-left transition ${authMethod === "agent"
                      ? "bg-action/5 border-accent text-accent ring-1 ring-accent/30 shadow-apple-sm"
                      : "bg-surface-muted/60 border-line/15 text-ink-secondary hover:bg-line/5"
                      }`}
                  >
                    <div className="font-bold flex items-center gap-1.5">
                      <span>🔐 SSH Agent</span>
                    </div>
                  </button>
                </div>

                {/* 密码输入区 */}
                {authMethod === "password" && (
                  <div className="rounded-xl border border-line/15 bg-surface-muted/40 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="block text-xs font-medium text-ink-secondary">
                        连接密码
                      </label>
                      {editingSession?.credential_id && !password && (
                        <span className="text-[11px] text-accent font-medium">已保存密码</span>
                      )}
                    </div>
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

                    {isVaultLocked && password && (
                      <VaultInlineUnlock
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
                          onChange={(e) => {
                            setSelectedKeyId(e.target.value);
                            setKeyMsg(null);
                          }}
                        >
                          <option value="">
                            {sshKeys.length ? "请选择私钥" : "暂无已保存的私钥"}
                          </option>
                          {sshKeys.map((key) => (
                            <option key={key.id} value={key.id}>
                              {key.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <Button onClick={() => setKeyImportOpen(true)}>导入私钥</Button>
                      {selectedKeyId && (
                        <IconButton
                          label="移除选中的私钥配置"
                          onClick={() => {
                            const key = sshKeys.find((item) => item.id === selectedKeyId);
                            if (key) handleDeleteKey(key);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                    {selectedKey && (
                      <div
                        role="status"
                        aria-label="当前私钥"
                        className="flex min-w-0 items-center gap-2.5 rounded-xl bg-action/5 px-4 py-3 text-accent"
                      >
                        <KeyRound className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="truncate text-sm font-semibold" title={selectedKey.name}>
                          {selectedKey.name}
                        </span>
                      </div>
                    )}
                    {keyMsg && (
                      <p role="status" className="text-xs text-ink-secondary">
                        {keyMsg}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 代理服务器与跳板机（常规页直接可配） */}
              <div className="pt-2 border-t border-line/15 space-y-3">
                {renderProxySelectRow()}

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    跳板机 (ProxyJump)
                  </label>
                  <select
                    value={jumpHostSessionId}
                    aria-label="跳板机"
                    onChange={(e) => setJumpHostSessionId(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    <option value="">不使用跳板机</option>
                    {candidateJumpHosts.map((s) => (
                      <option key={s.id} value={s.id}>
                        经由 {s.name} ({s.username || "root"}@{s.host}:{s.port || 22})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* ================= 2. SSH 高级与终端 / 跳板机 ================= */}
          {protocol === "ssh" && activeTab === "advanced" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    跳板机 (ProxyJump)
                  </label>
                  <select
                    value={jumpHostSessionId}
                    onChange={(e) => setJumpHostSessionId(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    <option value="">不使用跳板机</option>
                    {candidateJumpHosts.map((s) => (
                      <option key={s.id} value={s.id}>
                        经由 {s.name} ({s.username || "root"}@{s.host}:{s.port || 22})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    字符编码 (Encoding)
                  </label>
                  <select
                    value={encoding}
                    onChange={(e) => setEncoding(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    {ENCODING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {renderProxySelectRow()}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    主机指纹校验
                  </label>
                  <select
                    value={hostKeyPolicy}
                    onChange={(e) => setHostKeyPolicy(e.target.value as HostKeyPolicy)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  >
                    <option value="strict">首次连接时确认主机指纹</option>
                    <option value="accept_new">首次连接自动接受主机指纹</option>
                    <option value="insecure">不校验主机指纹</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    保活心跳间隔（秒）
                  </label>
                  <input
                    type="number"
                    value={keepaliveSec}
                    onChange={(e) => setKeepaliveSec(Number(e.target.value))}
                    min={5}
                    max={600}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    默认工作目录
                  </label>
                  <input
                    type="text"
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs font-mono text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    登录后自动执行命令
                  </label>
                  <input
                    type="text"
                    value={startupCommand}
                    onChange={(e) => setStartupCommand(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs font-mono text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    退格键序列 (Backspace)
                  </label>
                  <select
                    value={backspaceSeq}
                    onChange={(e) =>
                      setBackspaceSeq(e.target.value as "ascii_del" | "ctrl_h" | "auto")
                    }
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none transition"
                  >
                    <option value="auto">自动匹配 (Auto)</option>
                    <option value="ascii_del">ASCII DEL (0x7F)</option>
                    <option value="ctrl_h">Ctrl+H (0x08)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    Delete 键序列
                  </label>
                  <select
                    value={deleteSeq}
                    onChange={(e) =>
                      setDeleteSeq(e.target.value as "vt220" | "ascii_del" | "auto")
                    }
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none transition"
                  >
                    <option value="auto">自动匹配 (Auto)</option>
                    <option value="vt220">VT220 (ESC [ 3 ~)</option>
                    <option value="ascii_del">ASCII DEL (0x7F)</option>
                  </select>
                </div>
              </div>

              <div className="rounded-xl border border-line/15 bg-surface-muted/30 p-3 space-y-2.5">
                <div className="text-xs font-semibold text-ink-secondary">
                  高级选项与特性开关
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs text-ink-secondary">
                  <div className="flex flex-wrap items-center gap-2 col-span-2 sm:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoReconnect}
                        onChange={(e) => setAutoReconnect(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                      />
                      <span>断线自动重连</span>
                    </label>
                    <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-tertiary">
                      <span>最大重试次数 (1 ~ 20):</span>
                      <input
                        type="number"
                        aria-label="最大重试次数"
                        min={1}
                        max={20}
                        disabled={!autoReconnect}
                        value={reconnectMax}
                        onChange={(e) =>
                          setReconnectMax(
                            Math.max(1, Math.min(20, Number(e.target.value) || 5))
                          )
                        }
                        className="w-14 rounded-lg border border-line/20 bg-surface px-2 py-0.5 text-center font-mono text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
                      />
                      <span>次</span>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={compression}
                      onChange={(e) => setCompression(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>SSH 数据压缩</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={agentForwarding}
                      onChange={(e) => setAgentForwarding(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>Agent 认证转发</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={x11Forwarding}
                      onChange={(e) => setX11Forwarding(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>X11 图形转发</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={execChannelEnable}
                      onChange={(e) => setExecChannelEnable(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>启用监控 Exec 通道</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sshAccelerate}
                      onChange={(e) => setSshAccelerate(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>网络传输加速标记</span>
                  </label>
                </div>

                {/* 内置 SFTP 流水线与断线重连由底层网络通道保障 */}
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  备注说明
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                />
              </div>
            </div>
          )}

          {/* ================= 3. SSH 隧道 / 端口转发 Tab ================= */}
          {protocol === "ssh" && activeTab === "tunnel" && (
            <div className="space-y-4">
              {tunnelMsg && (
                <div className="rounded-xl border border-state-danger/30 bg-state-danger/10 px-3 py-2 text-xs text-state-danger">
                  {tunnelMsg}
                </div>
              )}

              {/* 内嵌新增/编辑规则表单 */}
              <div className="rounded-xl border border-line/15 bg-surface-muted/30 p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-ink">
                    {editingTunnelId ? "编辑隧道转发规则" : "添加隧道转发规则"}
                  </span>
                  {editingTunnelId && (
                    <button
                      type="button"
                      onClick={resetTunnelForm}
                      className="text-[11px] text-accent hover:underline"
                    >
                      取消编辑
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { value: "local", label: "本地转发 (-L)" },
                      { value: "remote", label: "远端转发 (-R)" },
                      { value: "dynamic", label: "动态 SOCKS5 (-D)" },
                    ] as Array<{ value: PortForwardType; label: string }>
                  ).map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setTunnelType(item.value)}
                      className={`rounded-lg border py-1.5 text-xs font-semibold transition ${tunnelType === item.value
                        ? "border-accent bg-action/10 text-accent"
                        : "border-line/15 bg-surface text-ink-secondary hover:text-ink"
                        }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                      规则名称
                    </label>
                    <input
                      type="text"
                      value={tunnelName}
                      onChange={(e) => setTunnelName(e.target.value)}
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                      {tunnelType === "remote" ? "远端绑定地址" : "本地绑定地址"}
                    </label>
                    <input
                      type="text"
                      value={tunnelBindHost}
                      onChange={(e) => setTunnelBindHost(e.target.value)}
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                      {tunnelType === "remote" ? "远端监听端口" : "本地监听端口"}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={tunnelBindPort}
                      onChange={(e) => setTunnelBindPort(Number(e.target.value))}
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>

                {tunnelType !== "dynamic" && (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                        {tunnelType === "remote" ? "本机目标地址" : "远端目标地址"}
                      </label>
                      <input
                        type="text"
                        value={tunnelDestHost}
                        onChange={(e) => setTunnelDestHost(e.target.value)}
                        className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                        {tunnelType === "remote" ? "本机目标端口" : "远端目标端口"}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={tunnelDestPort}
                        onChange={(e) => setTunnelDestPort(Number(e.target.value))}
                        className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                {tunnelType === "dynamic" && (
                  <div className="grid grid-cols-3 gap-2.5 rounded-xl border border-line/15 bg-surface-muted/40 p-2.5">
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                        SOCKS5 认证
                      </label>
                      <select
                        value={tunnelSocksAuth}
                        onChange={(e) => setTunnelSocksAuth(e.target.value as SocksAuth)}
                        className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                      >
                        <option value="none">无需认证</option>
                        <option value="userpass">用户名 / 密码</option>
                      </select>
                    </div>
                    {tunnelSocksAuth === "userpass" && (
                      <>
                        <div>
                          <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                            用户名
                          </label>
                          <input
                            type="text"
                            value={tunnelSocksUsername}
                            onChange={(e) => setTunnelSocksUsername(e.target.value)}
                            autoComplete="off"
                            className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-semibold text-ink-secondary">
                            密码（仅本次输入，不保存到本地）
                          </label>
                          <input
                            type="password"
                            value={tunnelSocksPassword}
                            onChange={(e) => setTunnelSocksPassword(e.target.value)}
                            autoComplete="new-password"
                            placeholder={editingTunnelId ? "留空沿用已保存凭据" : ""}
                            className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <label className="flex items-center gap-2 cursor-pointer text-xs text-ink-secondary">
                    <input
                      type="checkbox"
                      checked={tunnelAutoStart}
                      onChange={(e) => setTunnelAutoStart(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>随 SSH 连接自动启动此隧道</span>
                  </label>

                  <button
                    type="button"
                    onClick={() => void handleSaveEmbeddedTunnel()}
                    className="inline-flex items-center gap-1 rounded-lg bg-action px-3 py-1.5 text-xs font-semibold text-white shadow-apple-sm hover:bg-action/90 transition"
                  >
                    <PlusIcon className="h-3.5 w-3.5" />
                    <span>{editingTunnelId ? "更新规则" : "添加至列表"}</span>
                  </button>
                </div>
              </div>

              {/* 已绑定的隧道列表 */}
              <div className="space-y-2">
                <div className="text-xs font-semibold text-ink-secondary">
                  当前会话绑定的隧道规则 ({totalTunnelCount})
                </div>

                {totalTunnelCount === 0 ? (
                  <div className="rounded-xl border border-dashed border-line/20 py-6 text-center text-xs text-ink-tertiary">
                    暂无端口转发规则
                  </div>
                ) : editingSession ? (
                  existingTunnels.map((rule) => (
                    <div
                      key={rule.id}
                      className="flex items-center justify-between rounded-xl border border-line/15 bg-surface p-2.5 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink">{rule.name}</span>
                          <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent uppercase">
                            {rule.rule_type}
                          </span>
                          {rule.auto_start && (
                            <span className="rounded bg-line/10 px-1.5 py-0.5 text-[10px] text-ink-secondary">
                              自动启动
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-ink-secondary">
                          {rule.bind_host}:{rule.bind_port}
                          {rule.rule_type !== "dynamic"
                            ? ` → ${rule.dest_host}:${rule.dest_port}`
                            : " (SOCKS5)"}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleEditEmbeddedTunnel(rule, true)}
                          className="rounded-lg p-1.5 text-ink-tertiary hover:bg-line/10 hover:text-ink"
                          title="编辑隧道"
                        >
                          <PencilIcon className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteEmbeddedTunnel(rule.id, true)}
                          className="rounded-lg p-1.5 text-ink-tertiary hover:bg-state-danger/10 hover:text-state-danger"
                          title="删除隧道"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  pendingTunnels.map((rule) => (
                    <div
                      key={rule.tempId}
                      className="flex items-center justify-between rounded-xl border border-line/15 bg-surface p-2.5 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-ink">{rule.name}</span>
                          <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent uppercase">
                            {rule.rule_type}
                          </span>
                          <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
                            待保存创建
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono text-[11px] text-ink-secondary">
                          {rule.bind_host}:{rule.bind_port}
                          {rule.rule_type !== "dynamic"
                            ? ` → ${rule.dest_host}:${rule.dest_port}`
                            : " (SOCKS5)"}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleEditEmbeddedTunnel(rule, false)}
                          className="rounded-lg p-1.5 text-ink-tertiary hover:bg-line/10 hover:text-ink"
                          title="编辑隧道"
                        >
                          <PencilIcon className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteEmbeddedTunnel(rule.tempId, false)}
                          className="rounded-lg p-1.5 text-ink-tertiary hover:bg-state-danger/10 hover:text-state-danger"
                          title="删除隧道"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ================= 4. SSH 主机图标 ================= */}
          {protocol === "ssh" && activeTab === "icon" && (
            <HostIconPicker
              value={iconKey}
              onChange={selectIcon}
              onAutoDetect={applyAutoIcon}
              radioName="icon-tab-host-icon"
            />
          )}

          {/* ================= Windows 远程桌面配置区 (RDP) ================= */}
          {protocol === "rdp" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    连接名称
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    所属分组
                  </label>
                  <select
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
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
                    主机地址<RequiredMark value={host} />
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                    aria-required="true"
                    aria-label="主机地址"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    RDP 端口
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port > 0 ? port : 3389}
                    onChange={(e) => setPort(Number(e.target.value) || 3389)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    用户名
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-ink-secondary">
                      登录密码
                    </label>
                    {editingSession?.credential_id && !password && (
                      <span className="text-[11px] text-accent font-medium">已保存</span>
                    )}
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    Windows 域
                  </label>
                  <input
                    type="text"
                    value={rdpDomain}
                    onChange={(e) => setRdpDomain(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
              </div>

              {isVaultLocked && password && (
                <VaultInlineUnlock
                  uninitialized={!!isVaultUninitialized}
                  password={vaultPassword}
                  onPasswordChange={setVaultPassword}
                  busy={unlockingVault}
                  error={vaultUnlockError}
                  onSubmit={handleInlineVaultUnlock}
                />
              )}

              {/* 显示与分辨率 */}
              <div className="rounded-xl border border-line/15 bg-surface-muted/30 p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-ink-secondary">
                    显示模式与分辨率
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setRdpFullscreen(true)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${rdpFullscreen
                        ? "bg-action text-white border-accent font-semibold"
                        : "bg-surface text-ink-secondary border-line/15"
                        }`}
                    >
                      全屏模式
                    </button>
                    <button
                      type="button"
                      onClick={() => setRdpFullscreen(false)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${!rdpFullscreen
                        ? "bg-action text-white border-accent font-semibold"
                        : "bg-surface text-ink-secondary border-line/15"
                        }`}
                    >
                      自定义尺寸
                    </button>
                  </div>
                </div>

                {!rdpFullscreen && (
                  <div className="space-y-2.5 pt-1">
                    <div className="flex flex-wrap gap-1.5">
                      {RDP_RESOLUTION_PRESETS.map((preset) => {
                        const active =
                          rdpWidth === preset.width && rdpHeight === preset.height;
                        return (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() => {
                              setRdpWidth(preset.width);
                              setRdpHeight(preset.height);
                            }}
                            className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition ${active
                              ? "border-accent bg-action/10 text-accent font-bold"
                              : "border-line/15 bg-surface text-ink-secondary hover:text-ink"
                              }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold text-ink-secondary mb-1">
                          宽度 (px)
                        </label>
                        <input
                          type="number"
                          min={640}
                          max={7680}
                          value={rdpWidth}
                          onChange={(e) => setRdpWidth(Number(e.target.value))}
                          className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-ink-secondary mb-1">
                          高度 (px)
                        </label>
                        <input
                          type="number"
                          min={480}
                          max={4320}
                          value={rdpHeight}
                          onChange={(e) => setRdpHeight(Number(e.target.value))}
                          className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 本地资源重定向与高级选项 */}
              <div className="rounded-xl border border-line/15 bg-surface-muted/30 p-3.5 space-y-3">
                <div className="text-xs font-semibold text-ink-secondary">
                  本地资源重定向
                </div>
                <div className="grid grid-cols-2 gap-2.5 text-xs text-ink-secondary">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rdpDrivesRedirect}
                      onChange={(e) => setRdpDrivesRedirect(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>映射本地磁盘驱动器</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rdpClipboard}
                      onChange={(e) => setRdpClipboard(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>共享剪贴板</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rdpPrinters}
                      onChange={(e) => setRdpPrinters(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>重定向本地打印机</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={rdpAdminSession}
                      onChange={(e) => setRdpAdminSession(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>管理员控制台会话</span>
                  </label>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    远程音频重定向
                  </label>
                  <select
                    value={rdpAudio}
                    onChange={(e) =>
                      setRdpAudio(e.target.value as "local" | "remote" | "none")
                    }
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink"
                  >
                    <option value="local">本机播放</option>
                    <option value="remote">远程播放</option>
                    <option value="none">静音</option>
                  </select>
                </div>
              </div>

              {renderProxySelectRow()}

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  备注说明
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink"
                />
              </div>

              <HostIconPicker
                value={iconKey}
                onChange={selectIcon}
                onAutoDetect={applyAutoIcon}
                radioName="rdp-host-icon"
                compact
              />
            </div>
          )}

          {/* ================= 本地终端配置区 (LocalShell) ================= */}
          {protocol === "local_shell" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    终端显示名称
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    所属分组
                  </label>
                  <select
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
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

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  Shell 类型
                </label>
                <select
                  value={shellKind}
                  onChange={(e) => setShellKind(e.target.value as LocalShellKind)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                >
                  {SHELL_KIND_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {shellKind === "custom" && (
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    程序路径<RequiredMark value={shellPath} />
                  </label>
                  <input
                    type="text"
                    value={shellPath}
                    onChange={(e) => setShellPath(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                    aria-required="true"
                    aria-label="程序路径"
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    工作目录
                  </label>
                  <input
                    type="text"
                    value={workingDir}
                    onChange={(e) => setWorkingDir(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    字符编码
                  </label>
                  <select
                    value={encoding}
                    onChange={(e) => setEncoding(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                  >
                    {ENCODING_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  启动命令
                </label>
                <input
                  type="text"
                  value={startupCommand}
                  onChange={(e) => setStartupCommand(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  备注说明
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* ================= Telnet 主机配置区 (Telnet) ================= */}
          {protocol === "telnet" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    会话名称
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    所属分组
                  </label>
                  <select
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
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
                    主机地址<RequiredMark value={host} />
                  </label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                    aria-required="true"
                    aria-label="主机地址"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    Telnet 端口
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port > 0 ? port : 23}
                    onChange={(e) => setPort(Number(e.target.value) || 23)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-secondary mb-1">
                    登录用户名
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-semibold text-ink-secondary">
                      登录密码
                    </label>
                    {editingSession?.credential_id && !password && (
                      <span className="text-[11px] text-accent font-medium">已保存</span>
                    )}
                  </div>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl border border-line/15 bg-surface-muted/50 px-3 py-2 font-mono text-xs text-ink focus:border-accent focus:bg-surface focus:outline-none"
                  />
                </div>
              </div>

              {isVaultLocked && password && (
                <VaultInlineUnlock
                  uninitialized={!!isVaultUninitialized}
                  password={vaultPassword}
                  onPasswordChange={setVaultPassword}
                  busy={unlockingVault}
                  error={vaultUnlockError}
                  onSubmit={handleInlineVaultUnlock}
                />
              )}

              <div className="rounded-xl border border-line/15 bg-surface-muted/30 p-3.5 space-y-3">
                <div className="flex flex-wrap items-center gap-4 text-xs text-ink-secondary">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={telnetAutoLogin}
                      onChange={(e) => setTelnetAutoLogin(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>启用自动登录匹配 (auto_login)</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={telnetLocalEcho}
                      onChange={(e) => setTelnetLocalEcho(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-line/25 text-accent"
                    />
                    <span>本地回显 (local_echo)</span>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-secondary mb-1">
                      登录提示符匹配 (Login Prompt)
                    </label>
                    <input
                      type="text"
                      value={telnetLoginPrompt}
                      onChange={(e) => setTelnetLoginPrompt(e.target.value)}
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-secondary mb-1">
                      密码提示符匹配 (Password Prompt)
                    </label>
                    <input
                      type="text"
                      value={telnetPasswordPrompt}
                      onChange={(e) => setTelnetPasswordPrompt(e.target.value)}
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-secondary mb-1">
                      发送换行模式 (Newline Mode)
                    </label>
                    <select
                      value={telnetNewlineMode}
                      onChange={(e) =>
                        setTelnetNewlineMode(e.target.value as "crlf" | "lf" | "cr")
                      }
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-xs text-ink"
                    >
                      <option value="crlf">CRLF (\r\n)</option>
                      <option value="lf">LF (\n)</option>
                      <option value="cr">CR (\r)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-ink-secondary mb-1">
                      字符编码
                    </label>
                    <select
                      value={encoding}
                      onChange={(e) => setEncoding(e.target.value)}
                      className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 text-xs text-ink"
                    >
                      {ENCODING_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {renderProxySelectRow()}

              <div>
                <label className="block text-xs font-semibold text-ink-secondary mb-1">
                  备注说明
                </label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs text-ink"
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
                    串口设备<RequiredMark value={serialPort} />
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
                    aria-required="true"
                    aria-label="串口设备"
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
                    className="w-32 rounded-xl border border-line/15 bg-surface px-2.5 py-2 text-xs font-mono text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                    aria-required="true"
                    aria-label="串口设备"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-ink-secondary">
                    波特率<RequiredMark value={baudRate > 0 ? baudRate : ""} />
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
                    className="w-full rounded-xl border border-line/15 bg-surface px-3 py-2 text-xs font-mono text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition"
                    aria-required="true"
                    aria-label="波特率"
                  />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {COMMON_BAUD_RATES.map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => setBaudRate(rate)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-mono border transition ${baudRate === rate
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
                    <option value="none">无校验</option>
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
                    <option value="none">无流控</option>
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
                <span className="inline-flex items-center gap-1.5 text-state-warning">
                  <TriangleAlertIcon className="h-3.5 w-3.5" />
                  尚未选择私钥
                </span>
              )
            ) : protocol === "rdp" ? (
              <span className="inline-flex items-center gap-1.5">
                <MonitorIcon className="h-3.5 w-3.5" />
                Windows 远程桌面 (RDP)
              </span>
            ) : protocol === "local_shell" ? (
              <span className="inline-flex items-center gap-1.5">
                <TerminalIcon className="h-3.5 w-3.5" />
                本地终端会话
              </span>
            ) : protocol === "telnet" ? (
              <span className="inline-flex items-center gap-1.5">
                <GlobeIcon className="h-3.5 w-3.5" />
                Telnet 会话
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                {protocol === "ssh" ? (
                  <KeyIcon className="h-3.5 w-3.5" />
                ) : (
                  <PlugIcon className="h-3.5 w-3.5" />
                )}
                {protocol === "ssh" ? "密码认证" : "串口会话"}
              </span>
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
                <PlayIcon className="h-3.5 w-3.5" />
                <span>
                  {isSubmitting && connectAfterSave ? "保存并连接中..." : "保存并立即连接"}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>

      {keyImportOpen && (
        <SshKeyImportModal
          onClose={() => {
            setKeyImportOpen(false);
            setVaultPassword("");
            setVaultUnlockError(null);
          }}
          onSaved={(key) => {
            setSshKeys((keys) =>
              keys.some((item) => item.id === key.id)
                ? keys.map((item) => (item.id === key.id ? key : item))
                : [...keys, key]
            );
            setSelectedKeyId(key.id);
            setKeyMsg(null);
            setKeyImportOpen(false);
          }}
          vaultUnlock={
            isVaultLocked ? (
              <VaultInlineUnlock
                uninitialized={!!isVaultUninitialized}
                password={vaultPassword}
                onPasswordChange={setVaultPassword}
                busy={unlockingVault}
                error={vaultUnlockError}
                onSubmit={handleInlineVaultUnlock}
              />
            ) : null
          }
        />
      )}

      <ProxyManagerModal
        open={proxyManagerOpen}
        onClose={() => setProxyManagerOpen(false)}
        onChanged={(nextProxies) => {
          setProxies(nextProxies);
          if (proxyId && !nextProxies.some((p) => p.id === proxyId)) {
            setProxyId("");
          }
        }}
      />
    </div>
  );
};
