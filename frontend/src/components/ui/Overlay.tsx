import { GlassMaterial } from "./GlassMaterial";
import { useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "./cn";
import { Button, IconButton } from "./Button";
import { XIcon } from "./icons";
import { useDialogBehavior } from "../../lib/useDialogBehavior";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  children?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  widthClassName = "w-full max-w-[520px]",
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(open, onClose, panelRef);
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/65 p-6 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "glass-host relative flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-os-xl border border-line/10 liquid-glass-panel shadow-os-lg outline-none",
          widthClassName,
        )}
      >
        <GlassMaterial />
        <div className="flex items-start justify-between gap-4 border-b border-line/10 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-os-md font-semibold tracking-[-0.01em] text-ink">{title}</h2>
            {description !== undefined && (
              <p className="mt-0.5 text-os-xs leading-relaxed text-ink-tertiary">{description}</p>
            )}
          </div>
          <IconButton label="关闭" size="sm" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
        {children !== undefined && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>}
        {footer !== undefined && (
          <div className="flex items-center justify-end gap-2 border-t border-line/10 bg-surface-muted px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  tone = "default",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      widthClassName="w-full max-w-[420px]"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelText}
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmText}
          </Button>
        </>
      }
    >
      {message !== undefined && <div className="text-os-sm leading-relaxed text-ink-secondary">{message}</div>}
    </Modal>
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  side?: "right" | "left";
  widthClassName?: string;
  children?: ReactNode;
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  footer,
  side = "right",
  widthClassName = "w-[380px]",
  children,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(open, onClose, panelRef);
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex bg-scrim/65 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{ justifyContent: side === "right" ? "flex-end" : "flex-start" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "glass-host relative flex h-full max-w-[92vw] flex-col border-line/10 liquid-glass-panel shadow-os-lg outline-none",
          side === "right" ? "border-l" : "border-r",
          widthClassName,
        )}
      >
        <GlassMaterial />
        <div className="flex items-start justify-between gap-4 border-b border-line/10 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-os-sm font-semibold text-ink">{title}</h2>
            {description !== undefined && (
              <p className="mt-0.5 text-os-2xs text-ink-tertiary">{description}</p>
            )}
          </div>
          <IconButton label="关闭" size="sm" onClick={onClose}>
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
        {children !== undefined && <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>}
        {footer !== undefined && (
          <div className="flex items-center justify-end gap-2 border-t border-line/10 bg-surface-muted px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
