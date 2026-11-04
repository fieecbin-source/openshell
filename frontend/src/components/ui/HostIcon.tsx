import type { Protocol } from "../../types/ipc";
import { normalizeHostIconKey, HOST_ICONS } from "../../lib/hostIcons";
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
  const serial = protocol === "serial" && !system?.src;
  const name = title || system?.label || "不设置";
  return <span
    className={cn("flex shrink-0 items-center justify-center overflow-hidden", className)}
    title={name}
    data-icon-key={key}
  >
    {system?.src
      ? <img
        src={system.src}
        alt={system.label}
        draggable={false}
        className={cn("h-full w-full object-contain",
          system.tone === "black" && "dark:invert",
          system.tone === "white" && "invert dark:invert-0")}
      />
      : <span role="img" aria-label={serial ? "串口设备" : "默认主机"} className="flex h-full w-full items-center justify-center text-accent">
        {serial ? <PlugIcon className="h-full w-full" /> : <ServerIcon className="h-full w-full" />}
      </span>}
  </span>;
}
