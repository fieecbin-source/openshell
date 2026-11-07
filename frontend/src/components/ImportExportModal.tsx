import React, { useEffect, useRef, useState } from "react";
import type { ConflictStrategy, ImportPreviewReport } from "../types/ipc";
import {
  importerCommit,
  importerDiscardPreview,
  importerExportBundleEncrypted,
  importerExportBundleJson,
  importerPreviewBundleEncrypted,
  importerPreviewBundleJson,
  importerPreviewFinalShell,
  importerPreviewOpenSsh,
} from "../lib/ipc";
import { useSessionStore } from "../stores/sessionStore";
import { useSnippetStore } from "../stores/snippetStore";
import { formatFriendlyError } from "../lib/errors";
import { Button } from "./ui/Button";
import { Field, Input, Textarea } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { Badge, Panel, SectionHeader } from "./ui/Surface";
import { Segmented, Radio } from "./ui/Controls";
import { InlineNotice } from "./ui/Notice";
import {
  DownloadIcon,
  FileIcon,
  FolderOpenIcon,
  LockIcon,
  RefreshIcon,
  UploadIcon,
} from "./ui/icons";

interface ImportExportModalProps {
  onClose: () => void;
}

const discardArchiveToken = async (token?: string | null) => {
  if (!token) return;
  try {
    await importerDiscardPreview(token);
  } catch (e) {
    console.warn("Failed to discard archive preview token:", e);
  }
};

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

type ImportTab = "openssh" | "finalshell" | "restore" | "export";

function StrategyPicker({
  strategy,
  name,
  onChange,
}: {
  strategy: ConflictStrategy;
  name: string;
  onChange: (next: ConflictStrategy) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-os-xs font-medium text-ink-secondary">同名 / 同 IP 会话冲突策略</span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Radio
          name={name}
          label="跳过已有"
          checked={strategy === "skip"}
          onChange={() => onChange("skip")}
        />
        <Radio
          name={name}
          label="覆盖已有"
          checked={strategy === "overwrite"}
          onChange={() => onChange("overwrite")}
        />
        <Radio
          name={name}
          label="两者保留（重命名）"
          checked={strategy === "keep_both"}
          onChange={() => onChange("keep_both")}
        />
      </div>
    </div>
  );
}

