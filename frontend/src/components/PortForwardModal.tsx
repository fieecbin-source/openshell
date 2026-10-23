import React, { useEffect, useState } from "react";
import { useForwardStore } from "../stores/forwardStore";
import type { PortForwardRuleInput, PortForwardType, SocksAuth } from "../types/ipc";
import { formatFriendlyError } from "../lib/errors";

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
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-3xl bg-white/95 border border-black/[0.08] rounded-2xl shadow-apple-lg flex flex-col overflow-hidden max-h-[85vh] text-[#1d1d1f] backdrop-blur-2xl animate-in zoom-in-95 duration-150">
        {/* 顶部标题栏 */}
        <div className="h-13 px-6 border-b border-black/[0.06] flex items-center justify-between bg-white/70">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 border border-blue-200/60 flex items-center justify-center text-[#0071e3] shadow-sm">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#1d1d1f] tracking-tight">端口转发与 SOCKS5 代理</h3>
              <p className="text-[11px] text-[#86868b]">本地端口转发 (-L)、远程转发 (-R) 及动态 SOCKS5 代理 (-D)</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setAddModalOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-xl text-xs font-semibold shadow-sm transition active:scale-[0.98]"
            >
              <span>+ 新建规则</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-[#86868b] hover:text-[#1d1d1f] rounded-lg hover:bg-black/[0.05] active:scale-95 transition"
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
            <div className="py-12 text-center text-[#86868b] text-xs">加载规则中...</div>
          ) : rules.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-[#86868b] text-xs">
              <p className="font-medium text-[#1d1d1f]">暂无端口转发规则</p>
              <p className="text-[11px] text-[#86868b] mt-1">
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
                  className="bg-[#f5f5f7] border border-black/[0.06] rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:border-black/[0.12] transition shadow-apple-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-semibold text-xs text-[#1d1d1f] truncate">{rule.name}</span>
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-md bg-white text-[#0071e3] border border-black/[0.08] shadow-apple-sm">
                        {rule.rule_type === "local" ? "本地 -L" : rule.rule_type === "remote" ? "远程 -R" : "动态 SOCKS5 -D"}
                      </span>
                      {isListening ? (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1.5 font-semibold">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          运行中: {(status as any).details?.bound_addr || `${rule.bind_host}:${rule.bind_port}`}
                        </span>
                      ) : isError ? (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-red-50 text-red-600 border border-red-200">
                          错误: {(status as any).details}
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-black/[0.05] text-[#86868b]">
                          未启动
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs font-mono text-[#424245]">
                      <span>{rule.bind_host}:{rule.bind_port}</span>
                      {rule.rule_type !== "dynamic" && (
                        <>
                          <span className="text-[#86868b]">➔</span>
                          <span>{rule.dest_host}:{rule.dest_port}</span>
                        </>
                      )}
                      {rule.rule_type === "dynamic" && (
                        <span className="text-[#86868b] text-[11px] font-sans">
                          (认证: {rule.socks_auth === "none" ? "无密码" : "用户名密码"})
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => toggleRule(rule, connId)}
                      className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition active:scale-[0.98] ${
                        isListening
                          ? "bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 border border-amber-500/20"
                          : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm"
                      }`}
                    >
                      {isListening ? "停止" : "启动"}
                    </button>
                    <button
                      onClick={async () => {
                        if (confirm(`确定删除规则 ${rule.name} 吗？`)) {
                          try {
                            await deleteRule(rule.id);
                            setErrorMsg(null);
                          } catch (e) {
                            setErrorMsg(formatFriendlyError(e));
                          }
                        }
                      }}
                      className="p-1.5 text-[#86868b] hover:text-red-600 rounded-lg hover:bg-black/[0.05] active:scale-95 transition"
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
          <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/25 backdrop-blur-md p-4 animate-in fade-in duration-150">
            <div className="w-full max-w-lg bg-white/95 border border-black/[0.08] rounded-2xl p-6 shadow-apple-lg text-[#1d1d1f] backdrop-blur-2xl animate-in zoom-in-95">
              <h4 className="text-base font-semibold text-[#1d1d1f] tracking-tight mb-4">创建端口转发规则</h4>

              {errorMsg && (
                <div className="mb-4 p-2.5 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-600 flex items-center gap-1.5">
                  <span>⚠️</span>
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="space-y-4 text-xs">
                <div>
                  <label className="block text-[#1d1d1f] mb-1.5 font-semibold">规则类型</label>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setRuleType("local")}
                      className={`py-2 px-3 rounded-xl border text-xs font-semibold transition active:scale-[0.98] ${
                        ruleType === "local"
                          ? "bg-blue-50 border-[#0071e3] text-[#0071e3] shadow-apple-sm"
                          : "bg-[#f5f5f7] border-black/[0.08] text-[#86868b] hover:text-[#1d1d1f]"
                      }`}
                    >
                      本地转发 (-L)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRuleType("remote")}
                      className={`py-2 px-3 rounded-xl border text-xs font-semibold transition active:scale-[0.98] ${
                        ruleType === "remote"
                          ? "bg-blue-50 border-[#0071e3] text-[#0071e3] shadow-apple-sm"
                          : "bg-[#f5f5f7] border-black/[0.08] text-[#86868b] hover:text-[#1d1d1f]"
                      }`}
                    >
                      远程转发 (-R)
                    </button>
                    <button
                      type="button"
                      onClick={() => setRuleType("dynamic")}
                      className={`py-2 px-3 rounded-xl border text-xs font-semibold transition active:scale-[0.98] ${
                        ruleType === "dynamic"
                          ? "bg-blue-50 border-[#0071e3] text-[#0071e3] shadow-apple-sm"
                          : "bg-[#f5f5f7] border-black/[0.08] text-[#86868b] hover:text-[#1d1d1f]"
                      }`}
                    >
                      SOCKS5 代理 (-D)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-[#1d1d1f] mb-1.5 font-semibold">规则名称</label>
                  <input
                    type="text"
                    placeholder="例如: MySQL 隧道 / Web 预览"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[#1d1d1f] mb-1.5 font-semibold">监听地址 (Bind Host)</label>
                    <input
                      type="text"
                      value={bindHost}
                      onChange={(e) => setBindHost(e.target.value)}
                      className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl font-mono text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                    />
                  </div>
                  <div>
                    <label className="block text-[#1d1d1f] mb-1.5 font-semibold">监听端口 (Bind Port)</label>
                    <input
                      type="number"
                      value={bindPort}
                      onChange={(e) => setBindPort(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl font-mono text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                    />
                  </div>
                </div>

                {isExposeRisky && (
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl space-y-2">
                    <div className="flex items-center gap-2 text-red-700 font-semibold">
                      <svg className="w-4 h-4 shrink-0 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span>高危安全警告 (SEC-005)</span>
                    </div>
                    <p className="text-[11px] text-red-700 leading-relaxed">
                      您将端口绑定到了 0.0.0.0，局域网与公网上的所有主机均可直接访问此端口！
                    </p>
                    <label className="flex items-center gap-2 text-xs text-[#1d1d1f] cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={exposeAck}
                        onChange={(e) => setExposeAck(e.target.checked)}
                        className="rounded border-red-500/40 text-red-600 focus:ring-0 accent-red-600"
                      />
                      <span className="font-medium text-red-800">我已知晓全网暴露风险，确认允许绑定到 0.0.0.0</span>
                    </label>
                  </div>
                )}

                {ruleType !== "dynamic" && (
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[#1d1d1f] mb-1.5 font-semibold">目标地址 (Dest Host)</label>
                      <input
                        type="text"
                        value={destHost}
                        onChange={(e) => setDestHost(e.target.value)}
                        className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl font-mono text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                      />
                    </div>
                    <div>
                      <label className="block text-[#1d1d1f] mb-1.5 font-semibold">目标端口 (Dest Port)</label>
                      <input
                        type="number"
                        value={destPort}
                        onChange={(e) => setDestPort(Number(e.target.value))}
                        className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl font-mono text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                      />
                    </div>
                  </div>
                )}

                {ruleType === "dynamic" && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[#1d1d1f] mb-1.5 font-semibold">SOCKS5 认证模式</label>
                      <select
                        value={socksAuth}
                        onChange={(e) => setSocksAuth(e.target.value as SocksAuth)}
                        className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                      >
                        <option value="none">无须密码认证 (No-Auth)</option>
                        <option value="user_pass">用户名与密码认证 (RFC 1929)</option>
                      </select>
                    </div>

                    {socksAuth === "user_pass" && (
                      <div>
                        <label className="block text-[#1d1d1f] mb-1.5 font-semibold">认证用户名</label>
                        <input
                          type="text"
                          placeholder="用户名"
                          value={socksUsername}
                          onChange={(e) => setSocksUsername(e.target.value)}
                          className="w-full px-3 py-2 bg-[#f5f5f7] border border-black/[0.08] rounded-xl text-[#1d1d1f] outline-none focus:border-[#0071e3] focus:bg-white transition"
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="pt-2">
                  <label className="flex items-center gap-2 text-[#424245] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoStart}
                      onChange={(e) => setAutoStart(e.target.checked)}
                      className="rounded border-black/[0.2] text-[#0071e3] focus:ring-0 accent-[#0071e3]"
                    />
                    <span>连接会话时自动启动此转发规则</span>
                  </label>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setAddModalOpen(false)}
                  className="px-4 py-2 bg-black/[0.04] hover:bg-black/[0.08] border border-black/[0.08] text-[#1d1d1f] rounded-xl text-xs font-semibold active:scale-[0.98] transition"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={submitting}
                  className="px-4 py-2 bg-[#0071e3] hover:bg-[#0077ed] text-white rounded-xl text-xs font-semibold shadow-sm transition active:scale-[0.98] disabled:opacity-50"
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
