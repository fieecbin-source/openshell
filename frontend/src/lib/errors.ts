/**
 * 统一把后端 IPC 错误转换成面向普通用户的提示。
 *
 * 设计原则：
 * 1. 用户看到的第一行永远是「发生了什么 + 我该怎么办」，不出现 `os error 10061`、
 *    `ErrorKind`、错误码（如 HOST_UNREACHABLE）这类开发者术语；
 * 2. 原始技术文本只在「查看详情」里出现，方便反馈日志；
 * 3. 同一个错误在不同入口（弹窗、Toast、行内提示）文案一致。
 */

export interface IpcErrorShape {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
  correlation_id?: string;
}

/** 面向用户的错误描述：title 是结论，hint 是可操作建议。 */
export interface FriendlyError {
  title: string;
  hint?: string;
}

const CODE_MESSAGES: Record<string, string> = {
  AUTH_FAILED: "服务器拒绝了登录：请核对用户名、密码或私钥是否正确。",
  AUTH_METHOD_UNSUPPORTED: "服务器不支持当前选择的认证方式，请改用密码或私钥登录。",
  HOSTKEY_UNKNOWN:
    "首次连接该服务器，尚未记录它的主机指纹。可将「主机密钥校验策略」设为「自动接受首次连接」后重试。",
  HOSTKEY_MISMATCH:
    "服务器的主机指纹与历史记录不一致，为安全起见已阻止连接。若确认服务器重装过，可在会话设置里把「主机密钥校验策略」改为「不校验主机密钥」后重试。",
  HOST_UNREACHABLE: "连不上这台服务器：请确认 IP/端口正确、SSH 服务已启动，并且防火墙放行了该端口。",
  NETWORK: "网络连接中断了，请检查本机网络或服务器状态后重试。",
  DNS: "域名解析失败：请检查填写的服务器地址是否正确。",
  TIMEOUT: "连接超时：服务器没有在预期时间内响应，请检查网络、IP/端口与防火墙。",
  SSH_PROTOCOL: "与服务器的 SSH 协议协商失败，请检查服务器的 sshd 配置或加密算法设置。",
  CHANNEL_LIMIT: "服务器拒绝再开一个终端通道，可能已达到并发会话上限，请关闭部分会话后重试。",
  PROXY_CONNECT_FAILED: "跳板机/代理连接失败，请检查代理配置与跳板机是否在线。",
  VAULT_LOCKED: "主保险库已锁定，请先输入主密码解锁后再操作。",
  VAULT_UNINITIALIZED: "还没有初始化主保险库，请先设置主密码，用于安全保存登录凭据。",
  VAULT_DECRYPT_FAILED: "凭据解密失败：请确认主密码正确，或重新录入该凭据。",
  VAULT_CORRUPT: "保险库文件已损坏，请从备份恢复或重新初始化。",
  KEYCHAIN_UNAVAILABLE: "系统钥匙串不可用，请手动输入主密码解锁。",
  VALIDATION: "填写的信息不完整或格式有误，请检查后重试。",
  NOT_FOUND: "找不到对应的数据，可能已被删除。",
  PERMISSION: "没有执行该操作的权限。",
  CONFLICT: "数据存在冲突，请刷新后重试。",
  CANCELLED: "操作已取消。",
  INTERNAL: "客户端出现了未预期的问题，请重试；如果反复出现，请在「设置 → 关于」里导出日志反馈。",
  IO: "本地文件读写失败，请检查磁盘空间与文件权限。",
  SFTP_NO_SUCH_FILE: "远端文件不存在，可能已被移动或删除。",
  SFTP_PERMISSION: "远端目录没有权限，无法完成该文件操作。",
  SFTP_PROTOCOL: "远端 SFTP 服务响应异常，请重试或重新连接。",
  FORWARD_BIND: "本地端口已被占用，请换一个端口或关闭占用该端口的程序。",
  FORWARD_REMOTE_DENIED: "服务器拒绝了端口转发请求（可能被 sshd 的 AllowTcpForwarding 禁用）。",
  SERVER_UNREACHABLE: "连不上同步服务器，请检查服务器地址与网络。",
  SERVER_AUTH: "同步账号认证失败，请重新登录。",
  SYNC_CONFLICT: "同步数据存在冲突，请查看冲突详情后处理。",
  DEVICE_REVOKED: "当前设备已被撤销授权，请重新登录。",
  DEVICE_MISMATCH: "设备信息不匹配，请重新登录。",
  REGISTRATION_CLOSED: "该同步服务器已关闭注册。",
  UNSUPPORTED: "当前版本或该环境下暂不支持这个功能。",
  QUOTA_EXCEEDED: "用量已超出限额，请清理后重试。",
  RATE_LIMITED: "操作太频繁了，请稍等一会儿再试。",
  UPDATE_SIGNATURE: "更新包签名校验未通过，已阻止安装。请从官网重新下载安装包。",
  UPDATE_DOWNLOAD: "更新包下载失败，请检查网络后重试。",
};

/**
 * 技术错误文本 → 用户话术。
 *
 * 顺序敏感：更具体的规则放前面（例如 publickey 认证失败要先于通用 permission denied）。
 */
