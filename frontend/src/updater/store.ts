/**
 * 更新流程的运行时状态（Zustand）。
 *
 * 职责边界：
 * * 状态迁移全部交给 `state.ts` 的纯函数，这里只负责「发 IPC + 派发事件」；
 * * 配置走现有 `setting` 表（`update.*`），因此会自动跟着数据备份一起保留；
 * * 自动检查的定时器只在这里维护，组件卸载不影响它。
 */
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getAppInfo, settingsGet, settingsSet } from "../lib/ipc";
import type { AppInfo } from "../types/ipc";
import * as api from "./ipc";
import { currentResult, isBusy, reduce, type UpdateEvent, type UpdateState } from "./state";
import {
  DEFAULT_UPDATE_CONFIG,
  type BackupInfo,
  type DownloadProgress,
  type UpdateCheckResult,
  type UpdateConfig,
  type UpdaterStateView,
} from "./types";

/** 启动后延迟多久做第一次自动检查（与后端 `STARTUP_DELAY_SECS` 对齐）。 */
const STARTUP_DELAY_MS = 30_000;

const SETTING_KEYS = {
  autoCheck: "update.auto_check",
  intervalHours: "update.interval_hours",
  channel: "update.channel",
  fallbackSource: "update.fallback_source",
  mirrorPrefix: "update.mirror_prefix",
  backupKeep: "update.backup_keep",
} as const;

interface UpdaterStore {
  state: UpdateState;
  modalOpen: boolean;
  config: UpdateConfig;
  appInfo: AppInfo | null;
  runtime: UpdaterStateView | null;
  lastError: string | null;
  /** 安装结束后的「还需要你动手」提示（macOS 拖入应用程序 / 便携版手动替换）。 */
  installHint: string | null;
  savingConfig: boolean;
  bootstrapped: boolean;

  bootstrap: () => Promise<void>;
  refreshRuntime: () => Promise<void>;
  setModalOpen: (open: boolean) => void;
  check: (manual?: boolean) => Promise<void>;
  download: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  install: () => Promise<void>;
  skipVersion: () => Promise<void>;
  remindLater: () => Promise<void>;
  patchConfig: (patch: Partial<UpdateConfig>) => Promise<void>;
  openReleasePage: () => Promise<void>;
  openLogDir: () => Promise<void>;
  openBackupDir: () => Promise<void>;
  openDownloadDir: () => Promise<void>;
  backupNow: () => Promise<void>;
  listBackups: () => Promise<BackupInfo[]>;
}

let startupTimer: ReturnType<typeof setTimeout> | undefined;
let intervalTimer: ReturnType<typeof setInterval> | undefined;

