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
  const { loadAll } = useSessionStore();
  const [activeTab, setActiveTab] = useState<ImportTab>("openssh");

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

  const switchTab = (tab: ImportTab) => {
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
      setSuccessMsg(`成功导入 ${count} 个会话。`);
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
    <Panel className="flex flex-col gap-3 bg-surface-muted">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-os-xs font-medium text-ink">检测到会话 {previewReport.total} 个</span>
        <Badge tone="success">新建 {previewReport.new_count}</Badge>
        <Badge tone="accent">更新 {previewReport.update_count}</Badge>
        <Badge>跳过 {previewReport.skip_count}</Badge>
        <Button
          variant="primary"
          size="sm"
          className="ml-auto"
          onClick={handleCommit}
          loading={loading}
          disabled={previewReport.candidates.length === 0}
          leading={<UploadIcon className="h-3.5 w-3.5" />}
        >
          确认导入
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
    </Panel>
  ) : null;

  return (
    <Modal
      open
      onClose={onClose}
      title="会话导入与数据备份"
      description="支持 OpenSSH、FinalShell 格式以及加密保险库归档"
      widthClassName="w-full max-w-[760px]"
      footer={
        <Button variant="secondary" onClick={onClose}>
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

        {activeTab === "restore" ? (
          <div className="flex flex-col gap-3">
            <Panel className="flex flex-col gap-3">
              <SectionHeader
                title="选择备份文件"
                description="支持本客户端导出的明文 .json 备份与加密 .osvault 归档"
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
                <Field
                  label="加密归档保护密码"
                  htmlFor="restore-password"
                  hint="请输入导出该归档时设置的密码。"
                >
                  <Input
                    id="restore-password"
                    type="password"
                    placeholder="输入归档保护密码"
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
              onChange={(next) => {
                setStrategy(next);
                setPreviewReport(null);
              }}
            />

            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={handleRestorePreview}
                loading={loading}
                disabled={!restoreFileName}
              >
                {loading ? "校验中..." : "校验并预览"}
              </Button>
            </div>

            {previewPanel}
          </div>
        ) : activeTab !== "export" ? (
          <div className="flex flex-col gap-3">
            <Field label={activeTab === "openssh" ? "粘贴 ~/.ssh/config 文本内容" : "粘贴 FinalShell JSON 导出配置"}>
              <Textarea
                rows={7}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={
                  activeTab === "openssh"
                    ? "Host my-server\n  HostName 192.168.1.100\n  User root\n  Port 22\n  ProxyJump bastion"
                    : '{"items": [{"name": "Server1", "host": "192.168.1.100", "port": 22, "username": "root"}]}'
                }
                className="font-mono text-os-xs"
              />
            </Field>

            <StrategyPicker
              strategy={strategy}
              name="strategy"
              onChange={(next) => {
                setStrategy(next);
                setPreviewReport(null);
              }}
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
                description="导出所有会话列表、分组、快捷命令与端口转发配置（不包含密码机密）"
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
                description="采用 Argon2id KDF + XChaCha20-Poly1305 封装，由独立强密码全量保护"
              />

              <Field label="设置加密包独立保护密码" htmlFor="export-password">
                <Input
                  id="export-password"
                  type="password"
                  placeholder="输入强密码以加密归档"
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
