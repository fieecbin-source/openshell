import { useCallback, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { gsap } from "gsap";
import type { Protocol } from "../types/ipc";
import { useDialogBehavior } from "../lib/useDialogBehavior";
import { IconButton } from "./ui/Button";
import { GlassMaterial } from "./ui/GlassMaterial";
import { XIcon } from "./ui/icons";

const CONNECTION_TYPES: Array<{ icon: string; label: string; protocol: Protocol }> = [
  { icon: "🖥️", label: "SSH 主机连接", protocol: "ssh" },
  { icon: "🪟", label: "Windows 远程桌面 (RDP)", protocol: "rdp" },
  { icon: "🔌", label: "串口 (Serial) 通信", protocol: "serial" },
  { icon: "🌐", label: "Telnet 连接", protocol: "telnet" },
  { icon: "💻", label: "本地终端 (Local Shell)", protocol: "local_shell" },
];

interface ConnectionTypeModalProps {
  source: HTMLElement;
  onClose: () => void;
  onSelect: (protocol: Protocol) => void;
}

export function ConnectionTypeModal({ source, onClose, onSelect }: ConnectionTypeModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const closingRef = useRef(false);
  const selectedRef = useRef<Protocol | null>(null);
  const callbacksRef = useRef({ onClose, onSelect });
  callbacksRef.current = { onClose, onSelect };

  const finishClose = useCallback(() => {
    if (selectedRef.current) callbacksRef.current.onSelect(selectedRef.current);
    else callbacksRef.current.onClose();
  }, []);

  const close = (protocol: Protocol | null = null) => {
    if (closingRef.current) return;
    closingRef.current = true;
    selectedRef.current = protocol;
    const timeline = timelineRef.current;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !timeline || timeline.progress() === 0) {
      finishClose();
    } else {
      timeline.reverse();
    }
  };

  useDialogBehavior(true, () => close(), panelRef);

  useLayoutEffect(() => {
    const panel = panelRef.current!;
    const overlay = overlayRef.current!;
    const options = panel.querySelectorAll<HTMLButtonElement>("[data-connection-option]");
    const media = gsap.matchMedia();
    media.add({
      reduced: "(prefers-reduced-motion: reduce)",
      motion: "(prefers-reduced-motion: no-preference)",
    }, (context) => {
      if (closingRef.current) { finishClose(); return; }
      if (context.conditions?.reduced) {
        gsap.set(source, { autoAlpha: 0 });
        return;
      }
      const origin = source.getBoundingClientRect();
      const target = panel.getBoundingClientRect();
      timelineRef.current = gsap.timeline({
        onComplete: () => options[0]?.focus(),
        onReverseComplete: () => { if (closingRef.current) finishClose(); },
      })
        .fromTo(overlay, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18 }, 0)
        .to(source, { autoAlpha: 0, scale: 0.97, y: -8, duration: 0.18, ease: "power2.in" }, 0)
        .fromTo(panel, {
          autoAlpha: 0, scale: 0.92,
          x: origin.left + origin.width / 2 - target.left - target.width / 2,
          y: origin.top + origin.height / 2 - target.top - target.height / 2,
        }, { autoAlpha: 1, x: 0, y: 0, scale: 1, duration: 0.32, ease: "power3.out" }, 0.14)
        .fromTo(options, { autoAlpha: 0, y: 12 }, {
          autoAlpha: 1, y: 0, duration: 0.22, stagger: 0.035, ease: "power2.out",
        }, 0.26);
    });
    return () => { media.revert(); timelineRef.current = null; };
  }, [source, finishClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[120] flex items-center justify-center bg-scrim/50 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="添加连接"
        tabIndex={-1}
        className="glass-host relative flex max-h-[calc(100dvh-32px)] w-full max-w-lg flex-col overflow-hidden rounded-os-xl border border-line/15 liquid-glass-panel shadow-os-lg outline-none"
      >
        <GlassMaterial />
        <div className="flex items-center justify-between border-b border-line/10 px-5 py-4">
          <h2 className="text-os-md font-semibold text-ink">添加连接</h2>
          <IconButton label="关闭" size="sm" onClick={() => close()}>
            <XIcon className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="min-h-0 space-y-2 overflow-y-auto p-4">
          {CONNECTION_TYPES.map((item) => (
            <button
              key={item.protocol}
              type="button"
              data-connection-option={item.protocol}
              onClick={() => close(item.protocol)}
              className="flex min-h-14 w-full items-center gap-3 rounded-os-lg border border-line/10 bg-surface/80 px-4 py-3 text-left text-os-sm font-medium text-ink transition-colors hover:border-accent/30 hover:bg-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-os-md bg-accent/10 text-lg">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
