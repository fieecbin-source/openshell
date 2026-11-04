import React, { useEffect, useState } from "react";
import { useSnippetStore } from "../stores/snippetStore";
import { useTerminalStore } from "../stores/terminalStore";
import type { SendMode, Snippet } from "../types/ipc";
import { writeTerminal } from "../lib/ipc";
import { SAVE_SNIPPET_EVENT } from "../lib/terminal-actions";
import { toast } from "../stores/toastStore";
import { Button, IconButton } from "./ui/Button";
import { Field, Input, Textarea } from "./ui/Field";
import { Segmented } from "./ui/Controls";
import { Modal } from "./ui/Overlay";
import {
  CommandIcon,
  PlusIcon,
  SendIcon,
  XIcon,
} from "./ui/icons";

interface SnippetBarProps {
  activeTabId: string | null;
}

export const SnippetBar: React.FC<SnippetBarProps> = ({ activeTabId }) => {
  const connected = useTerminalStore((state) => state.tabs.some((tab) => tab.tabId === activeTabId && tab.status === "connected"));
  const { snippets, loadSnippets, createSnippet, deleteSnippet } = useSnippetStore();
  const [paramModal, setParamModal] = useState<{
    snippet: Snippet;
    params: { name: string; defaultValue: string; value: string }[];
  } | null>(null);

  const [createModal, setCreateModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCmd, setNewCmd] = useState("");
  const [newSendMode, setNewSendMode] = useState<SendMode>("execute");

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  useEffect(() => {
    const saveSelection = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (!command?.trim()) return;
      setNewName("");
      setNewCmd(command);
      setNewSendMode("insert");
      setCreateModal(true);
    };
    window.addEventListener(SAVE_SNIPPET_EVENT, saveSelection);
    return () => window.removeEventListener(SAVE_SNIPPET_EVENT, saveSelection);
  }, []);

  // 解析命令模板中的占位符，例如 ${PORT:-8080} 或 ${HOST}
  const parsePlaceholders = (template: string) => {
    const regex = /\$\{([a-zA-Z0-9_]+)(?::-(.*?))?\}/g;
    const matches: { name: string; defaultValue: string; value: string }[] = [];
    const seen = new Set<string>();

    let match;
    while ((match = regex.exec(template)) !== null) {
      const name = match[1];
      const defaultValue = match[2] || "";
      if (!seen.has(name)) {
        seen.add(name);
        matches.push({ name, defaultValue, value: defaultValue });
      }
    }
    return matches;
  };

  const handleSnippetClick = (snippet: Snippet) => {
    if (!activeTabId) return;

    const placeholders = parsePlaceholders(snippet.command_template);
    if (placeholders.length > 0) {
      setParamModal({ snippet, params: placeholders });
    } else {
      executeCommand(snippet.command_template, snippet.send_mode);
    }
  };

  const executeCommand = (cmd: string, mode: SendMode) => {
    if (!activeTabId) return;
    const finalCmd = mode === "execute" ? `${cmd}\n` : cmd;
    const bytes = new TextEncoder().encode(finalCmd);
    writeTerminal(activeTabId, bytes)
      .then(() => toast.success(mode === "execute" ? "命令已发送并执行" : "命令已插入，按回车执行"))
      .catch(() => toast.error("发送失败，请确认终端仍处于连接状态"));
  };

  const handleApplyParams = () => {
    if (!paramModal || !activeTabId) return;
    let finalCmd = paramModal.snippet.command_template;
    for (const p of paramModal.params) {
      const val = p.value || p.defaultValue || "";
      const regex = new RegExp(`\\$\\{${p.name}(?::-.*?)?\\}`, "g");
      finalCmd = finalCmd.replace(regex, val);
    }
    executeCommand(finalCmd, paramModal.snippet.send_mode);
    setParamModal(null);
  };

  const handleCreateSnippet = async () => {
    if (!newName.trim() || !newCmd.trim()) return;
    await createSnippet({
      name: newName.trim(),
      command_template: newCmd.trim(),
      send_mode: newSendMode,
    });
    setNewName("");
    setNewCmd("");
    setCreateModal(false);
  };

  return (
    <div className="flex h-8 shrink-0 select-none items-center gap-2 overflow-x-auto border-b border-line/10 bg-surface-muted px-3">
      <div className="flex shrink-0 items-center gap-1.5">
        <CommandIcon className="h-3.5 w-3.5 text-ink-tertiary" />
        <span className="text-os-2xs font-semibold text-ink-secondary">快捷片段</span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {snippets.length === 0 ? (
          <span className="text-os-2xs text-ink-tertiary">点击右侧按钮添加常用命令快捷方式</span>
        ) : (
          snippets.map((snip) => (
            <div
              key={snip.id}
              className="group flex h-6 max-w-[200px] shrink-0 items-center gap-0.5 overflow-hidden rounded-full border border-line/10 bg-surface pl-2 pr-1 shadow-os-sm transition-colors duration-os hover:border-accent/25 hover:bg-accent/5"
            >
              <button
                type="button"
                disabled={!connected}
                onClick={() => handleSnippetClick(snip)}
                title={`${snip.name}\n${snip.command_template}`}
                aria-label={snip.name}
                className="min-w-0 max-w-[160px] truncate rounded-full px-1 text-left text-os-2xs font-medium leading-5 text-ink-secondary transition-colors duration-os hover:text-accent disabled:opacity-40"
              >
                {snip.name}
              </button>
              <IconButton
                label="删除片段"
                size="sm"
                className="!h-4 !w-4 shrink-0 !rounded-full text-ink-tertiary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-state-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSnippet(snip.id);
                }}
              >
                <XIcon className="h-3 w-3" />
              </IconButton>
            </div>
          ))
        )}
      </div>

      <Button
        variant="secondary"
        size="sm"
        className="h-[24px] shrink-0 px-2"
        leading={<PlusIcon className="h-3 w-3" />}
        onClick={() => setCreateModal(true)}
      >
        新增
      </Button>

      {/* 参数占位符填充弹窗 */}
      <Modal
        open={paramModal !== null}
        onClose={() => setParamModal(null)}
        title={paramModal ? `执行命令: ${paramModal.snippet.name}` : "执行命令"}
        widthClassName="w-full max-w-[420px]"
        footer={
          <>
            <Button variant="secondary" onClick={() => setParamModal(null)}>
              取消
            </Button>
            <Button variant="primary" leading={<SendIcon className="h-3.5 w-3.5" />} onClick={handleApplyParams}>
              发送到终端
            </Button>
          </>
        }
      >
        {paramModal && (
          <div className="space-y-3">
            <pre className="truncate rounded-os-sm border border-line/10 bg-surface-muted p-2 font-mono text-os-2xs text-ink-secondary">
              {paramModal.snippet.command_template}
            </pre>

            <div className="space-y-3">
              {paramModal.params.map((p, idx) => (
                <Field
                  key={p.name}
                  label={
                    <span>
                      参数 <span className="font-mono text-accent">{p.name}</span>
                    </span>
                  }
                  hint={p.defaultValue ? `默认: ${p.defaultValue}` : undefined}
                >
                  <Input
                    type="text"
                    mono
                    autoFocus={idx === 0}
                    placeholder={p.defaultValue}
                    value={p.value}
                    onChange={(e) => {
                      const updated = [...paramModal.params];
                      updated[idx].value = e.target.value;
                      setParamModal({ ...paramModal, params: updated });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleApplyParams();
                    }}
                  />
                </Field>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* 新建命令片段弹窗 */}
      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title="创建快捷命令"
        widthClassName="w-full max-w-[420px]"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateModal(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={handleCreateSnippet}>
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="命令名称" required>
            <Input
              type="text"
              placeholder="例如: 查看日志"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </Field>

          <Field
            label="命令模板"
            required
            hint={'支持 ${VAR:-DEFAULT} 占位符，执行前会提示填充'}
          >
            <Textarea
              placeholder={"例如: tail -f -n ${LINES:-100} ${FILE}"}
              value={newCmd}
              onChange={(e) => setNewCmd(e.target.value)}
              rows={3}
              className="font-mono text-os-xs"
            />
          </Field>

          <Field label="发送模式">
            <Segmented<SendMode>
              value={newSendMode}
              onChange={setNewSendMode}
              ariaLabel="发送模式"
              options={[
                { value: "execute", label: "自动回车执行" },
                { value: "insert", label: "仅插入到命令行" },
              ]}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
};
