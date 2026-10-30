import { useEffect, useRef } from "react";

const openDialogs: HTMLElement[] = [];

/** Keep keyboard focus inside the top dialog and return it to its trigger. */
export function useDialogBehavior(open: boolean, onClose: () => void, panelRef: React.RefObject<HTMLElement>) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    openDialogs.push(panel);
    const isTop = () => openDialogs[openDialogs.length - 1] === panel;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]',
    )).filter((element) => {
      const closedDetails = element.closest('details:not([open])');
      return element.getClientRects().length > 0 &&
        (!closedDetails || element === closedDetails.querySelector("summary")) &&
        !element.closest('[inert], [hidden], [aria-hidden="true"]');
    });
    const focusPanel = () => (focusable()[0] ?? panel).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0] ?? panel;
        const last = elements[elements.length - 1] ?? panel;
        if (!panel.contains(document.activeElement) || document.activeElement === panel ||
            (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (isTop() && !panel.contains(event.target as Node)) focusPanel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocus);
    const timer = window.setTimeout(() => {
      if (isTop() && !panel.contains(document.activeElement)) focusPanel();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocus);
      const index = openDialogs.lastIndexOf(panel);
      if (index >= 0) openDialogs.splice(index, 1);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, panelRef]);
}
