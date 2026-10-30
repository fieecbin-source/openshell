import type { ReactNode } from "react";
import { cn } from "./cn";
import { IconButton } from "./Button";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "./icons";
import type { Tone } from "./Surface";

const TONE_STYLE: Record<Tone, { wrap: string; icon: string; Icon: typeof InfoIcon }> = {
  neutral: { wrap: "border-line/10 bg-surface-muted", icon: "text-ink-tertiary", Icon: InfoIcon },
  accent: { wrap: "border-accent/25 bg-accent/5", icon: "text-accent", Icon: InfoIcon },
  success: {
    wrap: "border-state-success/25 bg-state-success/5",
    icon: "text-state-success",
    Icon: CircleCheckIcon,
  },
  warning: {
    wrap: "border-state-warning/30 bg-state-warning/5",
    icon: "text-state-warning",
    Icon: TriangleAlertIcon,
  },
  danger: {
    wrap: "border-state-danger/30 bg-state-danger/5",
    icon: "text-state-danger",
    Icon: CircleAlertIcon,
  },
};

export interface InlineNoticeProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}

export function InlineNotice({
  tone = "neutral",
  title,
  children,
  action,
  onDismiss,
  className,
}: InlineNoticeProps) {
  const style = TONE_STYLE[tone];
  const Icon = style.Icon;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-os-md border px-3 py-2.5", style.wrap, className)}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style.icon)} />
      <div className="min-w-0 flex-1">
        {title !== undefined && <p className="text-os-xs font-medium text-ink">{title}</p>}
        {children !== undefined && (
          <div className={cn("text-os-xs leading-relaxed text-ink-secondary", title !== undefined && "mt-0.5")}>
            {children}
          </div>
        )}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
      {onDismiss !== undefined && (
        <IconButton label="关闭提示" size="sm" className="-mr-1 -mt-1" onClick={onDismiss}>
          <XIcon className="h-3.5 w-3.5" />
        </IconButton>
      )}
    </div>
  );
}

export interface ToastItem {
  id: string;
  tone?: Tone;
  message: string;
}

export interface ToastRegionProps {
  items: ToastItem[];
  onDismiss: (id: string) => void;
}

/** 浮层堆栈的最上层提示，位置固定在右下角。 */
export function ToastRegion({ items, onDismiss }: ToastRegionProps) {
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[320px] flex-col gap-2">
      {items.map((item) => {
        const style = TONE_STYLE[item.tone ?? "neutral"];
        const Icon = style.Icon;
        return (
          <div
            key={item.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2 rounded-os-md border bg-surface px-3 py-2.5 shadow-os-lg",
              "animate-[fade-in_220ms_var(--os-ease)]",
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", style.icon)} />
            <p className="min-w-0 flex-1 text-os-xs leading-relaxed text-ink">{item.message}</p>
            <IconButton label="关闭提示" size="sm" className="-mr-1 -mt-1" onClick={() => onDismiss(item.id)}>
              <XIcon className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}
