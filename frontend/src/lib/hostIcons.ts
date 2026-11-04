import type { Protocol } from "../types/ipc";

export type HostIconGroup = "device" | "os" | "default";

export interface HostIconDef {
  key: string;
  label: string;
  group: HostIconGroup;
  src: string | null;
  /** 搜索用别名，中英文均可 */
  keywords: string[];
  /** 单色图标在深浅主题下的可见性适配 */
  tone?: "black" | "white";
}

const device = (id: string, label: string, keywords: string[]): HostIconDef => ({
  key: `device:${id}`,
  label,
  group: "device",
  src: `/icons/devices/${id}.svg`,
  keywords,
});

const os = (id: string, label: string, keywords: string[], tone?: "black" | "white"): HostIconDef => ({
  key: `os:${id}`,
  label,
  group: "os",
  src: `/os/${id}.svg`,
  keywords,
  tone,
});

/** 设备类型图标：来自用户提供的 64×64 彩色 SVG 集 */
export const DEVICE_ICONS: HostIconDef[] = [
  device("server", "服务器", ["server", "主机", "linux", "bsd", "云主机"]),
  device("terminal", "终端", ["terminal", "unix", "命令行", "shell"]),
  device("desktop", "台式机", ["desktop", "pc", "windows", "台式"]),
  device("laptop", "笔记本", ["laptop", "notebook", "macbook", "笔记本"]),
  device("router", "路由器", ["router", "网关", "gateway", "路由"]),
  device("switch", "交换机", ["switch", "交换"]),
  device("firewall", "防火墙", ["firewall", "安全网关", "防火墙"]),
  device("access-point", "无线 AP", ["access point", "wifi", "wireless", "无线", "ap"]),
  device("nas", "NAS 存储", ["nas", "storage", "synology", "存储", "群晖"]),
  device("sbc", "开发板", ["sbc", "raspberry", "rpi", "树莓派", "开发板"]),
  device("phone", "手机", ["phone", "android", "termux", "手机"]),
  device("tablet", "平板", ["tablet", "ipad", "平板"]),
  device("vm", "虚拟机", ["vm", "virtual machine", "proxmox", "esxi", "虚拟机"]),
  device("container", "容器", ["container", "docker", "k8s", "kubernetes", "容器"]),
  device("cloud", "云服务", ["cloud", "aws", "azure", "gcp", "aliyun", "云服务"]),
  device("iot", "IoT 设备", ["iot", "esp32", "arduino", "嵌入式"]),
  device("camera", "摄像头", ["camera", "ipc", "摄像头"]),
  device("database", "数据库", ["database", "mysql", "postgres", "redis", "mongo", "数据库"]),
  device("bastion", "堡垒机", ["bastion", "jump host", "跳板机", "堡垒机"]),
  device("unknown", "未知设备", ["unknown", "其他", "未识别"]),
];

/** 系统/发行版图标：沿用官方 logo 资源 */
export const OS_ICONS: HostIconDef[] = [
  os("ubuntu", "Ubuntu", ["ubuntu"], "white"),
  os("debian", "Debian", ["debian"]),
  os("fedora", "Fedora", ["fedora"]),
  os("arch", "Arch Linux", ["arch", "archlinux"]),
  os("alpine", "Alpine", ["alpine"]),
  os("rocky", "Rocky Linux", ["rocky", "rockylinux"]),
  os("almalinux", "AlmaLinux", ["alma", "almalinux"]),
  os("centos", "CentOS", ["centos"]),
  os("macos", "macOS", ["macos", "mac", "苹果"], "black"),
];

export const HOST_ICONS: HostIconDef[] = [
  { key: "none", label: "不设置", group: "default", src: null, keywords: ["default", "none", "默认", "不设置"] },
  ...DEVICE_ICONS,
  ...OS_ICONS,
];

export const HOST_ICON_GROUPS: Record<HostIconGroup, string> = {
  default: "默认",
  device: "设备类型",
  os: "系统发行版",
};

export const DEFAULT_HOST_ICON_KEY = "none";

/** 旧数据里的 "server" / 已下架 key 统一回落到“不设置” */
export function normalizeHostIconKey(iconKey?: string | null): string {
  if (!iconKey || iconKey === "server") return DEFAULT_HOST_ICON_KEY;
  return HOST_ICONS.some((item) => item.key === iconKey) ? iconKey : DEFAULT_HOST_ICON_KEY;
}

export function hostIconLabel(iconKey?: string | null): string {
  return HOST_ICONS.find((item) => item.key === normalizeHostIconKey(iconKey))?.label || "不设置";
}

/** 按可读的系统/设备关键字做“自动识别”，识别不到时回落到通用服务器图标 */
const DETECT_RULES: Array<[RegExp, string]> = [
  [/(ubuntu|乌班图)/i, "os:ubuntu"],
  [/(debian|德比安)/i, "os:debian"],
  [/(fedora|红帽社区)/i, "os:fedora"],
  [/(archlinux|arch linux|arch\b)/i, "os:arch"],
  [/(alpine|阿尔派)/i, "os:alpine"],
  [/(rocky|rockylinux)/i, "os:rocky"],
  [/(almalinux|alma\b)/i, "os:almalinux"],
  [/(centos|cent os)/i, "os:centos"],
  [/(macos|mac os|macbook|imac|苹果电脑)/i, "os:macos"],
  [/(router|gateway|网关|路由)/i, "device:router"],
  [/(switch|交换机)/i, "device:switch"],
  [/(firewall|防火墙)/i, "device:firewall"],
  [/(access.?point|wireless|wifi|无线|热点)/i, "device:access-point"],
  [/(nas\b|synology|群晖|存储)/i, "device:nas"],
  [/(raspberry|rpi|\bpi\b|树莓派|开发板)/i, "device:sbc"],
  [/(android|termux|phone|手机)/i, "device:phone"],
  [/(ipad|tablet|平板)/i, "device:tablet"],
  [/(\bvm\b|virtual|proxmox|esxi|虚拟机)/i, "device:vm"],
  [/(docker|container|k8s|kubernetes|容器)/i, "device:container"],
  [/(cloud|aws\b|azure|gcp|aliyun|阿里云|腾讯云|云服务)/i, "device:cloud"],
  [/(iot|esp32|arduino|嵌入式)/i, "device:iot"],
  [/(camera|ipc|摄像)/i, "device:camera"],
  [/(database|mysql|postgres|redis|mongo|数据库)/i, "device:database"],
  [/(bastion|jump|跳板|堡垒)/i, "device:bastion"],
  [/(laptop|notebook|笔记本|便携)/i, "device:laptop"],
  [/(desktop|windows|台式|\bpc\b)/i, "device:desktop"],
  [/(terminal|命令行|shell)/i, "device:terminal"],
];

export function detectHostIcon(input: {
  name?: string | null;
  host?: string | null;
  username?: string | null;
  protocol?: Protocol;
}): string {
  if (input.protocol === "serial") return DEFAULT_HOST_ICON_KEY;
  const haystack = [input.name, input.host, input.username].filter(Boolean).join(" ");
  if (!haystack) return "device:server";
  const match = DETECT_RULES.find(([pattern]) => pattern.test(haystack));
  return match ? match[1] : "device:server";
}
