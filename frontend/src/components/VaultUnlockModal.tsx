import React, { useState } from "react";
import { useVaultStore } from "../stores/vaultStore";
import { formatFriendlyError } from "../lib/errors";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";

/** 与后端 vault 的最小长度保持一致 */
const MIN_MASTER_PASSWORD_LEN = 5;

export const VaultUnlockModal: React.FC = () => {
  const { status, init, unlock, isLoading, error } = useVaultStore();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  if (!status || status.state === "unlocked") {
    return null;
  }

  const isUninitialized = status.state === "uninitialized";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (isUninitialized) {
      if (password.length < MIN_MASTER_PASSWORD_LEN) {
        setLocalError(`主密码至少需要 ${MIN_MASTER_PASSWORD_LEN} 位`);
        return;
      }
      if (password !== confirmPassword) {
        setLocalError("两次输入的密码不一致，请重新输入");
        return;
      }
      try {
        // 第二个参数为历史遗留的「记住在系统钥匙串」标志。
        // 当前实现并未接入系统钥匙串（不做虚假声明），因此固定传 false。
        await init(password, false);
        setPassword("");
        setConfirmPassword("");
      } catch (err: any) {
        setLocalError(formatFriendlyError(err));
      }
    } else {
      if (!password) {
        setLocalError("请输入主密码");
        return;
      }
      try {
        // 注意：解锁时不做长度校验，避免历史短密码用户被锁在门外
        await unlock(password, false);
        setPassword("");
      } catch (err: any) {
        setLocalError(formatFriendlyError(err));
      }
    }
  };

  return (
    <Modal
      open
      onClose={() => undefined}
      title={isUninitialized ? "设置 OpenShell 应用主密码" : "解锁 OpenShell 保险库"}
      description={
        isUninitialized
          ? "首次使用，请设置至少 5 位主密码以加密保护会话凭据与密钥；忘记后无法恢复。"
          : "请输入主密码以解密会话凭据与密钥。"
      }
      widthClassName="w-full max-w-[420px]"
      footer={
        <Button variant="primary" type="submit" form="vault-unlock-form" loading={isLoading}>
          {isLoading ? "处理中..." : isUninitialized ? "创建并解锁保险库" : "解锁保险库"}
        </Button>
      }
    >
      <form id="vault-unlock-form" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        <Field label="主密码" htmlFor="vault-master-password">
          <Input
            id="vault-master-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="输入应用主密码"
            autoFocus
          />
        </Field>

        {isUninitialized && (
          <Field label="确认主密码" htmlFor="vault-confirm-password">
            <Input
              id="vault-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入主密码"
            />
          </Field>
        )}

        {(localError || error) && (
          <InlineNotice tone="danger" title="无法继续">
            {localError || error}
          </InlineNotice>
        )}
      </form>
    </Modal>
  );
};