export const ImportExportModal: React.FC<ImportExportModalProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState<ImportTab>("openssh");

  // 输入内容
  const [inputText, setInputText] = useState("");
  const [strategy, setStrategy] = useState<ConflictStrategy>("skip");
  const [previewReport, setPreviewReport] = useState<ImportPreviewReport | null>(null);
  const [committedWarnings, setCommittedWarnings] = useState<string[]>([]);
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
  const [readingFile, setReadingFile] = useState(false);
  const [readingFileName, setReadingFileName] = useState("");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  const activeTokenRef = useRef<string | null>(null);
  const committingTokenRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    activeTokenRef.current = previewReport?.archive_token ?? null;
  }, [previewReport]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const activeToken = activeTokenRef.current;
      const committingToken = committingTokenRef.current;
      if (activeToken && activeToken !== committingToken) {
        void discardArchiveToken(activeToken);
      }
    };
  }, []);

  const invalidatePendingOperations = () => {
    generationRef.current++;
    const currentPreviewToken = previewReport?.archive_token;
    if (currentPreviewToken && currentPreviewToken !== committingTokenRef.current) {
      void discardArchiveToken(currentPreviewToken);
    }
    setPreviewReport(null);
    setLoading(false);
    setReadingFile(false);
    setReadingFileName("");
  };

  const handleClose = () => {
    invalidatePendingOperations();
    onClose();
  };

  const switchTab = (tab: ImportTab) => {
    invalidatePendingOperations();
    setActiveTab(tab);
    setCommittedWarnings([]);
    setErrorMsg(null);
    setSuccessMsg(null);
    setRefreshError(null);
  };

  const handleStrategyChange = (next: ConflictStrategy) => {
    invalidatePendingOperations();
    setStrategy(next);
  };

  const handleRefreshAfterCommit = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await Promise.all([
        useSessionStore.getState().loadAll({ throwOnError: true }),
        useSnippetStore.getState().loadSnippets(),
      ]);
      setRefreshError(null);
    } catch (refreshErr: any) {
      console.warn("View refresh failed:", refreshErr);
      setRefreshError(formatFriendlyError(refreshErr));
    } finally {
      setRefreshing(false);
    }
  };

  const handlePreview = async () => {
    if (!inputText.trim()) {
      setErrorMsg("请粘贴需要导入的文本内容");
      return;
    }
    const currentGen = ++generationRef.current;
    const currentPreviewToken = previewReport?.archive_token;
    if (currentPreviewToken && currentPreviewToken !== committingTokenRef.current) {
      void discardArchiveToken(currentPreviewToken);
    }
    setPreviewReport(null);
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setRefreshError(null);
    setCommittedWarnings([]);
    try {
      let report: ImportPreviewReport;
      if (activeTab === "openssh") {
        report = await importerPreviewOpenSsh(inputText, strategy);
      } else {
        report = await importerPreviewFinalShell(inputText, strategy);
      }
      if (!mountedRef.current || generationRef.current !== currentGen) {
        if (report?.archive_token && report.archive_token !== committingTokenRef.current) {
          void discardArchiveToken(report.archive_token);
        }
        return;
      }
      setPreviewReport(report);
    } catch (e: any) {
      if (mountedRef.current && generationRef.current === currentGen) {
        setErrorMsg(formatFriendlyError(e));
      }
    } finally {
      if (mountedRef.current && generationRef.current === currentGen) {
        setLoading(false);
      }
    }
  };

  const handleCommit = async () => {
    if (!previewReport || (previewReport.candidates.length === 0 && !previewReport.archive_token)) return;
    const commitToken = previewReport.archive_token ?? null;
    const candidates = previewReport.candidates;
    const warnings = previewReport.warnings || [];
    const commitGen = ++generationRef.current;
    committingTokenRef.current = commitToken;

    setLoading(true);
    setErrorMsg(null);
    setRefreshError(null);

    let commitSucceeded = false;
    let count = 0;

    try {
      count = await importerCommit(candidates, commitToken ?? undefined);
      commitSucceeded = true;

      if (mountedRef.current && generationRef.current === commitGen) {
        setCommittedWarnings(warnings);
        setSuccessMsg(
          commitToken
            ? `已成功恢复 ${count} 个会话及对应归档配置。`
            : `成功导入 ${count} 个会话。`
        );
        setPreviewReport(null);
        setInputText("");
        setRestoreJsonText("");
        setRestoreBytes(null);
        setRestoreFileName("");
      }

      // Requirement 1: "提交成功仍完成应有全局读刷新。关闭/卸载同理。"
      try {
        await Promise.all([
          useSessionStore.getState().loadAll({ throwOnError: true }),
          useSnippetStore.getState().loadSnippets(),
        ]);
      } catch (refreshErr: any) {
        console.warn("Commit succeeded but view refresh failed:", refreshErr);
        if (mountedRef.current && generationRef.current === commitGen) {
          setRefreshError(formatFriendlyError(refreshErr));
        }
      }
    } catch (e: any) {
      if (mountedRef.current && generationRef.current === commitGen) {
        setErrorMsg(formatFriendlyError(e));
      } else if (!commitSucceeded && commitToken) {
        void discardArchiveToken(commitToken);
      }
    } finally {
      if (committingTokenRef.current === commitToken) {
        committingTokenRef.current = null;
      }
      if (mountedRef.current && generationRef.current === commitGen) {
        setLoading(false);
      }
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
      setSuccessMsg("已导出 JSON 备份文件。");
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
      setSuccessMsg("已导出受密码保护的 .osvault 加密归档。");
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

    const currentGen = ++generationRef.current;
    const currentPreviewToken = previewReport?.archive_token;
    if (currentPreviewToken && currentPreviewToken !== committingTokenRef.current) {
      void discardArchiveToken(currentPreviewToken);
    }
    setErrorMsg(null);
    setSuccessMsg(null);
    setCommittedWarnings([]);
    setPreviewReport(null);
    setLoading(false);
    setReadingFile(true);
    setReadingFileName(file.name);
    setRestorePassword("");

    try {
      if (file.name.toLowerCase().endsWith(".osvault")) {
        const buffer = await file.arrayBuffer();
        if (!mountedRef.current || generationRef.current !== currentGen) return;
        setRestoreBytes(new Uint8Array(buffer));
        setRestoreJsonText("");
        setRestoreFileName(file.name);
      } else {
        const text = await file.text();
        if (!mountedRef.current || generationRef.current !== currentGen) return;
        setRestoreJsonText(text);
        setRestoreBytes(null);
        setRestoreFileName(file.name);
      }
    } catch (err) {
      if (mountedRef.current && generationRef.current === currentGen) {
        setRestoreFileName("");
        setRestoreJsonText("");
        setRestoreBytes(null);
        setErrorMsg(formatFriendlyError(err));
      }
    } finally {
      if (mountedRef.current && generationRef.current === currentGen) {
        setReadingFile(false);
        setReadingFileName("");
      }
    }
  };

  const isRestoreReady =
    !readingFile &&
    !!restoreFileName &&
    (restoreBytes !== null
      ? restoreFileName.toLowerCase().endsWith(".osvault")
      : restoreJsonText.trim().length > 0 && !restoreFileName.toLowerCase().endsWith(".osvault"));

  const handleRestorePreview = async () => {
    const isEncrypted = restoreBytes !== null;
    if (!restoreFileName) {
      setErrorMsg("请先选择需要恢复的备份文件");
      return;
    }
    if (isEncrypted && !restoreFileName.toLowerCase().endsWith(".osvault")) {
      setErrorMsg("备份文件与内容类型不匹配，请重新选择文件");
      return;
    }
    if (!isEncrypted && (restoreFileName.toLowerCase().endsWith(".osvault") || !restoreJsonText.trim())) {
      setErrorMsg("备份文件与内容类型不匹配，请重新选择文件");
      return;
    }
    if (isEncrypted && !restorePassword) {
      setErrorMsg("请输入该加密归档对应的保护密码");
      return;
    }

    const currentGen = ++generationRef.current;
    const currentPreviewToken = previewReport?.archive_token;
    if (currentPreviewToken && currentPreviewToken !== committingTokenRef.current) {
      void discardArchiveToken(currentPreviewToken);
    }
    setPreviewReport(null);
    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    setRefreshError(null);
    setCommittedWarnings([]);
    try {
      const report = isEncrypted
        ? await importerPreviewBundleEncrypted(restoreBytes!, restorePassword, strategy)
        : await importerPreviewBundleJson(restoreJsonText, strategy);

      if (!mountedRef.current || generationRef.current !== currentGen) {
        if (report?.archive_token && report.archive_token !== committingTokenRef.current) {
          void discardArchiveToken(report.archive_token);
        }
        return;
      }
      setPreviewReport(report);
    } catch (e: any) {
      if (mountedRef.current && generationRef.current === currentGen) {
        setErrorMsg(formatFriendlyError(e));
      }
    } finally {
      if (mountedRef.current && generationRef.current === currentGen) {
        setLoading(false);
      }
    }
  };

  const previewPanel = previewReport ? (
    <Panel className="flex flex-col gap-3 bg-surface-muted">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-os-xs font-medium text-ink">
          {previewReport.total > 0
            ? `检测到会话 ${previewReport.total} 个`
            : "检测到归档配置数据（片段/分组/密钥/代理等）"}
        </span>
        {previewReport.total > 0 && (
          <>
            <Badge tone="success">新建 {previewReport.new_count}</Badge>
            <Badge tone="accent">更新 {previewReport.update_count}</Badge>
            <Badge>跳过 {previewReport.skip_count}</Badge>
          </>
        )}
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          onClick={handleCommit}
          loading={loading}
          disabled={previewReport.candidates.length === 0 && !previewReport.archive_token}
          leading={<UploadIcon className="h-3.5 w-3.5" />}
        >
          {activeTab === "restore" ? "确认恢复" : "确认导入"}
        </Button>
      </div>

      {previewReport.warnings.length > 0 && (
        <InlineNotice tone="warning" title="导入提示">
          <ul className="flex flex-col gap-0.5">
            {previewReport.warnings.map((w, idx) => (
              <li key={idx}>{w}</li>
            ))}
          </ul>
        </InlineNotice>
      )}

      {previewReport.candidates.length > 0 ? (
        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {previewReport.candidates.map((c, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-3 rounded-os-md border border-line/10 bg-surface px-2.5 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileIcon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
                <span className="truncate text-os-xs font-medium text-ink">
                  {c.input.name || "未命名"}
                </span>
                <span className="truncate font-mono text-os-2xs text-ink-tertiary">
                  {c.input.username}@{c.input.host}:{c.input.port || 22}
                </span>
              </div>
              <Badge
                tone={
                  c.action === "create" ? "success" : c.action === "update" ? "accent" : "neutral"
                }
                className="shrink-0"
              >
                {c.action === "create" ? "新建" : c.action === "update" ? "更新" : "跳过"}
              </Badge>
            </div>
          ))}
        </div>
      ) : (
        <div className="py-2 text-os-xs text-ink-tertiary">
          此备份不含普通会话条目，仅包含归档配置（片段/分组/密钥/代理等），可点击上方按钮直接恢复。
        </div>
      )}
    </Panel>
  ) : null;

  return (
    <Modal
      open
      onClose={handleClose}
      title="会话导入与数据备份"
      widthClassName="w-full max-w-[760px]"
      footer={
        <Button variant="secondary" onClick={handleClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          value={activeTab}
          onChange={switchTab}
          ariaLabel="导入导出方式"
          options={[
            { value: "openssh", label: "OpenSSH 配置" },
            { value: "finalshell", label: "FinalShell 导入" },
            { value: "restore", label: "恢复备份" },
            { value: "export", label: "导出与归档" },
          ]}
        />

        {errorMsg && (
          <InlineNotice tone="danger" title="操作未完成" onDismiss={() => setErrorMsg(null)}>
            {errorMsg}
          </InlineNotice>
        )}
        {successMsg && (
          <InlineNotice tone="success" title="操作成功" onDismiss={() => setSuccessMsg(null)}>
            {successMsg}
          </InlineNotice>
        )}
        {committedWarnings.length > 0 && (
          <InlineNotice tone="warning" title="已导入会话的待补录依赖">
            <ul className="flex flex-col gap-0.5">
              {committedWarnings.map((w, idx) => (
                <li key={idx}>{w}</li>
              ))}
            </ul>
          </InlineNotice>
        )}
        {refreshError && (
          <InlineNotice
            tone="warning"
            title="操作已成功、刷新失败"
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={refreshing}
                onClick={handleRefreshAfterCommit}
              >
                重试刷新
              </Button>
            }
          >
            {`数据已成功保存，但本地视图刷新失败（${refreshError}）。您可以点击重试刷新。`}
          </InlineNotice>
        )}

        {activeTab === "restore" ? (
          <div className="flex flex-col gap-3">
            <Panel className="flex flex-col gap-3">
              <SectionHeader
                title="选择备份文件"
              />

              <div className="flex items-center gap-2.5">
                <Button
                  variant="secondary"
                  size="sm"
                  leading={<FolderOpenIcon className="h-3.5 w-3.5" />}
                  onClick={() => restoreInputRef.current?.click()}
                >
                  浏览文件
                </Button>
                <span className="truncate text-os-xs text-ink-secondary">
                  {readingFile ? `${readingFileName} (读取中...)` : restoreFileName || "尚未选择文件"}
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
                <Field
                  label="加密归档保护密码"
                  htmlFor="restore-password"
                  required value={restorePassword}
                >
                  <Input
                    id="restore-password"
                    type="password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    mono
                  />
                </Field>
              )}
            </Panel>

            <StrategyPicker
              strategy={strategy}
              name="restoreStrategy"
              onChange={handleStrategyChange}
            />

            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={handleRestorePreview}
                loading={loading || readingFile}
                disabled={!isRestoreReady || loading || readingFile}
              >
                {loading ? "校验中..." : readingFile ? "读取中..." : "校验并预览"}
              </Button>
            </div>

            {previewPanel}
          </div>
        ) : activeTab !== "export" ? (
          <div className="flex flex-col gap-3">
            <Field label={activeTab === "openssh" ? "OpenSSH 配置" : "FinalShell 配置"} required value={inputText}>
              <Textarea
                rows={7}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                aria-label="导入配置"
                className="font-mono text-os-xs"
              />
            </Field>

            <StrategyPicker
              strategy={strategy}
              name="strategy"
              onChange={handleStrategyChange}
            />

            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={handlePreview}
                loading={loading}
                disabled={!inputText.trim()}
              >
                {loading ? "分析中..." : "解析并预览"}
              </Button>
            </div>

            {previewPanel}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Panel className="flex flex-col gap-2">
              <SectionHeader
                title="明文 JSON 导出"
                actions={
                  <Button
                    variant="secondary"
                    size="sm"
                    leading={<DownloadIcon className="h-3.5 w-3.5" />}
                    onClick={handleExportJson}
                    disabled={loading}
                  >
                    下载 JSON
                  </Button>
                }
              />
            </Panel>

            <Panel className="flex flex-col gap-3">
              <SectionHeader
                title={
                  <span className="inline-flex items-center gap-1.5">
                    <LockIcon className="h-4 w-4 text-state-success" />
                    加密归档包 (.osvault)
                  </span>
                }
              />

              <Field label="归档密码" htmlFor="export-password" required value={exportPassword}>
                <Input
                  id="export-password"
                  type="password"
                  value={exportPassword}
                  onChange={(e) => setExportPassword(e.target.value)}
                  mono
                />
              </Field>

              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  leading={<LockIcon className="h-3.5 w-3.5" />}
                  onClick={handleExportEncrypted}
                  loading={loading}
                  disabled={!exportPassword}
                >
                  导出加密归档
                </Button>
              </div>
            </Panel>

            <div className="flex items-center gap-1.5 text-os-2xs text-ink-tertiary">
              <RefreshIcon className="h-3.5 w-3.5" />
              加密归档可连同密码凭据一起迁移到其他设备
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
