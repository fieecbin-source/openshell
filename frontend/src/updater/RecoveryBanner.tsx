import React, { useState } from "react";
import { UPDATE_COPY, formatMoment } from "./copy";
import { useUpdaterStore } from "./store";

/**
 * 数据恢复提示条。
 *
 * 触发条件：启动时 schema 迁移失败并已从快照回滚（`AppInfo.degraded`），
 * 或运行时状态里仍保留着 `recovery` 记录。提示条会带上快照路径与时间，
 * 帮助用户确认数据来源；关闭只影响本次会话，不修改任何数据。
 */
export const RecoveryBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);
  const runtime = useUpdaterStore((s) => s.runtime);
  const appInfo = useUpdaterStore((s) => s.appInfo);

  const recovery = runtime?.recovery;
  const degraded = Boolean(appInfo?.degraded) || Boolean(recovery);
  if (!degraded || dismissed) return null;

  return (
    <div className="relative z-10 flex shrink-0 items-start gap-2 border-b border-[#ff9f0a]/30 bg-[#ff9f0a]/[0.10] px-3 py-1.5">
      <span className="mt-0.5 text-[#8a5a00]">
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
      </span>
      <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-[#5c3d00]">
        <span className="font-semibold">{UPDATE_COPY.recovery.title}</span>
        <span className="ml-1">{UPDATE_COPY.recovery.body}</span>
        {recovery && (
          <span className="ml-1 font-mono text-[10px] text-[#8a5a00]">
            {UPDATE_COPY.recovery.path}
            {recovery.backup_path} · {formatMoment(recovery.created_at_ms)}
          </span>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded-lg px-1.5 py-0.5 text-[11px] font-medium text-[#8a5a00] transition hover:bg-[#ff9f0a]/[0.15] active:scale-[0.98]"
      >
        {UPDATE_COPY.modal.close}
      </button>
    </div>
  );
};
