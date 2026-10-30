import React, { useEffect, useState } from "react";
import type { SftpFileEntry } from "../types/ipc";
import { formatFriendlyError } from "../lib/errors";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { Panel } from "./ui/Surface";
import { InlineNotice } from "./ui/Notice";
import { FileIcon, FolderIcon, TriangleAlertIcon } from "./ui/icons";

interface DeleteConfirmModalProps {
  isOpen: boolean;
  entries: SftpFileEntry[];
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  entries,
  onConfirm,
  onClose,
}) => {
  const [deleting, setDeleting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) setErrorMsg(null);
  }, [isOpen]);

  if (!isOpen || entries.length === 0) return null;

  const folderCount = entries.filter((e) => e.file_type === "directory").length;
  const isHighRisk = folderCount > 0;
  const isCriticalSystemPath = entries.some((e) =>
    ["/", "/etc", "/usr", "/var", "/bin", "/sbin", "/boot", "/lib"].includes(e.path)
  );

  const handleDelete = async () => {
    setDeleting(true);
    setErrorMsg(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="删除远程文件"
      description={`确认永久删除选中的 ${entries.length} 个项目，此操作不可撤销。`}
      widthClassName="w-full max-w-[480px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={deleting}>
            取消
          </Button>
          <Button variant="danger" onClick={handleDelete} loading={deleting}>
            确认永久删除
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {isHighRisk && (
          <InlineNotice tone="warning" title={`包含 ${folderCount} 个文件夹`}>
            删除文件夹会递归永久删除其内部的全部子文件与子目录，数据不可撤销。
          </InlineNotice>
        )}

        {isCriticalSystemPath && (
          <InlineNotice tone="danger" title="检测到系统关键路径">
            正在删除操作系统核心路径，可能导致远程主机无法正常运行，请谨慎确认。
          </InlineNotice>
        )}

        <Field label="待删除项目">
          <Panel padded={false} className="max-h-32 overflow-y-auto p-2">
            <ul className="flex flex-col gap-0.5">
              {entries.slice(0, 5).map((e) => (
                <li
                  key={e.path}
                  className="flex items-center gap-1.5 rounded-os-sm px-1.5 py-1 text-os-xs"
                >
                  {e.file_type === "directory" ? (
                    <FolderIcon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
                  ) : (
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" />
                  )}
                  <span className="truncate font-medium text-ink">{e.name}</span>
                  <span className="ml-auto shrink-0 truncate font-mono text-os-2xs text-ink-tertiary">
                    {e.path}
                  </span>
                </li>
              ))}
              {entries.length > 5 && (
                <li className="px-1.5 py-1 pl-6 text-os-2xs italic text-ink-tertiary">
                  以及另外 {entries.length - 5} 个项目
                </li>
              )}
            </ul>
          </Panel>
        </Field>

        {errorMsg && (
          <InlineNotice tone="danger" title="删除未完成">
            {errorMsg}
          </InlineNotice>
        )}

        {isCriticalSystemPath && (
          <div className="flex items-center gap-1.5 text-os-2xs text-state-danger">
            <TriangleAlertIcon className="h-3.5 w-3.5" />
            请再次确认目标路径无误
          </div>
        )}
      </div>
    </Modal>
  );
};
