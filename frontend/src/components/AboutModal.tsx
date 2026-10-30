import React, { useState } from "react";
import { Modal } from "./ui/Overlay";
import { Button } from "./ui/Button";
import { Switch } from "./ui/Controls";
import { useUpdaterStore } from "../updater/store";
import { openUrl } from "@tauri-apps/plugin-opener";

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ open, onClose }) => {
  const check = useUpdaterStore((s) => s.check);
  const autoCheck = useUpdaterStore((s) => s.config.auto_check);
  const patchConfig = useUpdaterStore((s) => s.patchConfig);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState<string | null>(null);

  if (!open) return null;

  const handleManualCheck = async () => {
    setChecking(true);
    setCheckMsg(null);
    try {
      await check(true);
      setCheckMsg("已完成版本检查");
    } catch {
      setCheckMsg("检查更新失败，请稍后重试");
    } finally {
      setChecking(false);
    }
  };

  const openExternal = (url: string) => {
    openUrl(url).catch((err) => {
      console.warn("Failed to open URL:", err);
      window.open(url, "_blank");
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="关于 OpenShell"
      description="无限速 · 功能简约 · 跨平台 · 开源免费"
      widthClassName="w-full max-w-[460px]"
    >
      <div className="space-y-4">
        {/* 应用标志与版本 */}
        <div className="flex items-center gap-3.5 rounded-xl border border-line/10 bg-surface p-4 shadow-apple-sm">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0071e3] to-[#2563eb] text-white shadow-apple-sm font-mono text-xl font-bold">
            &gt;_
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-ink">OpenShell</h3>
              <span className="rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-accent">
                v1.1.1
              </span>
            </div>
            <p className="mt-0.5 text-xs text-ink-secondary">
              企业级轻量跨平台 SSH / SFTP 终端客户端
            </p>
          </div>
        </div>

        {/* 详细信息表格 */}
        <div className="rounded-xl border border-line/10 bg-surface divide-y divide-line/5 text-xs">
          <div className="flex items-center justify-between p-3">
            <span className="text-ink-secondary">开源许可证</span>
            <span className="font-medium text-ink">Apache License 2.0</span>
          </div>
          <div className="flex items-center justify-between p-3">
            <span className="text-ink-secondary">开源代码仓库</span>
            <button
              onClick={() => openExternal("https://github.com/fieecbin-source/openshell")}
              className="text-accent hover:underline flex items-center gap-1 font-mono"
            >
              GitHub ↗
            </button>
          </div>
          <div className="flex items-center justify-between p-3">
            <span className="text-ink-secondary">问题反馈与功能建议</span>
            <button
              onClick={() => openExternal("https://github.com/fieecbin-source/openshell/issues")}
              className="text-accent hover:underline flex items-center gap-1 font-mono"
            >
              Issue Tracker ↗
            </button>
          </div>
          <div className="p-3">
            <Switch
              checked={autoCheck}
              onChange={(val) => patchConfig({ auto_check: val })}
              label="启动时自动检查更新"
              hint="关闭后仅在手动点击「检查更新」时连接检测"
            />
          </div>
        </div>

        {checkMsg && (
          <div className="p-2 rounded-lg bg-surface text-center text-xs text-ink-secondary border border-line/10">
            {checkMsg}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <Button
            variant="secondary"
            size="sm"
            loading={checking}
            onClick={handleManualCheck}
          >
            {checking ? "检查中..." : "立即检查更新"}
          </Button>
          <Button variant="primary" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </Modal>
  );
};
