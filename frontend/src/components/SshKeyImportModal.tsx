import { useState, type ReactNode } from "react";
import type { SshKey } from "../types/ipc";
import { importSshKey, pickSshKeyFile, type SelectedPrivateKey } from "../lib/ipc";
import { formatFriendlyError, parseIpcError } from "../lib/errors";
import { useVaultStore } from "../stores/vaultStore";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";

interface Props {
  onClose: () => void;
  onSaved: (key: SshKey) => void;
  vaultUnlock: ReactNode;
}

export function SshKeyImportModal({ onClose, onSaved, vaultUnlock }: Props) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<SelectedPrivateKey | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkVaultStatus = useVaultStore((s) => s.checkStatus);

  const chooseFile = async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = await pickSshKeyFile();
      if (selected) {
        setFile(selected);
        setPassphrase("");
        if (!name.trim()) setName(selected.file_name.replace(/\.(pem|key|ppk)$/i, ""));
      }
    } catch (err) {
      setFile(null);
      setPassphrase("");
      setError(formatFriendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (!name.trim() || !file) {
      setError(!name.trim() ? "请输入自定义私钥名。" : "请选择需要导入的私钥文件。");
      return;
    }
    setBusy(true);
    try {
      await checkVaultStatus();
      if (useVaultStore.getState().status?.state !== "unlocked") {
        setError("请先解锁保险库，再保存私钥。私钥密码与保险库主密码是两个不同的密码。");
        return;
      }
      const key = await importSshKey(name.trim(), file.pem, passphrase || undefined);
      setPassphrase("");
      setFile(null);
      onSaved(key);
    } catch (err) {
      setError(formatFriendlyError(err));
      if (parseIpcError(err).code === "VAULT_LOCKED") await checkVaultStatus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose(); }}
      title="导入 SSH 私钥"
      description="选择文件并填写密码，保存时验证私钥。"
      overlayZClassName="z-[60]"
      footer={<>
        <Button onClick={onClose} disabled={busy}>取消</Button>
        <Button variant="primary" type="submit" form="ssh-key-import-form" loading={busy}>保存私钥</Button>
      </>}
    >
      <form id="ssh-key-import-form" onSubmit={save} autoComplete="off" className="flex flex-col gap-4">
        <Field label="自定义私钥名" htmlFor="ssh-key-name" required>
          <Input id="ssh-key-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="如：生产服务器" autoFocus />
        </Field>
        <Field label="导入私钥文件" htmlFor="ssh-key-file" hint="默认打开当前用户的 .ssh 目录。" required>
          <div className="flex gap-2">
            <Input id="ssh-key-file" value={file?.file_name ?? ""} readOnly placeholder="尚未选择私钥" className="min-w-0 flex-1" />
            <Button onClick={chooseFile} disabled={busy}>选择文件</Button>
          </div>
        </Field>
        <Field label="私钥密码 (Passphrase)" htmlFor="ssh-key-password" hint="未加密的私钥可留空；加密私钥需要填写正确密码。">
          <Input id="ssh-key-password" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={busy} autoComplete="off" placeholder="选择私钥文件后填写" />
        </Field>
        {vaultUnlock}
        {error && <InlineNotice tone="danger" title="私钥尚未保存">{error}</InlineNotice>}
      </form>
    </Modal>
  );
}
