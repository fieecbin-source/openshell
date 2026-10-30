import React, { useEffect, useRef, useState } from "react";
import type { Session } from "../types/ipc";
import type { TerminalTab } from "../stores/terminalStore";
import { ConnectOverrides, useTerminalStore } from "../stores/terminalStore";
import { getSession, setSshKeyPassphrase } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";

interface ConnectAuthModalProps {
  tab: TerminalTab;
  onClose: () => void;
}

/**
 * 连接失败后的凭据补录弹窗。
 *
 * 用于以下场景：会话未保存密码 / 保险库锁定导致无法取到密码 / 密码已变更。
 * 用户重新输入后直接复用当前标签页重连，无需回到会话编辑页。
 */
export const ConnectAuthModal: React.FC<ConnectAuthModalProps> = ({ tab, onClose }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const persistedRef = useRef(false);

  const liveTab = useTerminalStore((s) => s.tabs.find((t) => t.tabId === tab.tabId));
  const reconnectTab = useTerminalStore((s) => s.reconnectTab);

  useEffect(() => {
    let cancelled = false;
    getSession(tab.sessionId)
      .then((s) => {
        if (cancelled) return;
        setSession(s);
        setUsername(s.username || "root");
      })
      .catch((e) => {
        if (!cancelled) setLocalError(formatFriendlyError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [tab.sessionId]);

  useEffect(() => {
    if (liveTab?.status !== "connected") return;
    onClose();
  }, [liveTab?.status, onClose]);

  const authMethod = (session?.auth_method || "").toString();
  const isKeyAuth = authMethod === "publickey" || authMethod === "public_key";
  const isPasswordAuth =
    authMethod === "password" || authMethod === "keyboard_interactive" || authMethod === "keyboard-interactive";

  // 用户输入的口令既然能成功连上，就永久保存到该私钥，后续连接无需再输入
  useEffect(() => {
    if (liveTab?.status !== "connected") return;
    if (!persistedRef.current && isKeyAuth && passphrase && session?.ssh_key_id) {
      persistedRef.current = true;
      setSshKeyPassphrase(session.ssh_key_id, passphrase).catch(() => {
        // 保存失败不影响本次已建立的连接
      });
    }
  }, [liveTab?.status, isKeyAuth, passphrase, session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isPasswordAuth && !isKeyAuth) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      const overrides: ConnectOverrides = {
        username: username.trim() || undefined,
        password: isPasswordAuth && password ? password : undefined,
        passphrase: isKeyAuth && passphrase ? passphrase : undefined,
      };
      await reconnectTab(tab.tabId, overrides);
    } finally {
      setSubmitting(false);
    }
  };

  const liveError = liveTab?.status === "error" ? liveTab.error : null;
  const target = session
    ? `${session.username || "root"}@${session.host || "-"}:${session.port || 22}`
    : tab.sessionName;

  return (
    <Modal
      open
      onClose={onClose}
      title="重新填写登录凭据"
      description={target}
      widthClassName="w-full max-w-[420px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          {(isPasswordAuth || isKeyAuth) && (
            <Button variant="primary" type="submit" form="connect-auth-form" loading={submitting}>
              {submitting ? "正在连接..." : isKeyAuth ? "使用该口令重连" : "使用该密码重连"}
            </Button>
          )}
        </>
      }
    >
      <form id="connect-auth-form" onSubmit={handleSubmit} className="flex flex-col gap-3.5">
        {session && !isPasswordAuth && !isKeyAuth ? (
          <InlineNotice tone="warning" title="认证方式暂不支持补录">
            当前会话使用的认证方式暂不支持在失败后补录凭据，请在「会话编辑 → 认证」中检查配置。
          </InlineNotice>
        ) : (
          <>
            <Field label="用户名" htmlFor="connect-auth-username">
              <Input
                id="connect-auth-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
            </Field>

            {isKeyAuth ? (
              <Field
                label="私钥口令"
                htmlFor="connect-auth-passphrase"
                hint="若私钥已加密，请输入口令；也可以到「私钥管理」中为已选私钥永久保存口令。"
              >
                <Input
                  id="connect-auth-passphrase"
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="私钥未加密时留空"
                  autoComplete="off"
                  autoFocus
                />
              </Field>
            ) : (
              <Field label="登录密码" htmlFor="connect-auth-password">
                <Input
                  id="connect-auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入服务器登录密码（支持任意长度）"
                  autoComplete="current-password"
                  autoFocus
                />
              </Field>
            )}
          </>
        )}

        {(localError || liveError) && (
          <InlineNotice tone="danger" title="连接未完成">
            {localError || liveError}
          </InlineNotice>
        )}
      </form>
    </Modal>
  );
};
