/**
 * 统一把后端 IPC 错误转换成面向普通用户的中文提示。
 *
 * 后端 DomainError 的 message 大多已是可展示文案（中文），但仍有少量
 * 底层错误（SQLite、io、utf-8、解析器异常等）会直接透出。这里按错误码
 * 兜底，并将明显的技术细节替换为可操作的建议。
 */

export interface IpcErrorShape {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
  correlation_id?: string;
}

const CODE_MESSAGES: Record<string, string> = {
  AUTH_FAILED: "身份认证失败：请核对用户名、密码或私钥是否正确。",
  AUTH_METHOD_UNSUPPORTED: "服务器不支持所选的认证方式，请改用密码或私钥登录。",
  HOSTKEY_UNKNOWN: "首次连接该服务器，尚未记录其主机指纹。可将主机密钥策略设为「首次自动接受」后重试。",
  HOSTKEY_MISMATCH: "服务器的主机指纹与历史记录不一致，为安全起见已阻止连接。若确认服务器重装过，可在该会话设置中把「主机密钥校验策略」改为「不校验主机密钥」后重试。",
  HOST_UNREACHABLE: "无法连接到目标服务器：请确认 IP/端口正确、SSH 服务已启动且防火墙已放行。",
  NETWORK: "网络连接中断，请检查本机网络或服务器状态后重试。",
  DNS: "域名解析失败，请检查服务器地址是否填写正确。",
  TIMEOUT: "连接超时，请检查网络、服务器 IP/端口与防火墙设置。",
  SSH_PROTOCOL: "与服务器的 SSH 协议协商失败，请检查服务器 sshd 配置或更换加密算法。",
  CHANNEL_LIMIT: "服务器拒绝打开新的终端通道，可能已达到会话数上限。",
  PROXY_CONNECT_FAILED: "跳板机/代理连接失败，请检查代理配置与跳板机状态。",
  VAULT_LOCKED: "主保险库已锁定，请先输入主密码解锁后再连接。",
  VAULT_UNINITIALIZED: "尚未初始化主保险库，请先设置主密码以安全保存登录凭据。",
  VAULT_DECRYPT_FAILED: "凭据解密失败，请确认主密码正确或重新录入该凭据。",
  VAULT_CORRUPT: "保险库文件已损坏，请从备份恢复或重新初始化。",
  KEYCHAIN_UNAVAILABLE: "系统钥匙串不可用，请手动输入主密码解锁。",
  VALIDATION: "填写的信息不完整或格式有误，请检查后重试。",
  NOT_FOUND: "未找到对应的数据，可能已被删除。",
  PERMISSION: "没有执行该操作的权限。",
  CONFLICT: "数据存在冲突，请刷新后重试。",
  CANCELLED: "操作已取消。",
  INTERNAL: "客户端内部出现异常，请重试；若持续出现请反馈日志。",
  IO: "本地读写失败，请检查磁盘空间与文件权限。",
  SFTP_NO_SUCH_FILE: "远端文件不存在或已被移动。",
  SFTP_PERMISSION: "远端文件权限不足，无法完成操作。",
  SFTP_PROTOCOL: "远端 SFTP 服务响应异常。",
  FORWARD_BIND: "本地端口已被占用，请更换端口或关闭占用程序。",
  FORWARD_REMOTE_DENIED: "远端服务器拒绝了端口转发请求。",
  SERVER_UNREACHABLE: "无法连接同步服务器，请检查服务器地址与网络。",
  SERVER_AUTH: "同步账号认证失败，请重新登录。",
  SYNC_CONFLICT: "同步数据存在冲突，请查看冲突详情后处理。",
  DEVICE_REVOKED: "当前设备已被撤销授权，请重新登录。",
  DEVICE_MISMATCH: "设备信息不匹配，请重新登录。",
  REGISTRATION_CLOSED: "该服务器已关闭注册。",
};

