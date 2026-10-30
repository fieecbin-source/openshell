import { useId } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import type { ControlSize } from "./Button";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onChange, label, hint, disabled = false, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-os-sm text-ink">
          {label}
        </label>
        {hint !== undefined && <p className="mt-0.5 text-os-xs text-ink-tertiary">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-[20px] w-[34px] shrink-0 rounded-full transition-colors duration-os ease-os",
          "disabled:cursor-not-allowed disabled:opacity-40",
          checked ? "bg-accent" : "bg-line/20",
        )}
      >
        <span
          className={cn(
            "absolute top-[2px] h-4 w-4 rounded-full bg-white shadow-os-sm transition-[left] duration-os ease-os",
            checked ? "left-[16px]" : "left-[2px]",
          )}
        />
      </button>
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel?: string;
  size?: ControlSize;
  className?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "md",
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("inline-flex items-center gap-0.5 rounded-os-md bg-line/5 p-0.5", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-[7px] font-medium transition-colors duration-os ease-os",
              size === "sm" ? "h-[24px] px-2 text-os-2xs" : "h-[28px] px-2.5 text-os-xs",
              selected
                ? "bg-surface text-ink shadow-os-sm"
                : "text-ink-secondary hover:text-ink",
              option.disabled && "cursor-not-allowed opacity-40",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Checkbox({ checked, onChange, label, disabled = false, className }: CheckboxProps) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer select-none items-center gap-2 text-os-sm text-ink",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 rounded-[4px] border-line/25 accent-[rgb(var(--os-accent))]"
      />
      {label}
    </label>
  );
}

export interface RadioProps {
  checked: boolean;
  onChange: () => void;
  label: ReactNode;
  name: string;
  disabled?: boolean;
  className?: string;
}

export function Radio({ checked, onChange, label, name, disabled = false, className }: RadioProps) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer select-none items-center gap-2 text-os-sm text-ink",
        disabled && "cursor-not-allowed opacity-40",
        className,
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="h-3.5 w-3.5 accent-[rgb(var(--os-accent))]"
      />
      {label}
    </label>
  );
}
