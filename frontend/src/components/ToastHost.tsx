import React, { useState } from "react";
import { useToastStore, type ToastLevel } from "../stores/toastStore";

const LEVEL_STYLE: Record<
  ToastLevel,
  { bar: string; icon: string; iconBg: string; title: string; card: string }
> = {
  info: {
    bar: "bg-apple-blue",
    icon: "ℹ️",
    iconBg: "bg-blue-50 border-blue-200",
    title: "text-slate-900",
    card: "border-slate-300 bg-white",
  },
  success: {
    bar: "bg-apple-green",
    icon: "✅",
    iconBg: "bg-emerald-50 border-emerald-200",
    title: "text-emerald-900",
    card: "border-emerald-200 bg-emerald-50/60",
  },
  warning: {
    bar: "bg-amber-400",
    icon: "⚠️",
    iconBg: "bg-amber-50 border-amber-200",
    title: "text-amber-900",
    card: "border-amber-300 bg-amber-50",
  },
  error: {
    bar: "bg-red-500",
    icon: "⛔",
    iconBg: "bg-red-50 border-red-200",
    title: "text-red-900",
    card: "border-red-300 bg-red-50",
  },
};

/**
 * 全局浮层通知。
 *
 * 错误提示刻意做得比一般通知更醒目（红色描边 + 图标底色 + 13px 加粗标题），
 * 并支持展开原始错误详情与一键复制，方便用户自己看明白、也方便反馈日志。
 */
export const ToastHost: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex w-[400px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => {
        const style = LEVEL_STYLE[t.level];
        const isError = t.level === "error";
        // 错误默认展开：里面是「发生了什么 + 怎么办」，用户不需要多点一次
        const isOpen = expanded[t.id] ?? isError;
        return (
          <div
            key={t.id}
            className={`pointer-events-auto overflow-hidden rounded-xl border shadow-apple-xl backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2 duration-150 ${style.card}`}
            role={isError ? "alert" : "status"}
          >
            <div className={`h-1 w-full ${style.bar}`} />
            <div className="flex items-start gap-2.5 px-3.5 py-3">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${style.iconBg}`}
              >
                {style.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={`break-words ${isError ? "text-[13px]" : "text-xs"} font-semibold leading-relaxed ${style.title}`}
                >
                  {t.title}
                </p>
                {t.detail && (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => ({ ...prev, [t.id]: !prev[t.id] }))}
                      className="text-[11px] font-medium text-slate-600 underline decoration-dotted underline-offset-2 hover:text-slate-900"
                    >
                      {isOpen ? "收起" : "查看详情"}
                    </button>
                    {isOpen && (
                      <>
                        <div className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-black/5 bg-white p-2 text-[12px] leading-relaxed text-slate-700 select-text">
                          {t.detail}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard?.writeText(t.detail ?? "").catch(() => {});
                          }}
                          className="mt-1.5 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-apple-blue hover:bg-slate-50"
                        >
                          复制详情
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="rounded-md p-1 text-slate-500 transition hover:bg-black/5 hover:text-slate-800"
                title="关闭"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
