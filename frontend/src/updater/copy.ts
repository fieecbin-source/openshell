/**
 * 更新模块的全部中文文案。
 *
 * 约定：`src/updater/**` 中除了本文件，不允许出现中文字面量
 * （由 `scripts/check-updater-copy.mjs` 在 CI 里强制），避免文案散落各处。
 */
import { formatFriendlyError, parseIpcError } from "../lib/errors";

export const UPDATE_COPY = {
  badge: {
    title: "检查更新",
    ariaLabel: "检查更新",
    newVersion: "有新版本可用",
    mandatory: "需要立即更新",
  },
  modal: {
    title: "软件更新",
    subtitle: "从 GitHub 获取 OpenShell 的最新正式版本",
    close: "关闭",
    minimize: "后台继续下载",
    dismiss: "稍后再说",
    publishedAt: "发布于",
    packageSize: "安装包",
    fromCache: "缓存结果",
    source: "来源",
    mandatoryTitle: "此版本必须升级",
    mandatoryBody: "升级前会自动备份您的连接数据，安装完成后重新打开即可继续使用。",
    releaseNotesFallback: "本次发布没有提供更新说明。",
    manualDownloadHint: "该版本没有提供可自动安装的安装包，请前往 Release 页面手动下载。",
    unsupportedPlatformHint: "尚未发布适配当前系统的安装包。",
    skippedHint: "你已跳过此版本，手动检查才会再次提示。",
  },
  actions: {
    check: "检查更新",
    checking: "正在检查…",
    updateNow: "立即更新",
    download: "下载安装包",
    cancel: "取消下载",
    retry: "重试",
    later: "稍后提醒",
    skip: "跳过此版本",
    installNow: "立即重启安装",
    downloadManually: "手动下载",
    openRelease: "打开 Release 页面",
    openLogs: "打开日志目录",
    backupNow: "立即备份数据",
    openBackups: "打开备份目录",
    openDownloads: "打开下载目录",
  },
  /** 平台差异说明：能自动安装的走自动，需要用户动手的必须说清楚。 */
  platform: {
    manualTitle: "还需要你完成最后一步",
    portable:
      "便携版不支持自动安装：新版已下载，请退出后手动替换程序文件（连接数据目录不会被覆盖）。",
    macosManual: "已打开安装镜像，请把 OpenShell 拖入「应用程序」，然后重新启动客户端。",
    linuxPermission:
      "安装需要管理员权限。若系统没有弹出授权窗口，请在终端执行 sudo dpkg -i 该安装包。",
    openFolderHint: "找不到安装包时，可以打开下载目录手动运行。",
  },
  phase: {
    idle: "尚未检查更新",
    checking: "正在检查新版本…",
    latest: "当前已是最新版本",
    available: "发现新版本",
    checkFailed: "检查更新失败",
    downloading: "正在下载安装包",
    verifying: "正在校验安装包完整性",
    ready: "安装包已就绪",
    downloadFailed: "下载中断",
    verifyFailed: "安装包校验失败",
    installFailed: "安装未能启动",
    installed: "正在启动安装程序…",
  },
  progress: {
    downloaded: "已下载",
    of: "/",
    speed: "速度",
    remaining: "剩余",
    resuming: "正在续传",
    cancelHint: "取消后已下载的部分会保留，下次可以继续。",
    verifyingHint: "正在逐字节比对发布方提供的 sha256，校验通过后才会执行安装。",
  },
  about: {
    tab: "关于与更新",
    versionTitle: "当前版本",
    platformLabel: "运行平台",
    dataDirLabel: "数据目录",
    dataDirHint: "点击打开目录",
    checkSection: "更新检查",
    lastCheckNever: "还没有检查过更新",
    lastCheckPrefix: "上次检查：",
    latestLabel: "已是最新",
    failedLabel: "上次检查失败",
    updateAvailableLabel: "发现新版本",
    autoCheck: "自动检查更新",
    autoCheckHint: "开启后会在启动 30 秒后自动检查，并按下面的间隔重复。",
    interval: "检查间隔",
    channel: "更新通道",
    channelStable: "稳定版",
    channelBeta: "测试版",
    channelStableHint: "只接收正式发布版本，适合日常使用。",
    channelBetaHint: "优先接收预发布版本，可能包含未完成的功能。",
    fallbackSource: "备用检测源",
    fallbackSourceHint: "填写 latest.json 的 https 地址，GitHub 无法访问时自动回退；留空则关闭。",
    mirror: "下载镜像",
    mirrorHint: "填写镜像前缀（https 开头），例如公司内网缓存；留空则直连 GitHub。",
    diagnostics: "诊断与备份",
    backupsHint: "自动快照只保留最近若干份，手动备份与导出的 .osvault 永不自动删除。",
    skipped: "已跳过",
    none: "无",
    saveFailed: "配置未能保存，请检查磁盘权限后重试。",
    checkingNow: "正在检查…",
    intervalHours: "小时",
  },
  recovery: {
    title: "数据已从备份恢复",
    body: "上次启动时的升级未能完成，OpenShell 已自动回滚到升级前的数据快照。请确认数据无误后再继续操作。",
    path: "快照位置：",
  },
  errors: {
    generic: "更新过程中出现了未预期的问题，请稍后重试。",
    cancelled: "已取消本次更新。",
  },
  units: {
    perSecond: "/s",
    hour: "小时",
    minute: "分钟",
    second: "秒",
    megabyte: "MB",
    kilobyte: "KB",
    byte: "B",
  },
} as const;

