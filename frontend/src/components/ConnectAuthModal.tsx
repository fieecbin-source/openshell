import React, { useEffect, useRef, useState } from "react";
import type { Session } from "../types/ipc";
import type { TerminalTab } from "../stores/terminalStore";
import { ConnectOverrides, useTerminalStore } from "../stores/terminalStore";
import { getSession, setSshKeyPassphrase } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

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

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-2xl bg-white border border-black/10 shadow-2xl p-6 text-[#1d1d1f]"
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold">重新填写登录凭据</h3>
            <p className="text-xs text-[#86868b] mt-1">
              {session
                ? `${session.username || "root"}@${session.host || "-"}:${session.port || 22}`
                : tab.sessionName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#86868b] hover:bg-black/[0.05]"
            aria-label="关闭"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {session && !isPasswordAuth && !isKeyAuth ? (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 leading-relaxed">
            当前会话使用的认证方式暂不支持在失败后补录凭据，请在「会话编辑 → 认证方式」中检查配置。
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5">用户名</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-[#f5f5f7] border border-black/10 text-sm outline-none focus:border-[#0071e3] focus:bg-white"
                autoComplete="username"
              />
            </div>
            {isKeyAuth ? (
              <div>
                <label className="block text-xs font-semibold mb-1.5">私钥口令 (Passphrase)</label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="私钥未加密时留空"
                  className="w-full px-3 py-2 rounded-xl bg-[#f5f5f7] border border-black/10 text-sm outline-none focus:border-[#0071e3] focus:bg-white"
                  autoComplete="off"
                  autoFocus
                />
                <p className="text-[11px] text-[#86868b] mt-1.5">
                  若私钥已加密，请输入口令；也可以到「私钥管理」中为已选私钥永久保存口令。
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-semibold mb-1.5">登录密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="输入服务器登录密码（支持任意长度）"
                  className="w-full px-3 py-2 rounded-xl bg-[#f5f5f7] border border-black/10 text-sm outline-none focus:border-[#0071e3] focus:bg-white"
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
            )}
          </div>
        )}

        {(localError || liveError) && (
          <div className="mt-3 rounded-xl bg-red-50 border border-red-200 p-3 text-xs text-red-700 leading-relaxed">
            {localError || liveError}
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-[#1d1d1f] bg-black/[0.05] hover:bg-black/[0.08]"
          >
            取消
          </button>
          {(isPasswordAuth || isKeyAuth) && (
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-60"
            >
              {submitting ? "正在连接..." : isKeyAuth ? "使用该口令重连" : "使用该密码重连"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
