import React from "react";
import { UPDATE_COPY } from "./copy";
import { isBusy, progressPercent, shouldShowBadge } from "./state";
import { useUpdaterStore } from "./store";

/** 顶栏更新胶囊：点击下载，进度中可打开详情，就绪后确认安装。 */
export const UpdateBadge: React.FC = () => {
  const state = useUpdaterStore((s) => s.state);
  const setModalOpen = useUpdaterStore((s) => s.setModalOpen);

  const download = useUpdaterStore((s) => s.download);
  const busy = isBusy(state);

  if (!shouldShowBadge(state) && !busy) return null;

  const ready = state.kind === "ready";
  const failed = state.kind === "download_failed" || state.kind === "verify_failed" || state.kind === "install_failed";
  const percent = Math.round(progressPercent(state));
  const knownProgress = state.kind === "downloading" && Boolean(state.progress.total);
  const label = state.kind === "verifying"
    ? UPDATE_COPY.badge.verifying
    : busy
      ? knownProgress ? `${percent}%` : UPDATE_COPY.badge.downloading
      : UPDATE_COPY.badge.update;
  const title = busy
    ? `${state.kind === "verifying" ? UPDATE_COPY.phase.verifying : UPDATE_COPY.phase.downloading} · ${label}`
    : ready ? UPDATE_COPY.badge.ready
      : failed ? UPDATE_COPY.badge.failed : UPDATE_COPY.badge.newVersion;

  return (
    <button
      type="button"
      onClick={() => {
        if (state.kind === "available" && state.result.asset) void download();
        else setModalOpen(true);
      }}
      title={title}
      aria-label={busy ? title : ready ? UPDATE_COPY.badge.ready : UPDATE_COPY.actions.updateNow}
      aria-busy={busy}
      className={`inline-flex h-7 min-w-[76px] shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[12px] font-semibold leading-none text-white shadow-apple-sm transition-[background-color,box-shadow,transform] duration-200 focus-visible:!rounded-full ${
        busy || ready
          ? "bg-[#3478f6] hover:bg-[#2868df]"
          : failed
            ? "bg-state-danger hover:brightness-110"
            : "bg-ink hover:bg-ink/85"
      }`}
    >
      {(busy || ready || failed) && (
        <span
          role={busy ? "progressbar" : undefined}
          aria-label={busy ? title : undefined}
          aria-valuemin={busy ? 0 : undefined}
          aria-valuemax={busy ? 100 : undefined}
          aria-valuenow={knownProgress ? percent : undefined}
          aria-valuetext={busy ? label : undefined}
          className="flex h-5 w-5 shrink-0 items-center justify-center"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            {busy ? (
              <>
                <circle cx="12" cy="12" r="10" opacity="0.3" />
                <circle
                  cx="12" cy="12" r="10"
                  strokeLinecap="round" strokeDasharray="62.83"
                  strokeDashoffset={knownProgress ? 62.83 * (1 - percent / 100) : 44}
                  className={knownProgress ? "-rotate-90 origin-center transition-[stroke-dashoffset] duration-200" : "origin-center animate-spin motion-reduce:animate-none"}
                />
                <path d="M12 7v10m-4-4 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </>
            ) : (
              <path d={failed ? "M12 5v9m0 4h.01" : "m6 12 4 4 8-8"} strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </span>
      )}
      <span className="tabular-nums">{label}</span>
    </button>
  );
};
