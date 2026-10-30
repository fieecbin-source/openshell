import React from "react";
import { UPDATE_COPY, describeUpdateError, formatBytes, formatMoment, formatRemaining, formatSpeed } from "./copy";
import { currentResult, progressPercent, type UpdateState } from "./state";
import { UpdateNotes } from "./UpdateNotes";
import { useUpdaterStore } from "./store";

const ProgressBar: React.FC<{ percent: number }> = ({ percent }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08]">
    <div
      className="h-full rounded-full bg-[#0071e3] transition-[width] duration-200 ease-out"
      style={{ width: `${Math.max(1, percent)}%` }}
    />
  </div>
);

const Spinner: React.FC = () => (
  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#0071e3]/25 border-t-[#0071e3]" />
);

const MandatoryBanner: React.FC = () => (
  <div className="flex gap-2 rounded-xl border border-[#ff9f0a]/30 bg-[#ff9f0a]/[0.08] px-3 py-2.5">
    <span className="mt-0.5 text-[#ff9f0a]">
      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
        />
      </svg>
    </span>
    <div className="space-y-0.5">
      <p className="text-[12px] font-semibold text-[#1d1d1f]">{UPDATE_COPY.modal.mandatoryTitle}</p>
      <p className="text-[11px] leading-relaxed text-[#86868b]">{UPDATE_COPY.modal.mandatoryBody}</p>
    </div>
  </div>
);

/**
 * 「还需要你完成最后一步」提示。
 *
 * macOS 需要在镜像里拖入「应用程序」，便携版需要手动替换程序文件 ——
 * 这两种情况后端刻意不让应用退出，必须在这里把话讲清楚，否则用户会以为点了没反应。
 */
const ManualHint: React.FC = () => {
  const installHint = useUpdaterStore((s) => s.installHint);
  const openDownloadDir = useUpdaterStore((s) => s.openDownloadDir);
  if (!installHint) return null;
  return (
    <div className="space-y-1.5 rounded-xl border border-[#ff9f0a]/30 bg-[#ff9f0a]/[0.08] px-3 py-2.5">
      <p className="text-[12px] font-semibold text-[#1d1d1f]">{UPDATE_COPY.platform.manualTitle}</p>
      <p className="text-[11px] leading-relaxed text-[#3a3a3c]">{installHint}</p>
      <button
        onClick={() => void openDownloadDir()}
        className="rounded-lg border border-line/15 bg-surface px-2 py-1 text-[11px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98]"
      >
        {UPDATE_COPY.actions.openDownloads}
      </button>
    </div>
  );
};

interface UpdatePhaseViewProps {
  state: UpdateState;
}

