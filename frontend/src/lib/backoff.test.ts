import { describe, expect, it, vi, afterEach } from "vitest";
import {
  DEFAULT_RECONNECT_POLICY,
  formatCountdown,
  nextBackoffDelay,
  policyFromSession,
} from "./backoff";

describe("nextBackoffDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("按 2 的幂次增长并在上限处收敛", () => {
    // 固定抖动因子，去掉随机性后验证基数序列
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0
    const policy = { ...DEFAULT_RECONNECT_POLICY, baseDelayMs: 1000, maxDelayMs: 8000 };

    expect(nextBackoffDelay(1, policy)).toBe(1000);
    expect(nextBackoffDelay(2, policy)).toBe(2000);
    expect(nextBackoffDelay(3, policy)).toBe(4000);
    expect(nextBackoffDelay(4, policy)).toBe(8000);
    // 超过上限后保持 maxDelayMs
    expect(nextBackoffDelay(9, policy)).toBe(8000);
  });

  it("抖动被限制在 ±20% 之内", () => {
    const policy = { ...DEFAULT_RECONNECT_POLICY, baseDelayMs: 1000, maxDelayMs: 30000 };
    const low = nextBackoffDelay(1, policy);
    const high = nextBackoffDelay(1, policy);
    expect(low).toBeGreaterThanOrEqual(800);
    expect(high).toBeLessThanOrEqual(1200);
  });

  it("对非法 attempt 做收敛，不产生 NaN", () => {
    const policy = { ...DEFAULT_RECONNECT_POLICY, baseDelayMs: 500, maxDelayMs: 5000 };
    expect(Number.isNaN(nextBackoffDelay(0, policy))).toBe(false);
    expect(nextBackoffDelay(-3, policy)).toBeGreaterThan(0);
  });
});

describe("policyFromSession", () => {
  it("把 reconnect_max 收敛到 1..20", () => {
    expect(policyFromSession(true, 0).maxAttempts).toBe(1);
    expect(policyFromSession(true, 999).maxAttempts).toBe(20);
    expect(policyFromSession(true, undefined).maxAttempts).toBe(3);
    expect(policyFromSession(false, 5).enabled).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("秒级与分级格式", () => {
    expect(formatCountdown(0)).toBe("0s");
    expect(formatCountdown(900)).toBe("1s");
    expect(formatCountdown(61_000)).toBe("1m01s");
  });
});
