import React, { useEffect } from "react";
import { UPDATE_COPY, formatBytes, formatMoment } from "./copy";
import { currentResult, isBusy } from "./state";
import { useUpdaterStore } from "./store";
import { UpdatePhaseView } from "./UpdatePhaseView";

/** 底部操作区按钮的统一样式（与设置弹窗一致：主按钮实心蓝、次按钮白底描边）。 */
const PRIMARY =
  "rounded-xl bg-[#0071e3] px-3.5 py-1.5 text-[12px] font-semibold text-white shadow-apple-sm transition hover:bg-[#0077ed] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "rounded-xl border border-line/15 bg-surface px-3.5 py-1.5 text-[12px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const GHOST =
  "rounded-lg px-2 py-1 text-[11px] font-medium text-[#86868b] transition hover:text-[#1d1d1f] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

export const UpdateModal: React.FC = () => {
  const {
    state,
    modalOpen,
    setModalOpen,
    check,
    download,
    cancelDownload,
    install,
    skipVersion,
    remindLater,
    openReleasePage,
    openLogDir,
  } = useUpdaterStore();

  const result = currentResult(state);
  const busy = isBusy(state);
  const mandatory = Boolean(result?.mandatory);

  // Esc 关闭：下载中不打断任务，只是把弹窗收起来
  useEffect(() => {
    if (!modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [modalOpen, setModalOpen]);

  if (!modalOpen) return null;

  const renderFooter = () => {
    switch (state.kind) {
      case "checking":
        return <span className="text-[11px] text-[#86868b]">{UPDATE_COPY.actions.checking}</span>;

      case "idle":
      case "check_failed":
        return (
          <>
            <button className={GHOST} onClick={() => void openReleasePage()}>
              {UPDATE_COPY.actions.openRelease}
            </button>
            <button className={PRIMARY} onClick={() => void check(true)}>
              {state.kind === "check_failed" ? UPDATE_COPY.actions.retry : UPDATE_COPY.actions.check}
            </button>
          </>
        );

      case "latest":
        return (
          <button className={SECONDARY} onClick={() => void check(true)}>
            {UPDATE_COPY.actions.check}
          </button>
        );

      case "available":
        return (
          <>
            {!mandatory && (
              <>
                <button className={GHOST} onClick={() => void skipVersion()}>
                  {UPDATE_COPY.actions.skip}
                </button>
                <button className={GHOST} onClick={() => void remindLater()}>
                  {UPDATE_COPY.actions.later}
                </button>
              </>
            )}
            {result?.asset ? (
              <button className={PRIMARY} onClick={() => void download()}>
                {UPDATE_COPY.actions.updateNow}
              </button>
            ) : (
              <button className={PRIMARY} onClick={() => void openReleasePage()}>
                {UPDATE_COPY.actions.downloadManually}
              </button>
            )}
          </>
        );

      case "downloading":
      case "verifying":
        return (
          <>
            <button className={GHOST} onClick={() => setModalOpen(false)}>
              {UPDATE_COPY.modal.minimize}
            </button>
            <button className={SECONDARY} onClick={() => void cancelDownload()}>
              {UPDATE_COPY.actions.cancel}
            </button>
          </>
        );

      case "ready":
        return (
          <>
            {!mandatory && (
              <button className={GHOST} onClick={() => setModalOpen(false)}>
                {UPDATE_COPY.actions.later}
              </button>
            )}
            <button className={PRIMARY} onClick={() => void install()}>
              {UPDATE_COPY.actions.installNow}
            </button>
          </>
        );

      case "download_failed":
        return (
          <>
            <button className={GHOST} onClick={() => void openReleasePage()}>
              {UPDATE_COPY.actions.downloadManually}
            </button>
            <button className={PRIMARY} onClick={() => void download()}>
              {UPDATE_COPY.actions.retry}
            </button>
          </>
        );

      case "verify_failed":
        return (
          <>
            <button className={GHOST} onClick={() => void openReleasePage()}>
              {UPDATE_COPY.actions.downloadManually}
            </button>
            <button className={PRIMARY} onClick={() => void download()}>
              {UPDATE_COPY.actions.retry}
            </button>
          </>
        );

      case "install_failed":
        return (
          <>
            <button className={GHOST} onClick={() => void openLogDir()}>
              {UPDATE_COPY.actions.openLogs}
            </button>
            <button className={GHOST} onClick={() => void openReleasePage()}>
              {UPDATE_COPY.actions.downloadManually}
            </button>
            <button className={PRIMARY} onClick={() => void install()}>
              {UPDATE_COPY.actions.retry}
            </button>
          </>
        );

      default:
        return null;
    }
  };

  const showVersionHeader = Boolean(result);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 animate-fade-in bg-black/25 backdrop-blur-[2px]"
        onClick={() => setModalOpen(false)}
      />
      <div className="relative w-full max-w-xl animate-zoom-in overflow-hidden rounded-2xl border border-line/10 bg-surface/95 shadow-apple-lg backdrop-blur-xl">
        {/* 头部：版本跃迁 + 元信息 */}
        <div className="flex items-start gap-3 border-b border-line/10 px-5 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent shadow-sm">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold tracking-tight text-[#1d1d1f]">
              {UPDATE_COPY.modal.title}
            </h3>
            {showVersionHeader && result ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-[#86868b]">v{result.current_version}</span>
                <span className="text-[#86868b]">→</span>
                <span className="rounded-md bg-[#0071e3]/[0.08] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-accent">
                  v{result.latest_version}
                </span>
                {result.published_at && (
                  <span className="text-[11px] text-[#86868b]">
                    {UPDATE_COPY.modal.publishedAt} {formatMoment(result.published_at)}
                  </span>
                )}
                {result.asset && result.asset.size > 0 && (
                  <span className="rounded-md bg-line/5 px-1.5 py-0.5 text-[11px] text-[#86868b]">
                    {UPDATE_COPY.modal.packageSize} {formatBytes(result.asset.size)}
                  </span>
                )}
                {result.from_cache && (
                  <span className="text-[11px] text-[#86868b]">{UPDATE_COPY.modal.fromCache}</span>
                )}
              </div>
            ) : (
              <p className="mt-0.5 text-[11px] text-[#86868b]">{UPDATE_COPY.modal.subtitle}</p>
            )}
          </div>
          <button
            onClick={() => setModalOpen(false)}
            title={busy ? UPDATE_COPY.modal.minimize : UPDATE_COPY.modal.close}
            className="p-1.5 text-[#86868b] rounded-lg hover:text-[#1d1d1f] hover:bg-line/5 active:scale-95 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 主体 */}
        <div className="px-5 py-4">
          <UpdatePhaseView state={state} />
        </div>

        {/* 底部操作区 */}
        <div className="flex min-h-[48px] items-center justify-end gap-2 border-t border-line/10 bg-line/5 px-5 py-2.5">
          {renderFooter()}
        </div>
      </div>
    </div>
  );
};
