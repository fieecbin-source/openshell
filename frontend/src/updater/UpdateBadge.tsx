import React from "react";
import { UPDATE_COPY } from "./copy";
import { isMandatory, shouldShowBadge } from "./state";
import { useUpdaterStore } from "./store";

/**
 * 顶栏更新入口：位于设置齿轮左侧，与其它图标按钮同尺寸。
 *
 * * 默认灰色环形箭头图标；
 * * 有新版本时右上角出现 8px 红点（2s 呼吸），强制更新时变成红底白字 `!`；
 * * 点击直接打开更新弹窗（不做二次跳转）。
 */
export const UpdateBadge: React.FC = () => {
  const state = useUpdaterStore((s) => s.state);
  const setModalOpen = useUpdaterStore((s) => s.setModalOpen);

  const hasUpdate = shouldShowBadge(state);
  const mandatory = isMandatory(state);
  const busy = state.kind === "downloading" || state.kind === "verifying";

  const title = mandatory
    ? UPDATE_COPY.badge.mandatory
    : hasUpdate
      ? UPDATE_COPY.badge.newVersion
      : UPDATE_COPY.badge.title;

  return (
    <button
      onClick={() => setModalOpen(true)}
      title={title}
      aria-label={UPDATE_COPY.badge.ariaLabel}
      className={`relative p-1.5 rounded-xl border transition shadow-apple-sm active:scale-[0.98] ${
        hasUpdate
          ? "border-[#0071e3]/30 bg-[#0071e3]/[0.06] text-[#0071e3] hover:bg-[#0071e3]/[0.10]"
          : "border-slate-200/80 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"
      }`}
    >
      <svg
        className={`w-4 h-4 ${busy ? "animate-pulse" : ""}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
        />
      </svg>

      {mandatory ? (
        <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#ff3b30] text-[8px] font-bold leading-none text-white ring-2 ring-white">
          !
        </span>
      ) : hasUpdate ? (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse-dot rounded-full bg-[#ff3b30] ring-2 ring-white" />
      ) : null}
    </button>
  );
};
