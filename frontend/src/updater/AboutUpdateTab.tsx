import React, { useEffect, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { UPDATE_COPY, formatMoment } from "./copy";
import { currentResult, shouldShowBadge } from "./state";
import { useUpdaterStore } from "./store";

const INTERVAL_OPTIONS = [1, 3, 6, 12, 24];

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#86868b]">{children}</h4>
);

const Card: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`rounded-xl border border-line/10 bg-canvas p-3.5 shadow-apple-sm ${className}`}>
    {children}
  </div>
);

/** 设置弹窗里的「关于与更新」页：版本信息、检查更新、通道/镜像配置与诊断入口。 */
export const AboutUpdateTab: React.FC = () => {
  const {
    state,
    config,
    appInfo,
    runtime,
    lastError,
    savingConfig,
    check,
    patchConfig,
    openLogDir,
    openBackupDir,
    backupNow,
    openReleasePage,
  } = useUpdaterStore();

  const [backupMsg, setBackupMsg] = useState<string | null>(null);

  // 打开该页时刷新一次运行时状态，保证「上次检查时间」是最新的
  const refreshRuntime = useUpdaterStore((s) => s.refreshRuntime);
  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  const result = currentResult(state);
  const checking = state.kind === "checking";
  const hasUpdate = shouldShowBadge(state);
  const platform = appInfo ? `${appInfo.target} ${appInfo.arch}` : "—";
  const dataDir = appInfo?.data_dir ?? runtime?.data_dir ?? "";

  const statusNode = (() => {
    if (checking) {
      return <span className="text-[11px] text-[#86868b]">{UPDATE_COPY.about.checkingNow}</span>;
    }
    if (lastError || runtime?.last_error) {
      return (
        <span className="rounded-md bg-[#ff9f0a]/[0.12] px-1.5 py-0.5 text-[11px] font-medium text-[#8a5a00]">
          {UPDATE_COPY.about.failedLabel}
        </span>
      );
    }
    if (hasUpdate && result) {
      return (
        <span className="rounded-md bg-[#0071e3]/[0.10] px-1.5 py-0.5 text-[11px] font-medium text-accent">
          {UPDATE_COPY.about.updateAvailableLabel} v{result.latest_version}
        </span>
      );
    }
    if (state.kind === "latest") {
      return (
        <span className="rounded-md bg-[#34c759]/[0.14] px-1.5 py-0.5 text-[11px] font-medium text-[#1a7f37]">
          {UPDATE_COPY.about.latestLabel}
        </span>
      );
    }
    return <span className="text-[11px] text-[#86868b]">{UPDATE_COPY.about.lastCheckNever}</span>;
  })();

  return (
    <div className="space-y-4">
      {/* 1. 版本卡 */}
      <Card className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-surface text-accent shadow-apple-sm">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-[13px] font-semibold text-[#1d1d1f]">
            OpenShell v{appInfo?.version ?? runtime?.current_version ?? "—"}
          </p>
          <p className="text-[11px] text-[#86868b]">
            {UPDATE_COPY.about.platformLabel}: {platform}
          </p>
          <button
            onClick={() => void openPath(dataDir).catch((err) => console.error("open data dir failed", err))}
            title={UPDATE_COPY.about.dataDirHint}
            className="max-w-full truncate font-mono text-[10px] text-accent hover:underline"
          >
            {UPDATE_COPY.about.dataDirLabel}: {dataDir}
          </button>
        </div>
      </Card>

      {/* 便携版提示：不会运行安装器 */}
      {appInfo?.is_portable && (
        <div className="rounded-xl border border-[#ff9f0a]/30 bg-[#ff9f0a]/[0.08] px-3 py-2.5">
          <p className="text-[11px] font-semibold text-[#1d1d1f]">{UPDATE_COPY.platform.manualTitle}</p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-[#5c3d00]">
            {UPDATE_COPY.platform.portable}
          </p>
        </div>
      )}

      {/* 2. 检查更新条 */}
      <Card className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <SectionTitle>{UPDATE_COPY.about.checkSection}</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            {statusNode}
            <span className="text-[11px] text-[#86868b]">
              {runtime?.last_check_at_ms
                ? `${UPDATE_COPY.about.lastCheckPrefix}${formatMoment(runtime.last_check_at_ms)}`
                : ""}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasUpdate && (
            <button
              onClick={() => void openReleasePage()}
              className="rounded-xl border border-line/15 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98]"
            >
              {UPDATE_COPY.actions.openRelease}
            </button>
          )}
          <button
            onClick={() => void check(true)}
            disabled={checking}
            className="rounded-xl bg-[#0071e3] px-3 py-1.5 text-[11px] font-semibold text-white shadow-apple-sm transition hover:bg-[#0077ed] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? UPDATE_COPY.actions.checking : UPDATE_COPY.actions.check}
          </button>
        </div>
      </Card>

      {/* 3. 配置区 */}
      <div className="space-y-3">
        <Card className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[12px] font-medium text-[#1d1d1f]">{UPDATE_COPY.about.autoCheck}</p>
              <p className="text-[10px] leading-relaxed text-[#86868b]">{UPDATE_COPY.about.autoCheckHint}</p>
            </div>
            <button
              onClick={() => void patchConfig({ auto_check: !config.auto_check })}
              disabled={savingConfig}
              role="switch"
              aria-checked={config.auto_check}
              className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 ${
                config.auto_check ? "bg-[#34c759]" : "bg-black/[0.15]"
              }`}
            >
              <span
                className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface shadow-apple-sm transition-all ${
                  config.auto_check ? "left-[1.15rem]" : "left-0.5"
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] font-medium text-[#1d1d1f]">{UPDATE_COPY.about.interval}</p>
            <select
              value={config.interval_hours}
              onChange={(e) => void patchConfig({ interval_hours: Number(e.target.value) })}
              className="rounded-lg border border-line/15 bg-surface px-2 py-1 text-[11px] text-[#1d1d1f] shadow-apple-sm outline-none transition focus:border-[#0071e3]/50"
            >
              {INTERVAL_OPTIONS.map((hours) => (
                <option key={hours} value={hours}>
                  {hours} {UPDATE_COPY.about.intervalHours}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <p className="text-[12px] font-medium text-[#1d1d1f]">{UPDATE_COPY.about.channel}</p>
            <div className="flex items-center gap-2">
              <div className="flex bg-line/5 p-0.5 rounded-xl text-[11px] font-medium">
                <button
                  onClick={() => void patchConfig({ channel: "stable" })}
                  className={`px-3 py-1 rounded-lg transition active:scale-[0.98] ${
                    config.channel === "stable"
                      ? "bg-surface font-semibold text-[#1d1d1f] shadow-apple-sm"
                      : "text-[#86868b] hover:text-[#1d1d1f]"
                  }`}
                >
                  {UPDATE_COPY.about.channelStable}
                </button>
                <button
                  onClick={() => void patchConfig({ channel: "beta" })}
                  className={`px-3 py-1 rounded-lg transition active:scale-[0.98] ${
                    config.channel === "beta"
                      ? "bg-surface font-semibold text-[#1d1d1f] shadow-apple-sm"
                      : "text-[#86868b] hover:text-[#1d1d1f]"
                  }`}
                >
                  {UPDATE_COPY.about.channelBeta}
                </button>
              </div>
            </div>
            <p className="text-[10px] leading-relaxed text-[#86868b]">
              {config.channel === "stable"
                ? UPDATE_COPY.about.channelStableHint
                : UPDATE_COPY.about.channelBetaHint}
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-[#1d1d1f]">
              {UPDATE_COPY.about.fallbackSource}
            </label>
            <input
              type="url"
              value={config.fallback_source ?? ""}
              placeholder="https://"
              onChange={(e) => void patchConfig({ fallback_source: e.target.value || null })}
              className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-[11px] text-[#1d1d1f] shadow-apple-sm outline-none transition placeholder:text-[#c7c7cc] focus:border-[#0071e3]/50"
            />
            <p className="text-[10px] leading-relaxed text-[#86868b]">{UPDATE_COPY.about.fallbackSourceHint}</p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[12px] font-medium text-[#1d1d1f]">{UPDATE_COPY.about.mirror}</label>
            <input
              type="url"
              value={config.mirror_prefix ?? ""}
              placeholder="https://"
              onChange={(e) => void patchConfig({ mirror_prefix: e.target.value || null })}
              className="w-full rounded-lg border border-line/15 bg-surface px-2.5 py-1.5 font-mono text-[11px] text-[#1d1d1f] shadow-apple-sm outline-none transition placeholder:text-[#c7c7cc] focus:border-[#0071e3]/50"
            />
            <p className="text-[10px] leading-relaxed text-[#86868b]">{UPDATE_COPY.about.mirrorHint}</p>
          </div>
        </Card>

        {/* 4. 诊断与备份 */}
        <Card className="space-y-2.5">
          <SectionTitle>{UPDATE_COPY.about.diagnostics}</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void openLogDir()}
              className="rounded-xl border border-line/15 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98]"
            >
              {UPDATE_COPY.actions.openLogs}
            </button>
            <button
              onClick={() =>
                void backupNow()
                  .then(() => setBackupMsg(runtime?.backups_dir ?? null))
                  .catch((err) => console.error("backup failed", err))
              }
              className="rounded-xl border border-line/15 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98]"
            >
              {UPDATE_COPY.actions.backupNow}
            </button>
            <button
              onClick={() => void openBackupDir()}
              className="rounded-xl border border-line/15 bg-surface px-2.5 py-1.5 text-[11px] font-medium text-[#1d1d1f] shadow-apple-sm transition hover:bg-surface-muted active:scale-[0.98]"
            >
              {UPDATE_COPY.actions.openBackups}
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-[#86868b]">{UPDATE_COPY.about.backupsHint}</p>
          <p className="text-[10px] text-[#86868b]">
            {UPDATE_COPY.about.skipped}:{" "}
            <span className="font-mono">
              {runtime?.skipped_versions?.length ? runtime.skipped_versions.join(", ") : UPDATE_COPY.about.none}
            </span>
          </p>
          {backupMsg && <p className="font-mono text-[10px] text-[#1a7f37]">{backupMsg}</p>}
        </Card>
      </div>
    </div>
  );
};
