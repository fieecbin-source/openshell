import React from "react";

interface DisconnectedBackdropProps {
  reason?: string;
  isSerial?: boolean;
  onReconnect: () => void;
  reconnecting?: boolean;
}

export const DisconnectedBackdrop: React.FC<DisconnectedBackdropProps> = ({
  reason,
  isSerial = false,
  onReconnect,
  reconnecting = false,
}) => {
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-surface-950/70 backdrop-blur-sm p-6 select-none animate-in fade-in duration-200">
      <div className="max-w-md w-full rounded-2xl border border-red-500/30 bg-surface-900/95 p-6 shadow-2xl text-center flex flex-col items-center">
        {/* 盾牌警告图标 */}
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400 border border-red-500/20 mb-4 shadow-lg shadow-red-950/50">
          <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.75}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>

        <h3 className="text-base font-bold text-white mb-1.5">
          {isSerial ? "串口已断开连接" : "会话已断开连接"}
        </h3>

        <p className="text-xs text-red-300 font-mono mb-4 px-3 py-1.5 rounded bg-red-950/40 border border-red-900/50 max-w-full break-words">
          {reason || (isSerial ? "USB 串口设备已被拔出或被占用" : "与远端服务器的网络连接已重置或断开")}
        </p>

        <p className="text-xs text-slate-400 mb-6 max-w-xs">
          终端输出与视图卡状态已被保留。检查网络或重新插上设备后，点击下方按钮即可一键恢复。
        </p>

        <button
          onClick={onReconnect}
          disabled={reconnecting}
          className="flex items-center space-x-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-950 hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          {reconnecting ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>正在重新连接...</span>
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>立即重新连接</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
