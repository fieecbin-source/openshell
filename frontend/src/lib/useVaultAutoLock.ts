import { useEffect, useRef } from "react";
import { useVaultStore } from "../stores/vaultStore";

/** 与后端 VaultStatus.auto_lock_minutes 保持一致 */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** 活动事件合并窗口：避免鼠标移动每帧都重置定时器 */
const REARM_THROTTLE_MS = 5_000;

const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "wheel", "touchstart"] as const;

/**
 * 保险库闲置自动锁定。
 *
 * 后端只有纯函数形式的自动锁定策略（vault/src/autolock.rs），此前没有任何调用方，
 * 解锁后的进程会一直持有解密后的会话密钥。这里在渲染进程侧按「无操作 15 分钟」触发锁定：
 * 锁定后再次连接会话需要重新输入主密码。
 */
export function useVaultAutoLock(timeoutMs: number = DEFAULT_IDLE_TIMEOUT_MS) {
  const vaultState = useVaultStore((s) => s.status?.state);
  const lock = useVaultStore((s) => s.lock);

  const timerRef = useRef<number | null>(null);
  const lastArmRef = useRef(0);

  useEffect(() => {
    if (vaultState !== "unlocked") return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const arm = (force = false) => {
      const now = Date.now();
      // 距上次重新计时不足 5 秒则跳过，避免高频 mousemove 反复清/设定时器
      if (!force && now - lastArmRef.current < REARM_THROTTLE_MS) return;
      lastArmRef.current = now;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void lock();
      }, timeoutMs);
    };

    const onActivity = () => arm();

    arm(true);
    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    return () => {
      clearTimer();
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, onActivity);
      }
    };
  }, [vaultState, lock, timeoutMs]);
}