const PATTERN_RULES: { re: RegExp; title: string; hint?: string }[] = [
  {
    re: /host key verification failed|hostkey.*(mismatch|changed)|remote host identification has changed/i,
    title: "服务器主机指纹校验未通过",
    hint: "为安全起见已阻止连接。若确认服务器重装过系统，可在会话设置的「高级」里调整主机密钥校验策略。",
  },
  {
    re: /permission denied \(publickey|no supported authentication methods|authentication failed|auth fail/i,
    title: "登录认证失败",
    hint: "请核对用户名、密码或私钥；私钥带口令时需要填写正确的 Passphrase，并确认公钥已加入服务器 ~/.ssh/authorized_keys。",
  },
  {
    re: /no matching (key exchange|host key type|cipher|mac|kex)|kex_exchange_identification/i,
    title: "加密算法不匹配",
    hint: "服务器 sshd 与客户端没有共同支持的算法，请让管理员放开 ed25519 / ssh-rsa / aes 等常用算法。",
  },
  {
    re: /too many authentication failures/i,
    title: "认证尝试次数过多",
    hint: "服务器已暂时拒绝该来源 IP，请稍等几分钟后重试。",
  },
  {
    re: /connection refused|os error 10061|actively refused/i,
    title: "服务器拒绝连接",
    hint: "目标端口没有服务在监听：请确认 SSH 服务已启动、端口填对了，并且防火墙/安全组已放行。",
  },
  {
    re: /timed? ?out|timeout|os error 10060/i,
    title: "连接超时",
    hint: "服务器没有响应：请检查 IP/端口是否正确、网络是否可达，以及防火墙是否拦截。",
  },
  {
    re: /no route to host|network is unreachable|os error 10065|os error 10051/i,
    title: "网络不可达",
    hint: "本机到服务器之间不通，请检查网段、路由、VPN 或跳板机设置。",
  },
  {
    re: /name or service not known|nodename nor servname|temporary failure in name resolution|os error 11001|dns/i,
    title: "域名解析失败",
    hint: "找不到这个主机名：请检查服务器地址是否拼写正确，或改用 IP 地址。",
  },
  {
    re: /permission denied/i,
    title: "权限不足",
    hint: "当前账号没有执行该操作的权限（远端文件权限或本地文件权限）。",
  },
  {
    re: /no space left|disk full|os error 112/i,
    title: "磁盘空间不足",
    hint: "请清理空间后重试（本地或远端任一侧都可能满了）。",
  },
  {
    re: /administratively prohibited|channel.*(open|failure)|open failed/i,
    title: "服务器拒绝打开新的通道",
    hint: "可能是并发会话数达到上限，或该功能被服务器策略禁用，请关闭部分会话后重试。",
  },
  {
    re: /connection reset|broken pipe|connection closed|unexpected eof|eof$/i,
    title: "连接被中断",
    hint: "服务器或中间网络主动断开了连接，请重试；频繁出现时请检查网络稳定性与服务器负载。",
  },
  {
    re: /key is encrypted|encrypted private key|enter passphrase|decrypt.*key/i,
    title: "私钥已加密，需要口令",
    hint: "请在私钥列表里为该私钥设置 Passphrase 后重试。",
  },
  {
    re: /could not read key|failed to decode private key|invalid (pem|private key)/i,
    title: "私钥格式无法识别",
    hint: "请选择以 -----BEGIN 开头的 OpenSSH 或 PEM 格式私钥文件（不要选公钥 .pub）。",
  },
  {
    re: /unique constraint failed|already exists/i,
    title: "该条目已经存在",
    hint: "列表里已有同名或同指纹的记录，已为你定位到原来的条目。",
  },
];

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
  "kind(",
  "errno",
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

/** 去掉错误文本里的开发期痕迹：错误码前缀、os error 编号、路径堆栈等。 */
function sanitizeUserText(raw: string): string {
  return raw
    .replace(/\(os error \d+\)/gi, "")
    .replace(/os error \d+/gi, "")
    .replace(/\b[A-Z][A-Z0-9_]{3,}\b:\s*/g, "") // HOST_UNREACHABLE: xxx
    .replace(/\bcaused by:.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 把任意错误解析成面向用户的 { title, hint }。
 * title 用于抬头（一行结论），hint 用于补充怎么处理。
 */
export function describeError(err: unknown): FriendlyError {
  const { code, message } = parseIpcError(err);
  const raw = (message || "").trim();

  if (raw) {
    for (const rule of PATTERN_RULES) {
      if (rule.re.test(raw)) {
        return { title: rule.title, hint: rule.hint };
      }
    }

    const cleaned = sanitizeUserText(raw);
    const hasChinese = /[\u4e00-\u9fa5]/.test(cleaned);
    // 后端已经写好的中文提示直接透出，但同样清洗技术碎片
    if (hasChinese) {
      return { title: cleaned.slice(0, 300) };
    }
    if (cleaned && !looksTechnical(cleaned)) {
      return { title: cleaned.slice(0, 300) };
    }
  }

  if (code && CODE_MESSAGES[code]) {
    return { title: CODE_MESSAGES[code] };
  }

  return { title: CODE_MESSAGES.INTERNAL };
}

/** 生成面向用户的一句话中文错误文案（永不返回原始技术堆栈）。 */
export function formatFriendlyError(err: unknown): string {
  const { title, hint } = describeError(err);
  return hint ? `${title}${/[。！？]$/.test(title) ? "" : "。"}${hint}` : title;
}

/** 原始错误文本，仅用于「查看详情 / 复制反馈」，不要直接展示给用户。 */
export function formatErrorDetail(err: unknown): string {
  if (err instanceof Error) {
    return [err.message, err.stack].filter(Boolean).join("\n");
  }
  const { code, message, details, correlation_id } = parseIpcError(err);
  const parts: string[] = [];
  if (code) parts.push(`错误码: ${code}`);
  if (message) parts.push(message);
  if (details !== undefined && details !== null) {
    try {
      parts.push(typeof details === "string" ? details : JSON.stringify(details, null, 2));
    } catch {
      parts.push(String(details));
    }
  }
  if (correlation_id) parts.push(`correlation_id: ${correlation_id}`);
  if (parts.length === 0) parts.push(String(err));
  return parts.join("\n");
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
