/**
 * 更新流程的状态机（纯函数，无副作用，可离线单测）。
 *
 * ```text
 * idle → checking → latest | available | check_failed
 * available → downloading → verifying → ready → (install_failed)
 * downloading → download_failed | (取消) available
 * verifying → verify_failed → available
 * ```
 *
 * 设计要点：
 * * 任何阶段都允许「重新检查」，但下载/校验中不允许被检查结果覆盖（否则进度会丢）；
 * * 已经拿到可用新版本时，后台自动检查失败**不会**把界面打回错误态；
 * * 每个状态都自带它需要的上下文（版本信息 / 进度 / 错误），UI 里不需要再猜。
 */
import type { DownloadProgress, UpdateCheckResult } from "./types";

export interface ReadyInfo {
  result: UpdateCheckResult;
  path: string;
}

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking"; manual: boolean }
  | { kind: "latest"; result: UpdateCheckResult }
  | { kind: "available"; result: UpdateCheckResult }
  | { kind: "check_failed"; error: unknown; retryable: boolean }
  | { kind: "downloading"; result: UpdateCheckResult; progress: DownloadProgress }
  | { kind: "verifying"; result: UpdateCheckResult; progress: DownloadProgress }
  | { kind: "ready"; result: UpdateCheckResult; path: string }
  | { kind: "download_failed"; result: UpdateCheckResult; error: unknown; retryable: boolean }
  | { kind: "verify_failed"; result: UpdateCheckResult; error: unknown }
  | { kind: "install_failed"; result: UpdateCheckResult; error: unknown; retryable: boolean };

export type UpdateEvent =
  | { type: "check_started"; manual: boolean }
  | { type: "check_succeeded"; result: UpdateCheckResult }
  | { type: "check_failed"; error: unknown; retryable: boolean }
  | { type: "download_started" }
  | { type: "download_progress"; progress: DownloadProgress }
  | { type: "download_succeeded"; path: string }
  | { type: "download_failed"; error: unknown; retryable: boolean }
  | { type: "download_cancelled" }
  | { type: "install_failed"; error: unknown; retryable: boolean }
  | { type: "dismissed" };

const BUSY: UpdateState["kind"][] = ["downloading", "verifying"];

export function reduce(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.type) {
    case "check_started":
      // 下载/校验中忽略检查，避免把进行中的任务状态冲掉
      if (BUSY.includes(state.kind)) return state;
      return { kind: "checking", manual: event.manual };

    case "check_succeeded":
      return event.result.has_update
        ? { kind: "available", result: event.result }
        : { kind: "latest", result: event.result };

    case "check_failed":
      // 已经有可安装的新版本时，后台检查失败只记日志，不回退界面
      if (state.kind === "available" || state.kind === "ready") return state;
      if (BUSY.includes(state.kind)) return state;
      return { kind: "check_failed", error: event.error, retryable: event.retryable };

    case "download_started": {
      const result = currentResult(state);
      if (!result) return state;
      return {
        kind: "downloading",
        result,
        progress: { received: 0, total: assetSize(result), percent: 0, bytes_per_sec: 0, phase: "downloading" },
      };
    }

    case "download_progress": {
      if (state.kind === "downloading" || state.kind === "verifying") {
        const nextKind = event.progress.phase === "verifying" ? "verifying" : "downloading";
        return { ...state, kind: nextKind, progress: event.progress } as UpdateState;
      }
      // 后台可能先收到进度再收到 download_started，这里宽容处理
      const result = currentResult(state);
      if (!result) return state;
      return { kind: "downloading", result, progress: event.progress };
    }

    case "download_succeeded": {
      const result = currentResult(state);
      if (!result) return state;
      return { kind: "ready", result, path: event.path };
    }

    case "download_failed": {
      const result = currentResult(state);
      if (!result) {
        return { kind: "check_failed", error: event.error, retryable: event.retryable };
      }
      return { kind: "download_failed", result, error: event.error, retryable: event.retryable };
    }

    case "download_cancelled": {
      const result = currentResult(state);
      if (!result) return { kind: "idle" };
      return { kind: "available", result };
    }

    case "install_failed": {
      const result = currentResult(state);
      if (!result) {
        return { kind: "check_failed", error: event.error, retryable: event.retryable };
      }
      return { kind: "install_failed", result, error: event.error, retryable: event.retryable };
    }

    case "dismissed":
      // 关闭弹窗不等于放弃更新：保留「有新版本」的信息用于顶栏红点
      if (state.kind === "checking" || state.kind === "check_failed") return { kind: "idle" };
      return state;

    default:
      return state;
  }
}

/** 当前状态下能拿到的版本信息（进度态/就绪态/失败态都带着它）。 */
export function currentResult(state: UpdateState): UpdateCheckResult | null {
  switch (state.kind) {
    case "available":
    case "latest":
    case "ready":
    case "downloading":
    case "verifying":
    case "download_failed":
    case "verify_failed":
    case "install_failed":
      return state.result;
    default:
      return null;
  }
}

function assetSize(result: UpdateCheckResult): number | undefined {
  return result.asset && result.asset.size > 0 ? result.asset.size : undefined;
}

/** 顶栏是否应该显示红点（有新版本可提示）。 */
export function shouldShowBadge(state: UpdateState): boolean {
  return Boolean(currentResult(state)?.has_update) && state.kind !== "latest";
}

/** 是否强制更新（用于徽标改成红色感叹号并隐藏跳过/稍后）。 */
export function isMandatory(state: UpdateState): boolean {
  const result = currentResult(state);
  return Boolean(result?.mandatory);
}

/** 下载是否进行中（用于弹窗「后台继续下载」提示）。 */
export function isBusy(state: UpdateState): boolean {
  return BUSY.includes(state.kind);
}

/** 进度百分比（0-100），没有总量时返回 0。 */
export function progressPercent(state: UpdateState): number {
  if (state.kind === "downloading" || state.kind === "verifying") {
    return Math.max(0, Math.min(100, state.progress.percent || 0));
  }
  return 0;
}
