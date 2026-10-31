import React, { useEffect, useState } from "react";
import { useVaultStore } from "../stores/vaultStore";
import { formatFriendlyError } from "../lib/errors";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";
export const VaultUnlockModal: React.FC = () => {
  const { status, unlock, isLoading, error } = useVaultStore();
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    setPassword("");
    setLocalError(null);
  }, [status?.state]);

  if (!status || status.state === "unlocked" || status.state === "uninitialized") {
    return null;
  }
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (!password) {
      setLocalError("请输入主密码");
      return;
    }
    try {
      await unlock(password, false);
    } catch (err: any) {
      setLocalError(formatFriendlyError(err));
    } finally {
      setPassword("");
    }
  };

  return (
    <Modal
      open
      onClose={() => undefined}
      title="解锁 OpenShell 保险库"
      description="请输入你为本机设置的主密码。"
      widthClassName="w-full max-w-[420px]"
      footer={
        <Button variant="primary" type="submit" form="vault-unlock-form" loading={isLoading}>
          {isLoading ? "处理中..." : "解锁保险库"}
        </Button>
      }
    >
      <form id="vault-unlock-form" onSubmit={handleSubmit} className="flex flex-col gap-3.5" autoComplete="off">
        <Field label="主密码" htmlFor="vault-master-password">
          <Input
            id="vault-master-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入应用主密码"
            autoFocus
          />
        </Field>

        {(localError || error) && (
          <InlineNotice tone="danger" title="无法继续">
            {localError || error}
          </InlineNotice>
        )}
      </form>
    </Modal>
  );
};
