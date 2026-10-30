import { useEffect, useRef, useState } from "react";
import { cn } from "../../ui/cn";
import { useAiSettingsStore } from "../../../stores/aiSettingsStore";

export interface ProviderLogoProps {
  logoKey?: string | null;
  label: string;
  size?: "sm" | "md" | "lg";
  /** 首屏可见的推荐厂商直接预取，跳过 IntersectionObserver。 */
  eager?: boolean;
  className?: string;
}

const BOX: Record<NonNullable<ProviderLogoProps["size"]>, string> = {
  sm: "h-6 w-6 rounded-[6px]",
  md: "h-8 w-8 rounded-os-sm",
  lg: "h-10 w-10 rounded-os-sm",
};

const IMAGE: Record<NonNullable<ProviderLogoProps["size"]>, string> = {
  sm: "h-3.5 w-3.5",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

/**
 * 厂商 Logo：仅当进入视口后才请求 `ai_logo_get`，无图时回退为首字母徽标。
 * 推荐厂商由调用方传 `eager`，首屏一次性预取。
 */
export function ProviderLogo({
  logoKey,
  label,
  size = "md",
  eager = false,
  className,
}: ProviderLogoProps) {
  const [visible, setVisible] = useState(eager);
  const ref = useRef<HTMLSpanElement>(null);
  const logo = useAiSettingsStore((s) => (logoKey ? s.logos[logoKey] : undefined));
  const loadLogo = useAiSettingsStore((s) => s.loadLogo);

  useEffect(() => {
    if (!logoKey || visible) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "64px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [logoKey, visible]);

  useEffect(() => {
    if (visible && logoKey && !logo) void loadLogo(logoKey);
  }, [visible, logoKey, logo, loadLogo]);

  const initials = (label || "AI").trim().slice(0, 2).toUpperCase();

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden border border-line/10 bg-surface-muted text-ink-tertiary",
        BOX[size],
        className,
      )}
    >
      {logo && visible ? (
        <img src={logo} alt="" className={cn("object-contain", IMAGE[size])} />
      ) : (
        <span className="text-os-2xs font-semibold leading-none">{initials}</span>
      )}
    </span>
  );
}
