import { create } from "zustand";

export type ToastLevel = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: string;
  level: ToastLevel;
  title: string;
  /** 详细信息（错误堆栈、后端 correlation_id 等），可展开与复制 */
  detail?: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** 同时最多显示的条数，超出后淘汰最旧的 */
const MAX_TOASTS = 4;
/** 相同内容在该时间窗内不重复弹出（例如重连循环里的同一条错误） */
const DEDUPE_WINDOW_MS = 3000;

const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recentKeys = new Map<string, number>();

function toastKey(t: Omit<ToastItem, "id">) {
  return `${t.level}|${t.title}|${t.detail ?? ""}`;
}

let seq = 0;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (toast) => {
    const key = toastKey(toast);
    const now = Date.now();
    const last = recentKeys.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) {
      return "deduped";
    }
    recentKeys.set(key, now);

    const id = `toast_${now}_${seq++}`;
    set((state) => {
      const next = [...state.toasts, { ...toast, id }];
      // 淘汰最旧的（同时清掉它的自动关闭定时器）
      while (next.length > MAX_TOASTS) {
        const removed = next.shift();
        if (removed) {
          const timer = dismissTimers.get(removed.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            dismissTimers.delete(removed.id);
          }
        }
      }
      return { toasts: next };
    });

    // 错误保留更久，方便用户复制详情
    const ttl = toast.level === "error" || toast.level === "warning" ? 10_000 : 5_000;
    dismissTimers.set(
      id,
      setTimeout(() => get().dismiss(id), ttl)
    );
    return id;
  },

  dismiss: (id) => {
    const timer = dismissTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      dismissTimers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  clear: () => {
    for (const timer of dismissTimers.values()) clearTimeout(timer);
    dismissTimers.clear();
    set({ toasts: [] });
  },
}));

/** 便捷入口：代码里直接 `toast.error("...")` 即可 */
export const toast = {
  info: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: "info", title, detail }),
  success: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: "success", title, detail }),
  warning: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: "warning", title, detail }),
  error: (title: string, detail?: string) =>
    useToastStore.getState().push({ level: "error", title, detail }),
};
