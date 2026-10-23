import React, { useState } from "react";
import { useVaultStore } from "../stores/vaultStore";
import { formatFriendlyError } from "../lib/errors";

export const VaultUnlockModal: React.FC = () => {
  const { status, init, unlock, isLoading, error } = useVaultStore();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [rememberKeychain, setRememberKeychain] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!status || status.state === "unlocked") {
    return null;
  }

  const isUninitialized = status.state === "uninitialized";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (isUninitialized) {
      if (!password) {
        setLocalError("请输入应用主密码（不限位数要求）");
        return;
      }
      if (password !== confirmPassword) {
        setLocalError("两次输入的密码不一致，请重新输入");
        return;
      }
      try {
        await init(password, rememberKeychain);
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
        await unlock(password, rememberKeychain);
        setPassword("");
      } catch (err: any) {
        setLocalError(formatFriendlyError(err));
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-md rounded-2xl border border-black/10 bg-white/95 p-8 shadow-apple-xl backdrop-blur-xl text-slate-800">
        <div className="mb-6 flex items-center space-x-3.5">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-apple-blue/10 text-apple-blue shadow-apple-sm">
            <svg
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900 tracking-tight">
              {isUninitialized ? "设置 OpenShell 应用主密码" : "解锁 OpenShell 保险库"}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
              {isUninitialized
                ? "首次使用，请设置主密码以加密保护会话凭据与密钥（不限制位数）"
                : "请输入主密码以解密会话凭据"}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              主密码 (Master Password)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoFocus
              className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
            />
          </div>

          {isUninitialized && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                确认主密码 (Confirm Password)
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-apple-blue focus:bg-white focus:outline-none focus:ring-2 focus:ring-apple-blue/20 transition"
              />
            </div>
          )}

          <div className="flex items-center space-x-2 pt-0.5">
            <input
              type="checkbox"
              id="keychain"
              checked={rememberKeychain}
              onChange={(e) => setRememberKeychain(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-apple-blue focus:ring-apple-blue"
            />
            <label htmlFor="keychain" className="text-xs text-slate-600 select-none">
              在系统钥匙串中记住密码 (自动解锁)
            </label>
          </div>

          {(localError || error) && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-2.5 text-xs text-red-600 flex items-center gap-1.5">
              <span>⚠️</span>
              <span>{localError || error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-xl bg-apple-blue px-4 py-2.5 text-sm font-semibold text-white shadow-apple-md transition hover:bg-apple-hoverBlue focus:outline-none focus:ring-2 focus:ring-apple-blue/30 disabled:opacity-50"
          >
            {isLoading
              ? "处理中..."
              : isUninitialized
              ? "创建并解锁保险库"
              : "解锁保险库"}
          </button>
        </form>
      </div>
    </div>
  );
};
