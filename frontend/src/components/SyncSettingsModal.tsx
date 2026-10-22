import React, { useEffect, useState } from "react";
import { useSyncStore } from "../stores/syncStore";

export const SyncSettingsModal: React.FC = () => {
  const {
    config,
    syncing,
    modalOpen,
    error,
    setModalOpen,
    loadConfig,
    saveConfig,
    register,
    login,
    logout,
    syncNow,
    checkUpdates,
  } = useSyncStore();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8080");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [autoSync, setAutoSync] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (modalOpen) {
      loadConfig();
    }
  }, [modalOpen]);

  useEffect(() => {
    if (config) {
      if (config.server_url) setServerUrl(config.server_url);
      setAutoSync(config.auto_sync);
    }
  }, [config]);

  if (!modalOpen) return null;

  const handleSubmitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setSyncFeedback(null);
    try {
      if (mode === "register") {
        await register(serverUrl, email, password, inviteCode || undefined);
        setSyncFeedback("注册并登录成功！");
      } else {
        await login(serverUrl, email, password);
        setSyncFeedback("登录成功！");
      }
    } catch {
      // handled by store error
    }
  };

  const handleManualSync = async () => {
    setSyncFeedback(null);
    try {
      const res = await syncNow();
      setSyncFeedback(
        `同步成功：已推送 ${res.pushed_count} 条变更，拉取 ${res.pulled_count} 条，版本 #${res.head_seq}`
      );
    } catch (err: any) {
      setSyncFeedback(`同步失败: ${err?.message || err}`);
    }
  };

  const handleAutoSyncToggle = async (val: boolean) => {
    setAutoSync(val);
    try {
      await saveConfig(serverUrl, val);
    } catch {}
  };

  const handleCheckUpdate = async () => {
    const info = await checkUpdates();
    if (info) {
      setSyncFeedback(`发现新版本 v${info.version} (${info.channel})`);
    } else {
      setSyncFeedback("当前已是最新版本");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95">
        {/* 顶部标题栏 */}
        <div className="h-12 px-6 border-b border-surface-800 flex items-center justify-between bg-surface-950/70">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <h3 className="text-sm font-bold text-white">自建服务端与 E2EE 云同步</h3>
          </div>

          <button
            onClick={() => setModalOpen(false)}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-surface-800 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 模态框主体 */}
        <div className="p-6 space-y-5 text-xs text-slate-300 overflow-y-auto max-h-[75vh]">
          {/* E2EE 说明横幅 */}
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-start gap-2.5 text-slate-300">
            <svg className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <p className="text-[11px] leading-relaxed">
              <span className="font-semibold text-emerald-400">端到端加密（E2EE）：</span>
              所有会话、凭据、私钥及命令均在本地用您的保险库主密钥（Argon2id + XChaCha20-Poly1305）加密后再上送，自建服务端仅保存不可读密文。
            </p>
          </div>

          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-xs flex items-center justify-between">
              <span>{error}</span>
            </div>
          )}

          {syncFeedback && (
            <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl text-xs">
              {syncFeedback}
            </div>
          )}

          {/* 状态或登录表单 */}
          {config?.is_logged_in ? (
            <div className="space-y-4">
              <div className="p-4 bg-surface-950/70 border border-surface-800 rounded-xl space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">同步服务端地址:</span>
                  <span className="font-mono text-emerald-400 font-medium truncate max-w-[250px]">
                    {config.server_url || "未配置"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">本地设备 ID:</span>
                  <span className="font-mono text-slate-300 truncate max-w-[200px]">
                    {config.device_id}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">上次拉取时间:</span>
                  <span className="text-slate-300">
                    {config.last_sync_at
                      ? new Date(config.last_sync_at).toLocaleString()
                      : "未同步"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-400">冲突副本状态:</span>
                  <span className={config.conflict_count > 0 ? "text-amber-400 font-bold" : "text-slate-400"}>
                    {config.conflict_count > 0 ? `${config.conflict_count} 个冲突副本（已保留）` : "正常（无冲突）"}
                  </span>
                </div>
              </div>

              {/* 自动同步设置 */}
              <div className="flex items-center justify-between p-3 bg-surface-950/50 border border-surface-800 rounded-xl">
                <div>
                  <div className="font-semibold text-white">自动增量同步</div>
                  <div className="text-[11px] text-slate-400">数据变动时及周期自动推送与合并</div>
                </div>
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(e) => handleAutoSyncToggle(e.target.checked)}
                  className="w-4 h-4 accent-emerald-500 rounded cursor-pointer"
                />
              </div>

              {/* 操作按钮组 */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleManualSync}
                  disabled={syncing}
                  className="py-2.5 px-4 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-xl font-semibold shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 transition"
                >
                  {syncing ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>同步中...</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>立即同步</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleCheckUpdate}
                  className="py-2.5 px-4 bg-surface-800 hover:bg-surface-700 text-white rounded-xl font-semibold border border-surface-700 flex items-center justify-center gap-1.5 transition"
                >
                  <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span>检查软件更新</span>
                </button>
              </div>

              <div className="pt-2 text-center">
                <button
                  type="button"
                  onClick={() => logout()}
                  className="text-xs text-red-400 hover:text-red-300 transition underline underline-offset-4"
                >
                  退出当前同步账号
                </button>
              </div>
            </div>
          ) : (
            /* 登录 / 注册表单 */
            <form onSubmit={handleSubmitAuth} className="space-y-4">
              <div className="flex p-1 bg-surface-950 border border-surface-800 rounded-xl">
                <button
                  type="button"
                  onClick={() => setMode("login")}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition ${
                    mode === "login"
                      ? "bg-surface-800 text-white shadow-sm"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  登录已有账号
                </button>
                <button
                  type="button"
                  onClick={() => setMode("register")}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition ${
                    mode === "register"
                      ? "bg-surface-800 text-white shadow-sm"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  注册自建账号
                </button>
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">服务端地址 (HTTPS/HTTP)</label>
                <input
                  type="text"
                  required
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="https://sync.example.com"
                  className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-xl text-white font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">账号邮箱</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block text-slate-300 font-medium mb-1">密码（10-128 位字符）</label>
                <input
                  type="password"
                  required
                  minLength={10}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              {mode === "register" && (
                <div>
                  <label className="block text-slate-300 font-medium mb-1">邀请码 / 引导令牌 (选填)</label>
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="单用户首次注册或受邀注册时填写"
                    className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-xl text-white font-mono placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={syncing}
                className="w-full py-2.5 mt-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-xl font-semibold shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 transition"
              >
                {syncing ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>处理中...</span>
                  </>
                ) : (
                  <span>{mode === "login" ? "登 录" : "注 册 并 绑 定"}</span>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