/** 弹窗主体：按状态渲染不同内容（按钮在 `UpdateModal` 的底部操作区）。 */
export const UpdatePhaseView: React.FC<UpdatePhaseViewProps> = ({ state }) => {
  const result = currentResult(state);

  switch (state.kind) {
    case "idle":
      return (
        <p className="py-6 text-center text-[12px] text-[#86868b]">{UPDATE_COPY.phase.idle}</p>
      );

    case "checking":
      return (
        <div className="space-y-2.5 py-2">
          <div className="flex items-center gap-2 text-[12px] text-[#86868b]">
            <Spinner />
            <span>{UPDATE_COPY.phase.checking}</span>
          </div>
          <div className="h-2.5 w-3/4 animate-pulse rounded-md bg-line/5" />
          <div className="h-2.5 w-full animate-pulse rounded-md bg-line/5" />
          <div className="h-2.5 w-5/6 animate-pulse rounded-md bg-black/[0.04]" />
        </div>
      );

    case "latest":
      return (
        <div className="flex flex-col items-center gap-2 py-8">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#34c759]/[0.12] text-[#34c759]">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M5 13l4 4L19 7" />
            </svg>
          </span>
          <p className="text-[13px] font-semibold text-[#1d1d1f]">{UPDATE_COPY.phase.latest}</p>
          <p className="text-[11px] text-[#86868b]">v{state.result.current_version}</p>
        </div>
      );

    case "available":
      return (
        <div className="space-y-2.5">
          {state.result.mandatory && <MandatoryBanner />}
          <UpdateNotes html={state.result.notes_html} fallback={UPDATE_COPY.modal.releaseNotesFallback} />
          {!state.result.asset && (
            <p className="rounded-lg bg-[#ff9f0a]/[0.08] px-3 py-2 text-[11px] leading-relaxed text-[#8a5a00]">
              {UPDATE_COPY.modal.manualDownloadHint}
            </p>
          )}
        </div>
      );

    case "downloading": {
      const { progress } = state;
      const percent = progressPercent(state);
      const remaining = formatRemaining(progress.received, progress.total, progress.bytes_per_sec);
      return (
        <div className="space-y-3 py-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] font-medium text-[#1d1d1f]">{UPDATE_COPY.phase.downloading}</span>
            <span className="font-mono text-[11px] text-[#86868b]">{percent.toFixed(0)}%</span>
          </div>
          <ProgressBar percent={percent} />
          <div className="flex items-center justify-between text-[11px] text-[#86868b]">
            <span className="font-mono">
              {formatBytes(progress.received)} {UPDATE_COPY.progress.of}{" "}
              {progress.total ? formatBytes(progress.total) : "?"}
            </span>
            <span className="font-mono">
              {UPDATE_COPY.progress.speed} {formatSpeed(progress.bytes_per_sec)}
              {remaining ? ` · ${UPDATE_COPY.progress.remaining} ${remaining}` : ""}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-[#86868b]">{UPDATE_COPY.progress.cancelHint}</p>
        </div>
      );
    }

    case "verifying":
      return (
        <div className="flex flex-col items-center gap-2.5 py-8">
          <Spinner />
          <p className="text-[12px] font-medium text-[#1d1d1f]">{UPDATE_COPY.phase.verifying}</p>
          <p className="max-w-full truncate font-mono text-[11px] text-[#86868b]">
            {result?.asset?.name ?? ""}
          </p>
          <p className="px-6 text-center text-[11px] leading-relaxed text-[#86868b]">
            {UPDATE_COPY.progress.verifyingHint}
          </p>
        </div>
      );

    case "ready":
      return (
        <div className="space-y-2 py-2">
          <div className="flex items-center gap-2 rounded-xl border border-[#34c759]/25 bg-[#34c759]/[0.07] px-3 py-2.5">
            <span className="text-[#34c759]">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                />
              </svg>
            </span>
            <div>
              <p className="text-[12px] font-semibold text-[#1d1d1f]">{UPDATE_COPY.phase.ready}</p>
              <p className="text-[11px] leading-relaxed text-[#86868b]">{UPDATE_COPY.modal.mandatoryBody}</p>
            </div>
          </div>
          <ManualHint />
          <UpdateNotes html={result?.notes_html ?? ""} fallback={UPDATE_COPY.modal.releaseNotesFallback} />
        </div>
      );

    case "check_failed":
      return (
        <div className="space-y-2 py-3">
          <div className="flex items-center gap-2 text-[#ff9f0a]">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
            <span className="text-[12px] font-semibold">{UPDATE_COPY.phase.checkFailed}</span>
          </div>
          <p className="text-[11px] leading-relaxed text-[#3a3a3c]">
            {describeUpdateError(state.error)}
          </p>
        </div>
      );

    case "download_failed":
    case "verify_failed":
    case "install_failed": {
      const title =
        state.kind === "download_failed"
          ? UPDATE_COPY.phase.downloadFailed
          : state.kind === "verify_failed"
            ? UPDATE_COPY.phase.verifyFailed
            : UPDATE_COPY.phase.installFailed;
      return (
        <div className="space-y-2 py-3">
          <div className="flex items-center gap-2 text-[#ff3b30]">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-[12px] font-semibold">{title}</span>
          </div>
          <p className="text-[11px] leading-relaxed text-[#3a3a3c]">
            {describeUpdateError(state.error)}
          </p>
          {result?.published_at && (
            <p className="text-[11px] text-[#86868b]">
              {UPDATE_COPY.modal.publishedAt} {formatMoment(result.published_at)}
            </p>
          )}
          <ManualHint />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              onClick={() => void useUpdaterStore.getState().openDownloadDir()}
              className="rounded-xl border border-line/15 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98]"
            >
              {UPDATE_COPY.actions.openDownloads}
            </button>
            <span className="text-[10px] text-[#86868b]">{UPDATE_COPY.platform.openFolderHint}</span>
          </div>
        </div>
      );
    }

    default:
      return null;
  }
};