const TECHNICAL_MARKERS = [
  "os error",
  "io error",
  "sqlite",
  "constraint failed",
  "utf-8",
  "utf8",
  "panicked",
  "panic",
  "serde",
  "json error",
  "failed to",
  "error:",
  "invalid ",
  "unexpected",
  "unwrap",
  "index out of bounds",
  "null pointer",
  "connection reset by peer",
];

export function parseIpcError(err: unknown): IpcErrorShape {
  if (!err) return {};
  if (typeof err === "string") {
    // Tauri 有时会把错误序列化成 JSON 字符串
    try {
      const parsed = JSON.parse(err);
      if (parsed && typeof parsed === "object" && (parsed.code || parsed.message)) {
        return parsed as IpcErrorShape;
      }
    } catch {
      // 非 JSON，按纯文本处理
    }
    return { message: err };
  }
  if (typeof err === "object") {
    const obj = err as Record<string, any>;
    return {
      code: typeof obj.code === "string" ? obj.code : undefined,
      message:
        typeof obj.message === "string"
          ? obj.message
          : typeof obj.error === "string"
            ? obj.error
            : undefined,
      retryable: obj.retryable,
      details: obj.details,
      correlation_id: obj.correlation_id,
    };
  }
  return { message: String(err) };
}

function looksTechnical(message: string): boolean {
  const lower = message.toLowerCase();
  return TECHNICAL_MARKERS.some((m) => lower.includes(m));
}

/** 生成面向用户的中文错误文案（永不返回原始技术堆栈）。 */
export function formatFriendlyError(err: unknown): string {
  const { code, message } = parseIpcError(err);
  const trimmed = message?.trim();
  const raw = trimmed || "";

  // 少量已知场景给出具体操作建议
  if (raw.includes("UNIQUE constraint failed") || raw.includes("already exists")) {
    return "该私钥已经存在于列表中，已自动为您选中。";
  }
  const lowerRaw = raw.toLowerCase();
  if (
    lowerRaw.includes("key is encrypted") ||
    lowerRaw.includes("encrypted private key") ||
    (lowerRaw.includes("encrypted") && lowerRaw.includes("key"))
  ) {
    return "该私钥已加密，需要正确的私钥口令 (Passphrase)。请在「私钥管理」中为该私钥设置口令后重试。";
  }
  if (raw.includes("Could not read key") || raw.includes("failed to decode private key")) {
    return "私钥解析失败：请确认选择的是以 -----BEGIN 开头的 OpenSSH 或 PEM 格式私钥；若私钥带口令，请填写正确的 Passphrase。";
  }
  if (raw.includes("SSH 公钥") || raw.includes("Public Key")) {
    return "检测到输入的是 SSH 公钥。连接服务器需要使用私钥 (Private Key)，公钥应放在服务器的 ~/.ssh/authorized_keys 中。";
  }

  // 后端已本地化的中文提示优先展示
  const hasChinese = !!trimmed && /[\u4e00-\u9fa5]/.test(trimmed);
  if (trimmed && (hasChinese || !looksTechnical(trimmed))) {
    return trimmed.replace(/\s+/g, " ").slice(0, 500);
  }

  if (code && CODE_MESSAGES[code]) {
    return CODE_MESSAGES[code];
  }

  if (trimmed && looksTechnical(trimmed)) {
    return "操作未完成：客户端遇到未预期的错误，请重试；若持续出现请反馈日志。";
  }

  return CODE_MESSAGES.INTERNAL;
}

/** 是否属于“补录凭据后即可重试”的错误。 */
export function isCredentialError(err: unknown): boolean {
  const { code } = parseIpcError(err);
  return (
    code === "AUTH_FAILED" ||
    code === "VAULT_LOCKED" ||
    code === "VAULT_UNINITIALIZED" ||
    code === "AUTH_METHOD_UNSUPPORTED"
  );
}

export function claimErrorMessage(err: unknown, fallback: string): string {
  const text = formatFriendlyError(err);
  return text === CODE_MESSAGES.INTERNAL ? fallback : text;
}
