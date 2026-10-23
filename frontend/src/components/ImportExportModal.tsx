import React, { useRef, useState } from "react";
import type { ConflictStrategy, ImportPreviewReport } from "../types/ipc";
import {
  importerCommit,
  importerExportBundleEncrypted,
  importerExportBundleJson,
  importerPreviewBundleEncrypted,
  importerPreviewBundleJson,
  importerPreviewFinalShell,
  importerPreviewOpenSsh,
} from "../lib/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { formatFriendlyError } from "../lib/errors";

interface ImportExportModalProps {
  onClose: () => void;
}

/** 触发本地文件下载。元素必须挂载到 DOM，且延迟释放 URL，避免 WebView 取消下载。 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const ImportExportModal: React.FC<ImportExportModalProps> = ({ onClose }) => {
  const { loadAll } = useSessionStore();
  const [activeTab, setActiveTab] = useState<
    "openssh" | "finalshell" | "restore" | "export"
  >("openssh");

  // 输入内容
  const [inputText, setInputText] = useState("");
  const [strategy, setStrategy] = useState<ConflictStrategy>("skip");
  const [previewReport, setPreviewReport] = useState<ImportPreviewReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 导出相关状态
  const [exportPassword, setExportPassword] = useState("");

  // 恢复备份相关状态
  const [restoreFileName, setRestoreFileName] = useState("");
  const [restoreJsonText, setRestoreJsonText] = useState("");
  const [restoreBytes, setRestoreBytes] = useState<Uint8Array | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const switchTab = (tab: "openssh" | "finalshell" | "restore" | "export") => {
    setActiveTab(tab);
    setPreviewReport(null);
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handlePreview = async () => {
    if (!inputText.trim()) {
      setErrorMsg("请粘贴需要导入的文本内容");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      let report: ImportPreviewReport;
      if (activeTab === "openssh") {
        report = await importerPreviewOpenSsh(inputText, strategy);
      } else {
        report = await importerPreviewFinalShell(inputText, strategy);
      }
      setPreviewReport(report);
    } catch (e: any) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async () => {
    if (!previewReport || previewReport.candidates.length === 0) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const count = await importerCommit(previewReport.candidates);
      setSuccessMsg(`成功导入 ${count} 个会话！`);
      setPreviewReport(null);
      setInputText("");
      await loadAll();
    } catch (e: any) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleExportJson = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const json = await importerExportBundleJson();

      downloadBlob(
        new Blob([json], { type: "application/json" }),
        `openshell_backup_${new Date().toISOString().slice(0, 10)}.json`
      );
      setSuccessMsg("已成功导出 JSON 备份文件！");
    } catch (e: any) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleExportEncrypted = async () => {
    if (!exportPassword) {
      setErrorMsg("请设置加密备份的独立密码");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const bytes = await importerExportBundleEncrypted(exportPassword);
      downloadBlob(
        new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }),
        `openshell_encrypted_${new Date().toISOString().slice(0, 10)}.osvault`
      );
      setSuccessMsg("已成功导出受密码保护的 .osvault 加密归档！");
    } catch (e: any) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  // 选择备份文件：.json 直接读取文本，.osvault 读取二进制
  const handleRestoreFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);
    setPreviewReport(null);
    setRestoreFileName(file.name);
    setRestoreJsonText("");
    setRestoreBytes(null);

    try {
      if (file.name.toLowerCase().endsWith(".osvault")) {
        const buffer = await file.arrayBuffer();
        setRestoreBytes(new Uint8Array(buffer));
      } else {
        setRestoreJsonText(await file.text());
      }
    } catch (err) {
      setErrorMsg(formatFriendlyError(err));
    }
  };

  const handleRestorePreview = async () => {
    const isEncrypted = restoreBytes !== null;
    if (!isEncrypted && !restoreJsonText.trim()) {
      setErrorMsg("请先选择需要恢复的备份文件");
      return;
    }
    if (isEncrypted && !restorePassword) {
      setErrorMsg("请输入该加密归档对应的保护密码");
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const report = isEncrypted
        ? await importerPreviewBundleEncrypted(restoreBytes!, restorePassword, strategy)
        : await importerPreviewBundleJson(restoreJsonText, strategy);
      setPreviewReport(report);
    } catch (e: any) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  const previewPanel = previewReport ? (
    <div className="mt-4 border border-black/[0.08] rounded-xl p-4 bg-[#f5f5f7] space-y-3">
      <div className="flex items-center justify-between text-xs font-semibold text-[#1d1d1f] border-b border-black/[0.06] pb-2">
        <div className="flex items-center gap-3">
          <span>检测到会话: {previewReport.total} 个</span>
          <span className="text-emerald-600 font-normal">新建: {previewReport.new_count}</span>
          <span className="text-[#0071e3] font-normal">更新: {previewReport.update_count}</span>
          <span className="text-[#86868b] font-normal">跳过: {previewReport.skip_count}</span>
        </div>

        <button
          onClick={handleCommit}
          disabled={loading || previewReport.candidates.length === 0}
          className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
        >
          确认导入
        </button>
      </div>

      {previewReport.warnings.length > 0 && (
        <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-[11px] text-amber-800 space-y-1">
          {previewReport.warnings.map((w, idx) => (
            <div key={idx}>⚠️ {w}</div>
          ))}
        </div>
      )}

      <div className="max-h-48 overflow-y-auto space-y-1.5 text-xs font-mono">
        {previewReport.candidates.map((c, idx) => (
          <div
            key={idx}
            className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-black/[0.06] shadow-apple-sm"
          >
            <div className="flex items-center gap-2 truncate">
              <span className="font-semibold text-[#1d1d1f]">
                {c.input.name || "未命名"}
              </span>
              <span className="text-[#86868b] text-[11px]">
                {c.input.username}@{c.input.host}:{c.input.port || 22}
              </span>
            </div>
            <span
              className={`text-[10px] px-2 py-0.5 rounded-md uppercase font-semibold ${
                c.action === "create"
                  ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                  : c.action === "update"
                  ? "bg-blue-50 text-[#0071e3] border border-blue-200"
                  : "bg-gray-100 text-[#86868b]"
              }`}
            >
              {c.action === "create" ? "新建" : c.action === "update" ? "更新" : "跳过"}
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-3xl bg-white/95 border border-black/[0.08] rounded-2xl shadow-apple-lg flex flex-col overflow-hidden max-h-[85vh] text-[#1d1d1f] backdrop-blur-2xl animate-in zoom-in-95 duration-150">
        {/* 顶部标题栏 */}
        <div className="h-13 px-6 border-b border-black/[0.06] flex items-center justify-between bg-white/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 border border-blue-200/60 flex items-center justify-center text-[#0071e3] shadow-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8m-5 5h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 00.707.293h3.172a1 1 0 00.707-.293l2.414-2.414a1 1 0 01.707-.293H20" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#1d1d1f] tracking-tight">会话导入与数据备份</h3>
              <p className="text-[11px] text-[#86868b]">支持 OpenSSH、FinalShell 格式以及加密保险库归档</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-[#86868b] hover:text-[#1d1d1f] rounded-lg hover:bg-black/[0.05] active:scale-95 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 选项卡 (Apple 风格分段胶囊) */}
        <div className="px-6 py-2.5 bg-black/[0.02] border-b border-black/[0.06] flex items-center gap-2">
          <div className="flex bg-black/[0.06] p-0.5 rounded-xl text-xs font-medium">
            <button
              onClick={() => switchTab("openssh")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "openssh"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              OpenSSH Config
            </button>
            <button
              onClick={() => switchTab("finalshell")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "finalshell"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              FinalShell 导入
            </button>
            <button
              onClick={() => switchTab("restore")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "restore"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              恢复备份
            </button>
            <button
              onClick={() => switchTab("export")}
              className={`px-3.5 py-1.5 rounded-lg transition active:scale-[0.98] ${
                activeTab === "export"
                  ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                  : "text-[#86868b] hover:text-[#1d1d1f]"
              }`}
            >
              导出与归档备份
            </button>
          </div>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-600 flex items-center gap-2">
              <span>⚠️</span>
              <span>{errorMsg}</span>
            </div>
          )}
          {successMsg && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-700 flex items-center gap-2">
              <span>✓</span>
              <span>{successMsg}</span>
            </div>
          )}

          {activeTab === "restore" ? (
            <div className="space-y-4">
              <div className="p-4 bg-[#f5f5f7] border border-black/[0.06] rounded-xl space-y-3">
                <div>
                  <h4 className="text-xs font-semibold text-[#1d1d1f]">选择备份文件</h4>
                  <p className="text-[11px] text-[#86868b] mt-0.5">
                    支持本客户端导出的明文 .json 备份与加密 .osvault 归档
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => restoreInputRef.current?.click()}
                    className="px-3.5 py-1.5 bg-white hover:bg-black/[0.04] text-[#1d1d1f] rounded-lg text-xs font-semibold border border-black/[0.08] shadow-apple-sm transition active:scale-[0.98]"
                  >
                    浏览文件...
                  </button>
                  <span className="text-xs text-[#424245] truncate">
                    {restoreFileName || "尚未选择文件"}
                  </span>
                  <input
                    ref={restoreInputRef}
                    type="file"
                    accept=".json,.osvault"
                    onChange={handleRestoreFileChange}
                    className="hidden"
                  />
                </div>

                {restoreBytes && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-[#1d1d1f]">
                      加密归档保护密码
                    </label>
                    <input
                      type="password"
                      placeholder="输入导出该归档时设置的密码..."
                      value={restorePassword}
                      onChange={(e) => setRestorePassword(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-black/[0.1] rounded-lg text-xs text-[#1d1d1f] outline-none focus:border-[#0071e3] font-mono"
                    />
                  </div>
                )}
              </div>

              {/* 冲突解决策略 */}
              <div className="flex items-center justify-between bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                <span className="text-xs text-[#424245] font-medium">同名/同IP会话冲突策略:</span>
                <div className="flex items-center gap-4 text-xs">
                  <label className="flex items-center gap-1.5 text-[#1d1d1f] cursor-pointer">
                    <input
                      type="radio"
                      name="restoreStrategy"
                      checked={strategy === "skip"}
                      onChange={() => {
                        setStrategy("skip");
                        setPreviewReport(null);
                      }}
                      className="accent-[#0071e3]"
                    />
                    <span>跳过已有</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-[#1d1d1f] cursor-pointer">
                    <input
                      type="radio"
                      name="restoreStrategy"
                      checked={strategy === "overwrite"}
                      onChange={() => {
                        setStrategy("overwrite");
                        setPreviewReport(null);
                      }}
                      className="accent-[#0071e3]"
                    />
                    <span>覆盖已有</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-[#1d1d1f] cursor-pointer">
                    <input
                      type="radio"
                      name="restoreStrategy"
                      checked={strategy === "keep_both"}
                      onChange={() => {
                        setStrategy("keep_both");
                        setPreviewReport(null);
                      }}
                      className="accent-[#0071e3]"
                    />
                    <span>两者保留 (重命名)</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleRestorePreview}
                  disabled={loading || !restoreFileName}
                  className="px-4 py-2 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-xl text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
                >
                  {loading ? "校验中..." : "校验并预览"}
                </button>
              </div>

              {previewPanel}
            </div>
          ) : activeTab !== "export" ? (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#1d1d1f] mb-1.5">
                  {activeTab === "openssh"
                    ? "粘贴 ~/.ssh/config 文本内容"
                    : "粘贴 FinalShell JSON 导出配置"}
                </label>
                <textarea
                  rows={7}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder={
                    activeTab === "openssh"
                      ? "Host my-server\n  HostName 192.168.1.100\n  User root\n  Port 22\n  ProxyJump bastion"
                      : '{"items": [{"name": "Server1", "host": "192.168.1.100", "port": 22, "username": "root"}]}'
                  }
                  className="w-full p-3 bg-[#f5f5f7] border border-black/[0.08] rounded-xl font-mono text-xs text-[#1d1d1f] placeholder-[#86868b]/60 outline-none focus:border-[#0071e3] focus:bg-white transition resize-none"
                />
              </div>

              {/* 冲突解决策略 */}
              <div className="flex items-center justify-between bg-[#f5f5f7] p-3.5 rounded-xl border border-black/[0.06]">
                <span className="text-xs text-[#424245] font-medium">同名/同IP会话冲突策略:</span>
                <div className="flex items-center gap-4 text-xs">
                  <label className="flex items-center gap-1.5 text-[#1d1d1f] cursor-pointer">
                    <input
                      type="radio"
                      name="strategy"
                      checked={strategy === "skip"}
                      onChange={() => {
                        setStrategy("skip");
                        setPreviewReport(null);
                      }}
                      className="accent-[#0071e3]"
                    />
                    <span>跳过已有</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-[#1d1d1f] cursor-pointer">
                    <input
                      type="radio"
                      name="strategy"
                      checked={strategy === "overwrite"}
                      onChange={() => {
                        setStrategy("overwrite");
                        setPreviewReport(null);
                      }}
                      className="accent-[#0071e3]"
                    />
                    <span>覆盖已有</span>
                  </label>
                  <label className="flex items-center gap-1.5 text-[#1d1d1f] cursor-pointer">
                    <input
                      type="radio"
                      name="strategy"
                      checked={strategy === "keep_both"}
                      onChange={() => {
                        setStrategy("keep_both");
                        setPreviewReport(null);
                      }}
                      className="accent-[#0071e3]"
                    />
                    <span>两者保留 (重命名)</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handlePreview}
                  disabled={loading || !inputText.trim()}
                  className="px-4 py-2 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-xl text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
                >
                  {loading ? "分析中..." : "解析并预览"}
                </button>
              </div>

              {/* 导入预览报告 */}
              {previewPanel}
            </div>
          ) : (
            /* 导出选项卡 */
            <div className="space-y-4">
              {/* 格式 1: 明文 JSON */}
              <div className="p-4 bg-[#f5f5f7] border border-black/[0.06] rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-[#1d1d1f]">明文 JSON 导出</h4>
                    <p className="text-[11px] text-[#86868b] mt-0.5">
                      导出所有会话列表、分组、快捷命令与端口转发配置（不包含密码机密）
                    </p>
                  </div>
                  <button
                    onClick={handleExportJson}
                    disabled={loading}
                    className="px-3.5 py-1.5 bg-white hover:bg-black/[0.04] text-[#1d1d1f] rounded-lg text-xs font-semibold border border-black/[0.08] shadow-apple-sm transition active:scale-[0.98]"
                  >
                    下载 JSON
                  </button>
                </div>
              </div>

              {/* 格式 2: 加密 .osvault 归档 */}
              <div className="p-4 bg-emerald-50/40 border border-emerald-500/20 rounded-xl space-y-3">
                <div>
                  <h4 className="text-xs font-semibold text-emerald-800 flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    <span>加密归档包 (.osvault)</span>
                  </h4>
                  <p className="text-[11px] text-emerald-900/70 mt-0.5">
                    采用 Argon2id KDF + XChaCha20-Poly1305 顶级密码学封装，由独立强密码全量保护
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs text-[#1d1d1f] font-medium">设置加密包独立保护密码</label>
                  <input
                    type="password"
                    placeholder="输入强密码以加密归档..."
                    value={exportPassword}
                    onChange={(e) => setExportPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-black/[0.1] rounded-lg text-xs text-[#1d1d1f] outline-none focus:border-emerald-500 font-mono"
                  />
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    onClick={handleExportEncrypted}
                    disabled={loading || !exportPassword}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
                  >
                    导出加密 .osvault 归档
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
