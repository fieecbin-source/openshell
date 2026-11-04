import type { Protocol } from "../../types/ipc";
import { DEFAULT_HOST_ICON_KEY, normalizeHostIconKey, HOST_ICONS } from "../../lib/hostIcons";
import { PlugIcon, ServerIcon } from "./icons";
import { cn } from "./cn";

export function HostIcon({ iconKey, protocol, className, title }: {
  iconKey?: string | null;
  protocol?: Protocol;
  className?: string;
  title?: string;
}) {
  const key = normalizeHostIconKey(iconKey);
  const system = HOST_ICONS.find((item) => item.key === key);
  // 串口会话在未显式选择图标时仍使用串口图形，而不是默认的 Linux 图标
  const serial = protocol === "serial" && (!iconKey || iconKey === "server" || iconKey === "none");
  const name = title || (serial ? "串口设备" : system?.label || "默认");
  return <span
    className={cn("flex shrink-0 items-center justify-center overflow-hidden", className)}
    title={name}
    data-icon-key={serial ? "serial" : key}
  >
    {serial
      ? <span role="img" aria-label="串口设备" className="flex h-full w-full items-center justify-center text-accent">
        <PlugIcon className="h-full w-full" />
      </span>
      : system?.src
        ? <img
          src={system.src}
          alt={system.label}
          draggable={false}
          className={cn("h-full w-full object-contain",
            // 彩色 Tux 深色下主体偏黑：只补一层极轻的白色描边，不额外加底板
            system.key === DEFAULT_HOST_ICON_KEY && "dark:drop-shadow-[0_0_1px_rgba(255,255,255,0.45)]",
            system.tone === "black" && "dark:invert",
            system.tone === "white" && "invert dark:invert-0")}
        />
        : <span role="img" aria-label="默认主机" className="flex h-full w-full items-center justify-center text-accent">
          <ServerIcon className="h-full w-full" />
        </span>}
  </span>;
}