export const useUpdaterStore = create<UpdaterStore>((set, get) => {
  const dispatch = (event: UpdateEvent) =>
    set((prev) => ({ state: reduce(prev.state, event) }));

  const loadConfig = async (): Promise<UpdateConfig> => {
    const [autoCheck, interval, channel, fallback, mirror, keep] = await Promise.all([
      settingsGet("user", SETTING_KEYS.autoCheck),
      settingsGet("user", SETTING_KEYS.intervalHours),
      settingsGet("user", SETTING_KEYS.channel),
      settingsGet("user", SETTING_KEYS.fallbackSource),
      settingsGet("user", SETTING_KEYS.mirrorPrefix),
      settingsGet("user", SETTING_KEYS.backupKeep),
    ]);
    const value = (record: { value_json?: unknown } | null) => record?.value_json;
    return {
      ...DEFAULT_UPDATE_CONFIG,
      auto_check:
        typeof value(autoCheck) === "boolean"
          ? Boolean(value(autoCheck))
          : DEFAULT_UPDATE_CONFIG.auto_check,
      interval_hours:
        typeof value(interval) === "number"
          ? Number(value(interval))
          : DEFAULT_UPDATE_CONFIG.interval_hours,
      channel: value(channel) === "beta" ? "beta" : "stable",
      fallback_source: (value(fallback) as string) || null,
      mirror_prefix: (value(mirror) as string) || null,
      backup_keep:
        typeof value(keep) === "number" ? Number(value(keep)) : DEFAULT_UPDATE_CONFIG.backup_keep,
    };
  };

  const schedule = (config: UpdateConfig) => {
    if (startupTimer) clearTimeout(startupTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    startupTimer = undefined;
    intervalTimer = undefined;
    if (!config.auto_check) return;

    startupTimer = setTimeout(() => {
      void get().check(false);
    }, STARTUP_DELAY_MS);
    const periodMs = Math.max(1, config.interval_hours) * 3_600_000;
    intervalTimer = setInterval(() => {
      void get().check(false);
    }, periodMs);
  };

  return {
    state: { kind: "idle" },
    modalOpen: false,
    config: DEFAULT_UPDATE_CONFIG,
    appInfo: null,
    runtime: null,
    lastError: null,
    installHint: null,
    savingConfig: false,
    bootstrapped: false,

    bootstrap: async () => {
      if (get().bootstrapped) return;
      set({ bootstrapped: true });

      const config = await loadConfig().catch((err) => {
        console.error("load updater config failed", err);
        return DEFAULT_UPDATE_CONFIG;
      });
      set({ config });

      const [info, runtime] = await Promise.all([
        getAppInfo().catch((err) => {
          console.error("load app info failed", err);
          return null;
        }),
        api.fetchUpdaterState().catch((err) => {
          console.error("load updater state failed", err);
          return null;
        }),
      ]);
      set({ appInfo: info, runtime });
      schedule(config);
    },

    refreshRuntime: async () => {
      const runtime = await api.fetchUpdaterState().catch((err) => {
        console.error("refresh updater state failed", err);
        return null;
      });
      if (runtime) set({ runtime });
    },

    setModalOpen: (open) => set({ modalOpen: open }),

    check: async (manual = true) => {
      if (isBusy(get().state)) return;
      dispatch({ type: "check_started", manual });
      const { config } = get();
      await api
        .checkForUpdate(config, manual)
        .then((view) => {
          // Updates are always optional. Background checks only expose an entry
          // point, and honor skip/snooze without opening a dialog or downloading.
          const result = { ...view.result, mandatory: false };
          const suppressed = !manual && (view.decision === "skipped" || view.decision === "remind_later");
          if (suppressed) set({ state: { kind: "idle" } });
          else dispatch({ type: "check_succeeded", result });
          set({ lastError: null });
          const shouldOpen = result.has_update && manual;
          if (shouldOpen) set({ modalOpen: true });
          return get().refreshRuntime();
        })
        .catch((err) => {
          console.error("check update failed", err);
          dispatch({ type: "check_failed", error: err, retryable: true });
          set({ lastError: String((err as { message?: string })?.message ?? err) });
          return get().refreshRuntime();
        });
    },

    download: async () => {
      const result = currentResult(get().state);
      if (!result?.asset) return;
      dispatch({ type: "download_started" });
      await api
        .downloadInstaller(get().config, result.asset, (progress: DownloadProgress) => {
          dispatch({ type: "download_progress", progress });
        })
        .then((outcome) => {
          dispatch({ type: "download_succeeded", path: outcome.path });
          return get().refreshRuntime();
        })
        .catch((err) => {
          console.error("download installer failed", err);
          dispatch({ type: "download_failed", error: err, retryable: true });
          return get().refreshRuntime();
        });
    },

    cancelDownload: async () => {
      await api.cancelDownload().catch((err) => console.error("cancel download failed", err));
      dispatch({ type: "download_cancelled" });
    },

    install: async () => {
      const current = get().state;
      if (current.kind !== "ready") return;
      const result: UpdateCheckResult = current.result;
      await api
        .installUpdate(current.path, result.asset!, result.latest_version)
        .then((view) => {
          // 需要用户手动收尾时（macOS 拖入应用程序 / 便携版替换文件），
          // 后端不会让应用退出，这里把提示挂到弹窗上，不能让用户觉得「点了没反应」
          set({ installHint: view.manual_hint ?? null });
        })
        .catch((err) => {
          console.error("launch installer failed", err);
          dispatch({ type: "install_failed", error: err, retryable: true });
        });
    },

    skipVersion: async () => {
      const result = currentResult(get().state);
      if (result) {
        await api
          .skipVersion(result.latest_version)
          .catch((err) => console.error("skip version failed", err));
      }
      set({ modalOpen: false, state: { kind: "idle" } });
      await get().refreshRuntime();
    },

    remindLater: async () => {
      await api.remindLater().catch((err) => console.error("remind later failed", err));
      set({ modalOpen: false, state: { kind: "idle" } });
      await get().refreshRuntime();
    },

    patchConfig: async (patch) => {
      const next = { ...get().config, ...patch };
      set({ config: next, savingConfig: true });
      const writes: Promise<unknown>[] = [];
      if (patch.auto_check !== undefined) {
        writes.push(settingsSet("user", SETTING_KEYS.autoCheck, next.auto_check));
      }
      if (patch.interval_hours !== undefined) {
        writes.push(settingsSet("user", SETTING_KEYS.intervalHours, next.interval_hours));
      }
      if (patch.channel !== undefined) {
        writes.push(settingsSet("user", SETTING_KEYS.channel, next.channel));
      }
      if (patch.fallback_source !== undefined) {
        writes.push(settingsSet("user", SETTING_KEYS.fallbackSource, next.fallback_source ?? ""));
      }
      if (patch.mirror_prefix !== undefined) {
        writes.push(settingsSet("user", SETTING_KEYS.mirrorPrefix, next.mirror_prefix ?? ""));
      }
      if (patch.backup_keep !== undefined) {
        writes.push(settingsSet("user", SETTING_KEYS.backupKeep, next.backup_keep));
      }
      await Promise.all(writes)
        .catch((err) => console.error("save updater config failed", err))
        .finally(() => set({ savingConfig: false }));
      schedule(next);
    },

    openReleasePage: async () => {
      const result = currentResult(get().state);
      if (result?.release_page_url) {
        await openUrl(result.release_page_url).catch((err) =>
          console.error("open release page failed", err)
        );
        return;
      }
      await api.openReleasePage(get().config).catch((err) =>
        console.error("open release page failed", err)
      );
    },

    openLogDir: async () => {
      await api.openLogDir().catch((err) => console.error("open log dir failed", err));
    },

    openBackupDir: async () => {
      await api.openBackupDir().catch((err) => console.error("open backup dir failed", err));
    },

    openDownloadDir: async () => {
      await api.openDownloadDir().catch((err) => console.error("open download dir failed", err));
    },

    backupNow: async () => {
      await api.backupNow("manual").catch((err) => console.error("backup now failed", err));
      await get().refreshRuntime();
    },

    listBackups: async () => await api.listBackups().catch(() => []),
  };
});