/** 更新相关的错误码 → 面向用户的说明（补充 `lib/errors.ts` 的通用映射）。 */
export const UPDATE_ERROR_COPY: Record<string, string> = {
  UPDATE_CHECK_FAILED: "暂时连不上更新服务器，请检查网络或代理设置后重试。",
  UPDATE_ASSET_NOT_FOUND: "这个版本还没有发布适配当前系统的安装包，可打开 Release 页面手动下载。",
  UPDATE_CHECKSUM_MISMATCH: "安装包内容校验未通过，可能下载损坏或被篡改，已删除临时文件。",
  UPDATE_CHECKSUM_MISSING: "该版本没有提供可用的安装包校验值，为保证安全已禁用自动安装，请手动下载。",
  UPDATE_INSUFFICIENT_DISK: "磁盘剩余空间不足，请清理后重试（下载与解压约需安装包体积的 1.2 倍）。",
  UPDATE_INSTALL_FAILED: "安装程序没能启动，可以重试；若仍失败，请在「打开 Release 页面」里手动安装。",
  UPDATE_DOWNLOAD: "安装包下载失败，请检查网络后重试（已下载的部分会保留续传）。",
  UPDATE_SIGNATURE: "安装包签名校验未通过，已阻止安装，请从官方渠道重新下载。",
  SCHEMA_NEWER_THAN_APP: "本地数据由更高版本的 OpenShell 写入，当前版本不会覆盖它，请升级客户端。",
  RATE_LIMITED: "请求过于频繁，更新源已临时限流，请稍后再试。",
  CANCELLED: "操作已取消。",
};

/**
 * 把任意错误统一翻译成一句用户能看懂的中文说明。
 *
 * 优先用更新模块自己的错误码表；否则退回 `lib/errors.ts` 的通用解析，
 * 两者都没有可用信息时用更新场景的兜底文案（比「客户端出现未知问题」更贴合语境）。
 */
export function describeUpdateError(error: unknown, fallback?: string): string {
  const { code, message } = parseIpcError(error);
  if (code && UPDATE_ERROR_COPY[code]) {
    return UPDATE_ERROR_COPY[code];
  }
  const text = (message ?? "").trim();
  if (!text) {
    return fallback ?? UPDATE_COPY.errors.generic;
  }
  const friendly = formatFriendlyError(error);
  return friendly || fallback || UPDATE_COPY.errors.generic;
}

/** 字节数 → 人类可读体积。 */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return `0 ${UPDATE_COPY.units.byte}`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1)} ${UPDATE_COPY.units.megabyte}`;
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} ${UPDATE_COPY.units.kilobyte}`;
  return `${Math.round(bytes)} ${UPDATE_COPY.units.byte}`;
}

/** 下载速度（字节/秒）→ 人类可读。 */
export function formatSpeed(bytesPerSec: number | undefined): string {
  if (!bytesPerSec || bytesPerSec <= 0) return `0 ${UPDATE_COPY.units.byte}${UPDATE_COPY.units.perSecond}`;
  return `${formatBytes(bytesPerSec)}${UPDATE_COPY.units.perSecond}`;
}

/** 剩余时间估算；未知时返回空字符串（调用方自行决定不渲染）。 */
export function formatRemaining(
  received: number,
  total: number | undefined,
  bytesPerSec: number | undefined
): string {
  if (!total || total <= received || !bytesPerSec || bytesPerSec <= 0) return "";
  const seconds = Math.max(1, Math.round((total - received) / bytesPerSec));
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)} ${UPDATE_COPY.units.hour} ${Math.round((seconds % 3600) / 60)} ${UPDATE_COPY.units.minute}`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)} ${UPDATE_COPY.units.minute} ${seconds % 60} ${UPDATE_COPY.units.second}`;
  }
  return `${seconds} ${UPDATE_COPY.units.second}`;
}

/** ISO / 毫秒时间戳 → 本地日期（只到分钟）。 */
export function formatMoment(iso: string | number | undefined | null): string {
  if (iso === undefined || iso === null || iso === "") return "";
  const date = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
