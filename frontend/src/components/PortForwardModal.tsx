import React, { useEffect, useState } from "react";
import { useForwardStore } from "../stores/forwardStore";
import type { PortForwardRuleInput, PortForwardType, SocksAuth } from "../types/ipc";

interface PortForwardModalProps {
  sessionId?: string;
  connId?: string;
  onClose: () => void;
}

export const PortForwardModal: React.FC<PortForwardModalProps> = ({
  sessionId,
  connId,
  onClose,
}) => {
  const {
    rules,
    statuses,
    loading,
    loadRules,
    createRule,
    deleteRule,
    toggleRule,
  } = useForwardStore();

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [ruleType, setRuleType] = useState<PortForwardType>("local");
  const [name, setName] = useState("");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState<number>(8080);
  const [destHost, setDestHost] = useState("127.0.0.1");
  const [destPort, setDestPort] = useState<number>(80);
  const [socksAuth, setSocksAuth] = useState<SocksAuth>("none");
  const [socksUsername, setSocksUsername] = useState("");
  const [exposeAck, setExposeAck] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    loadRules(sessionId);
  }, [sessionId]);

  const isExposeRisky = bindHost === "0.0.0.0" || bindHost === "::";

  const handleCreate = async () => {
    if (!name.trim()) {
      setErrorMsg("请输入规则名称");
      return;
    }
    if (isExposeRisky && !exposeAck) {
      setErrorMsg("绑定 0.0.0.0 具有全网暴露风险，必须确认安全风险方可创建！");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const input: PortForwardRuleInput = {
        session_id: sessionId || null,
        name: name.trim(),
        rule_type: ruleType,
        bind_host: bindHost.trim() || "127.0.0.1",
        bind_port: Number(bindPort),
        dest_host: ruleType === "dynamic" ? null : destHost.trim() || null,
        dest_port: ruleType === "dynamic" ? null : Number(destPort),
        socks_auth: socksAuth,
        socks_username: socksAuth === "user_pass" ? socksUsername : null,
        expose_warning_ack: exposeAck,
        auto_start: autoStart,
      };

      await createRule(input);
      setAddModalOpen(false);
      setName("");
      setBindPort(8080);
      setDestPort(80);
    } catch (e: any) {
      setErrorMsg(e?.message || "创建规则失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-3xl bg-surface-900 border border-surface-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[85vh]">
        {/* 顶部标题栏 */}
        <div className="h-12 px-6 border-b border-surface-800 flex items-center justify-between bg-surface-950/70">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <h3 className="text-sm font-bold text-white">端口转发与 SOCKS5 代理</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setAddModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium shadow-sm transition"
            >
              <span>+ 新建规则</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-surface-800 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 规则列表 */}
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {loading ? (
            <div className="py-12 text-center text-slate-500 text-xs">加载规则中...</div>
          ) : rules.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-500 text-xs">
              <p>暂无端口转发规则</p>
              <p className="text-[11px] text-slate-600 mt-1">
                点击右上角新建规则以创建本地转发、远程转发或动态 SOCKS5 代理
              </p>
            </div>
          ) : (
            rules.map((rule) => {
              const status = statuses[rule.id] || { state: "Stopped" };
              const isListening = status.state === "Listening";
              const isError = status.state === "Error";

              return (
                <div
                  key={rule.id}
                  className="bg-surface-950 border border-surface-800 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:border-surface-700 transition"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-semibold text-xs text-white truncate">{rule.name}</span>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-surface-800 text-emerald-400 border border-surface-700">
                        {rule.rule_type === "local" ? "本地 -L" : rule.rule_type === "remote" ? "远程 -R" : "动态 SOCKS5 -D"}
                      </span>
                      {isListening ? (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          运行中: {(status as any).details?.bound_addr || `${rule.bind_host}:${rule.bind_port}`}
                        </span>
                      ) : isError ? (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                          错误: {(status as any).details}
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-800 text-slate-500">
                          未启动
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                      <span>{rule.bind_host}:{rule.bind_port}</span>
                      {rule.rule_type !== "dynamic" && (
                        <>
                          <span className="text-slate-600">➔</span>
                          <span>{rule.dest_host}:{rule.dest_port}</span>
                        </>
                      )}
                      {rule.rule_type === "dynamic" && (
                        <span className="text-slate-500 text-[11px] font-sans">
                          (认证: {rule.socks_auth === "none" ? "无密码" : "用户名密码"})
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => toggleRule(rule, connId)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                        isListening
                          ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20"
                          : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm"
                      }`}
                    >
                      {isListening ? "停止" : "启动"}
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`确定删除规则 ${rule.name} 吗？`)) {
                          deleteRule(rule.id);
                        }
                      }}
                      className="p-1.5 text-slate-500 hover:text-red-400 rounded-lg hover:bg-surface-800 transition"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* 新增规则抽屉/模态框 */}
        {addModalOpen && (
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-lg bg-surface-900 border border-surface-700 rounded-2xl p-6 shadow-2xl animate-in zoom-in-95">
              <h4 className="text-sm font-bold text-white mb-4">创建端口转发规则</h4>

              {errorMsg && (
                <div className="mb-4 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                  {errorMsg}
                </div>
              )}

              <div className="space-y-4 text-xs">
                <div>
                  <label className="block text-slate-300 mb-1 font-medium">规则类型</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setRuleType("local")}
                      className={`py-2 px-3 rounded-lg border font-medium transition ${
                        ruleType === "local"
                          ? "bg-emerald-500/10 border-emerald-500 text-emerald-400"
                          : "bg-surface-950 border-surface-800 text-slate-400 hover:border-surface-700"
                      }`}
                    >
                      本地转发 (-L)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRuleType("remote")}
                      className={`py-2 px-3 rounded-lg border font-medium transition ${
                        ruleType === "remote"
                          ? "bg-emerald-500/10 border-emerald-500 text-emerald-400"
                          : "bg-surface-950 border-surface-800 text-slate-400 hover:border-surface-700"
                      }`}
                    >
                      远程转发 (-R)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRuleType("dynamic")}
                      className={`py-2 px-3 rounded-lg border font-medium transition ${
                        ruleType === "dynamic"
                          ? "bg-emerald-500/10 border-emerald-500 text-emerald-400"
                          : "bg-surface-950 border-surface-800 text-slate-400 hover:border-surface-700"
                      }`}
                    >
                      SOCKS5 代理 (-D)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-slate-300 mb-1 font-medium">规则名称</label>
                  <input
                    type="text"
                    placeholder="例如: MySQL 隧道 / Web 预览"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg text-white outline-none focus:border-emerald-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-300 mb-1 font-medium">监听地址 (Bind Host)</label>
                    <input
                      type="text"
                      value={bindHost}
                      onChange={(e) => setBindHost(e.target.value)}
                      className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg font-mono text-white outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-300 mb-1 font-medium">监听端口 (Bind Port)</label>
                    <input
                      type="number"
                      value={bindPort}
                      onChange={(e) => setBindPort(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg font-mono text-white outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>

                {isExposeRisky && (
                  <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl space-y-2">
                    <div className="flex items-center gap-2 text-red-400 font-bold">
                      <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span>高危安全警告 (SEC-005)</span>
                    </div>
                    <p className="text-[11px] text-red-300 leading-relaxed">
                      您将端口绑定到了 0.0.0.0，局域网与公网上的所有主机均可直接访问此端口！
                    </p>
                    <label className="flex items-center gap-2 text-xs text-white cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={exposeAck}
                        onChange={(e) => setExposeAck(e.target.checked)}
                        className="rounded border-red-500/40 text-red-600 focus:ring-0"
                      />
                      <span>我已知晓全网暴露风险，确认允许绑定到 0.0.0.0</span>
                    </label>
                  </div>
                )}

                {ruleType !== "dynamic" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-300 mb-1 font-medium">目标地址 (Dest Host)</label>
                      <input
                        type="text"
                        value={destHost}
                        onChange={(e) => setDestHost(e.target.value)}
                        className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg font-mono text-white outline-none focus:border-emerald-500"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-300 mb-1 font-medium">目标端口 (Dest Port)</label>
                      <input
                        type="number"
                        value={destPort}
                        onChange={(e) => setDestPort(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg font-mono text-white outline-none focus:border-emerald-500"
                      />
                    </div>
                  </div>
                )}

                {ruleType === "dynamic" && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-slate-300 mb-1 font-medium">SOCKS5 认证模式</label>
                      <select
                        value={socksAuth}
                        onChange={(e) => setSocksAuth(e.target.value as SocksAuth)}
                        className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg text-white outline-none focus:border-emerald-500"
                      >
                        <option value="none">无须密码认证 (No-Auth)</option>
                        <option value="user_pass">用户名与密码认证 (RFC 1929)</option>
                      </select>
                    </div>

                    {socksAuth === "user_pass" && (
                      <div>
                        <label className="block text-slate-300 mb-1 font-medium">认证用户名</label>
                        <input
                          type="text"
                          placeholder="用户名"
                          value={socksUsername}
                          onChange={(e) => setSocksUsername(e.target.value)}
                          className="w-full px-3 py-2 bg-surface-950 border border-surface-800 rounded-lg text-white outline-none focus:border-emerald-500"
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="pt-2">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoStart}
                      onChange={(e) => setAutoStart(e.target.checked)}
                      className="rounded border-surface-700 text-emerald-500 focus:ring-0"
                    />
                    <span>连接会话时自动启动此转发规则</span>
                  </label>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="px-4 py-2 bg-surface-800 hover:bg-surface-700 text-slate-300 rounded-lg text-xs"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={submitting}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium shadow-sm transition disabled:opacity-50"
                >
                  {submitting ? "创建中..." : "确认创建"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
