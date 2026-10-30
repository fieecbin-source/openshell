import { forwardRef } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn";

const CONTROL =
  "w-full rounded-os-md border bg-surface-muted px-2.5 text-os-sm text-ink " +
  "transition-[background-color,border-color,box-shadow] duration-os ease-os " +
  "placeholder:text-ink-tertiary focus:bg-surface focus:outline-none focus-visible:outline-none " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const CONTROL_OK =
  "border-line/10 hover:border-line/20 focus:border-accent/60 focus:ring-2 focus:ring-accent/20";
const CONTROL_BAD =
  "border-state-danger/50 focus:border-state-danger focus:ring-2 focus:ring-state-danger/15";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, required, htmlFor, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label !== undefined && (
        <label htmlFor={htmlFor} className="text-os-xs font-medium text-ink-secondary">
          {label}
          {required && <span className="ml-0.5 text-state-danger">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-os-xs text-state-danger">
          {error}
        </p>
      ) : (
        hint !== undefined && <p className="text-os-xs text-ink-tertiary">{hint}</p>
      )}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, mono, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        "h-[34px]",
        invalid ? CONTROL_BAD : CONTROL_OK,
        mono && "font-mono text-os-xs",
        className,
      )}
      {...rest}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          CONTROL,
          "h-[34px] cursor-pointer appearance-none pr-8",
          invalid ? CONTROL_BAD : CONTROL_OK,
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-tertiary"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        "resize-y py-2 leading-relaxed",
        invalid ? CONTROL_BAD : CONTROL_OK,
        className,
      )}
      {...rest}
    />
  );
});
