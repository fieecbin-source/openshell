import React, { useState } from "react";
import { useVaultStore } from "../stores/vaultStore";

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
      if (password.length < 10) {
        setLocalError("主密码长度至少需要 10 个字符");
        return;
      }
      if (password !== confirmPassword) {
        setLocalError("两次输入的密码不一致");
        return;
      }
      try {
        await init(password, rememberKeychain);
        setPassword("");
        setConfirmPassword("");
      } catch (err: any) {
        setLocalError(err?.message || "初始化保险库失败");
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
        setLocalError(err?.message || "密码错误或解锁失败");
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-surface-900/90 p-8 shadow-2xl backdrop-blur-xl">
        <div className="mb-6 flex items-center space-x-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
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
            <h2 className="text-xl font-bold text-white tracking-wide">
              {isUninitialized ? "初始化 OpenShell 主保险库" : "解锁 OpenShell 保险库"}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              {isUninitialized
                ? "首次使用，请设置主密码以加密保护所有会话凭据与密钥"
                : "请输入主密码以解密会话凭据"}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              主密码 (Master Password)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {isUninitialized && (
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                确认主密码 (Confirm Password)
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-lg border border-slate-700 bg-surface-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          )}

          <div className="flex items-center space-x-2 pt-1">
            <input
              type="checkbox"
              id="keychain"
              checked={rememberKeychain}
              onChange={(e) => setRememberKeychain(e.target.checked)}
              className="h-4 w-4 rounded border-slate-700 bg-surface-950 text-emerald-500 focus:ring-emerald-500/20"
            />
            <label htmlFor="keychain" className="text-xs text-slate-400">
              在系统安全钥匙串中记住密码 (自动解锁)
            </label>
          </div>

          {(localError || error) && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-2.5 text-xs text-red-400">
              {localError || error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50"
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
