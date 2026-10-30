import React, { useEffect } from "react";
import { useSftpStore } from "../stores/sftpStore";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";
import { SaveIcon } from "./ui/icons";

export const RemoteEditorModal: React.FC = () => {
  const { editor, updateEditorContent, saveEditor, closeEditor } = useSftpStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveEditor();
      } else if (e.key === "Escape") {
        closeEditor();
      }
    };
    if (editor.open) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [editor.open, saveEditor, closeEditor]);

  if (!editor.open) return null;

  return (
    <Modal
      open={editor.open}
      onClose={closeEditor}
      title="在线编辑"
      description={<span className="break-all font-mono">{editor.path}</span>}
      widthClassName="w-full max-w-[900px]"
      footer={
        <>
          <span className="mr-auto font-mono text-os-2xs text-ink-tertiary">
            Ctrl+S 保存 · Esc 关闭
          </span>
          <Button variant="secondary" size="sm" onClick={closeEditor}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={editor.saving}
            leading={<SaveIcon className="h-3.5 w-3.5" />}
            onClick={saveEditor}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex h-[calc(100vh-260px)] min-h-[200px] flex-col gap-2">
        {editor.error && (
          <InlineNotice tone="danger" title="操作失败">
            {editor.error}
          </InlineNotice>
        )}
        <Textarea
          value={editor.content}
          onChange={(e) => updateEditorContent(e.target.value)}
          rows={20}
          spellCheck={false}
          placeholder="输入文件内容…"
          className="min-h-0 flex-1 !resize-none bg-surface-muted font-mono text-os-xs leading-relaxed"
        />
      </div>
    </Modal>
  );
};
