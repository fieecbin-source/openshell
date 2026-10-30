import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_BADGE: Record<Tone, string> = {
  neutral: "bg-line/5 text-ink-secondary",
  accent: "bg-accent/10 text-accent",
  success: "bg-state-success/10 text-state-success",
  warning: "bg-state-warning/10 text-state-warning",
  danger: "bg-state-danger/10 text-state-danger",
};

export interface BadgeProps {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "neutral", className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] items-center rounded-full px-1.5 text-os-2xs font-medium leading-none",
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface PanelProps {
  className?: string;
  padded?: boolean;
  children: ReactNode;
}

/** 基础表面：发丝线 + 超低阴影，不做胶囊化大圆角。 */
export function Panel({ className, padded = true, children }: PanelProps) {
  return (
    <div
      className={cn(
        "rounded-os-lg border border-line/10 bg-surface shadow-os-sm",
        padded && "p-4",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface CardProps {
  className?: string;
  selected?: boolean;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
}

/** 可点击卡片：用于主机、厂商、主题等选择项。 */
export function Card({ className, selected = false, onClick, title, children }: CardProps) {
  const interactive = typeof onClick === "function";
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={cn(
        "rounded-os-lg border bg-surface transition-[border-color,box-shadow,background-color] duration-os ease-os",
        selected
          ? "border-accent/60 shadow-os-md"
          : "border-line/10 shadow-os-sm",
        interactive && "cursor-pointer hover:border-line/20 hover:shadow-os-md",
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface SectionHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function SectionHeader({ title, description, actions, className }: SectionHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h3 className="truncate text-os-md font-semibold tracking-[-0.01em] text-ink">{title}</h3>
        {description !== undefined && (
          <p className="mt-0.5 text-os-xs text-ink-tertiary">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      {icon !== undefined && <div className="mb-3 text-ink-tertiary">{icon}</div>}
      <p className="text-os-sm font-medium text-ink">{title}</p>
      {description !== undefined && (
        <p className="mt-1 max-w-[320px] text-os-xs leading-relaxed text-ink-tertiary">
          {description}
        </p>
      )}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}
