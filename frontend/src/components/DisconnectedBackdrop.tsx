import React, { useEffect, useState } from "react";
import { formatCountdown } from "../lib/backoff";
import { Button } from "./ui/Button";
import { RefreshIcon, TriangleAlertIcon } from "./ui/icons";

interface DisconnectedBackdropProps {
  reason?: string;
  isSerial?: boolean;
  onReconnect: () => void;
  reconnecting?: boolean;
  /** 远端进程退出码（未知时为 null/undefined） */
  exitCode?: number | null;
  /** 自动重连：当前第几次 / 上限 */
  attempt?: number;
  maxAttempts?: number;
  /** 下一次自动重连的时间戳（毫秒） */
  nextRetryAt?: number;
  /** 用户取消自动重连 */
  onCancelAutoReconnect?: () => void;
}

export const DisconnectedBackdrop: React.FC<DisconnectedBackdropProps> = ({
  reason,
  isSerial = false,
  onReconnect,
  reconnecting = false,
  exitCode,
  attempt,
  maxAttempts,
  nextRetryAt,
  onCancelAutoReconnect,
}) => {
  // 倒计时：只有自动重连排队时才需要每秒刷新
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!nextRetryAt) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(nextRetryAt - Date.now());
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [nextRetryAt]);

  const autoRetrying = !!nextRetryAt && remaining > 0;
  const hasExitCode = typeof exitCode === "number";

  return (
    <div className="absolute inset-0 z-30 flex select-none items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm animate-[fade-in_180ms_var(--os-ease)]">
      <div className="flex w-full max-w-md flex-col items-center rounded-os-xl border border-line/10 bg-surface p-6 text-center shadow-os-lg">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-os-lg border border-state-danger/20 bg-state-danger/10 text-state-danger">
          <TriangleAlertIcon className="h-6 w-6" />
        </div>

        <h3 className="text-os-md font-semibold text-ink">
          {isSerial ? "串口已断开连接" : "会话已断开连接"}
        </h3>

        <p className="mt-2 max-w-full break-words rounded-os-sm border border-line/10 bg-surface-muted px-3 py-1.5 font-mono text-os-xs text-ink-secondary">
          {reason ||
            (isSerial ? "USB 串口设备已被拔出或被占用" : "与远端服务器的网络连接已重置或断开")}
        </p>

        {hasExitCode && <p className="mt-2 text-os-xs text-ink-secondary">远端进程退出码：{exitCode}</p>}
        {autoRetrying && (
          <p className="mt-2 text-os-xs text-ink-secondary">
            正在自动重连（第 {attempt} / {maxAttempts} 次），{formatCountdown(remaining)} 后重试…
          </p>
        )}

        <p className="mb-6 mt-3 max-w-[300px] text-os-xs leading-relaxed text-ink-tertiary">
          终端输出与视图状态已保留。检查网络或重新插上设备后，可一键恢复连接。
        </p>

        <Button
          variant="primary"
          leading={<RefreshIcon className="h-4 w-4" />}
          loading={reconnecting}
          onClick={onReconnect}
        >
          立即重新连接
        </Button>
        {autoRetrying && onCancelAutoReconnect && (
          <button onClick={onCancelAutoReconnect} className="mt-3 text-os-xs text-ink-secondary">
            取消自动重连
          </button>
        )}
      </div>
    </div>
  );
};
