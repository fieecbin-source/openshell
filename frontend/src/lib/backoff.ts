/**
 * 断线自动重连的退避策略。
 *
 * 抽成纯函数便于单测：重连节奏是用户体感最敏感的部分，
 * 回归时不应该只能靠手动拔网线来验证。
 */

export interface ReconnectPolicy {
  /** 是否启用自动重连（来自会话配置 auto_reconnect） */
  enabled: boolean;
  /** 最大尝试次数（来自会话配置 reconnect_max） */
  maxAttempts: number;
  /** 首次重试延迟（毫秒） */
  baseDelayMs: number;
  /** 单次重试延迟上限（毫秒） */
  maxDelayMs: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  enabled: false,
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

/** 由会话配置派生重连策略，非法数值一律收敛到安全范围 */
export function policyFromSession(
  enabled: boolean | undefined,
  maxAttempts: number | undefined
): ReconnectPolicy {
  const max = Number.isFinite(maxAttempts) ? Math.floor(maxAttempts as number) : 3;
  return {
    ...DEFAULT_RECONNECT_POLICY,
    enabled: !!enabled,
    maxAttempts: Math.min(20, Math.max(1, max)),
  };
}

/**
 * 第 `attempt` 次重试前应等待的毫秒数（attempt 从 1 开始）。
 *
 * 1s → 2s → 4s → 8s …，上限 `maxDelayMs`；附加 ±20% 抖动，
 * 避免多个标签同时断线后在同一时刻集中重连把服务器打爆。
 */
export function nextBackoffDelay(attempt: number, policy: ReconnectPolicy): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const base = Math.max(1, policy.baseDelayMs);
  const cap = Math.max(base, policy.maxDelayMs);
  const raw = base * Math.pow(2, safeAttempt - 1);
  const capped = Math.min(raw, cap);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.max(0, Math.round(capped * jitter));
}

/** 把剩余毫秒格式化成 "3s" / "1m05s"，用于断线遮罩上的倒计时 */
export function formatCountdown(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}m${ss.toString().padStart(2, "0")}s`;
}
