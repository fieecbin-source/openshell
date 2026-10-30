import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ControlSize = "sm" | "md";

const BASE =
  "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-os-md font-medium " +
  "transition-[background-color,border-color,color,box-shadow,opacity] duration-os ease-os " +
  "disabled:pointer-events-none disabled:opacity-40";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white shadow-os-sm hover:bg-accent/90 active:bg-accent/80",
  secondary:
    "border border-line/10 bg-surface text-ink shadow-os-sm hover:bg-surface-muted active:bg-line/5",
  ghost: "text-ink-secondary hover:bg-line/5 hover:text-ink active:bg-line/10",
  danger: "bg-state-danger text-white shadow-os-sm hover:bg-state-danger/90 active:bg-state-danger/80",
};

const SIZES: Record<ControlSize, string> = {
  sm: "h-[30px] px-3 text-os-xs",
  md: "h-[34px] px-3.5 text-os-sm",
};

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("h-3.5 w-3.5 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    leading,
    trailing,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading ? <Spinner /> : leading}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：供屏幕阅读器与悬浮提示使用 */
  label: string;
  variant?: ButtonVariant;
  size?: ControlSize;
  loading?: boolean;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    variant = "ghost",
    size = "md",
    loading = false,
    active = false,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled || loading}
      className={cn(
        BASE,
        VARIANTS[variant],
        "px-0",
        size === "sm" ? "h-[26px] w-[26px]" : "h-[30px] w-[30px]",
        active && "bg-accent/10 text-accent hover:bg-accent/15",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : children}
    </button>
  );
});
