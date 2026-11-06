import React, { useEffect, useState } from "react";
import { useForwardStore } from "../stores/forwardStore";
import { useSessionStore } from "../stores/sessionStore";
import type {
  PortForwardRule,
  PortForwardType,
} from "../types/ipc";
import { formatFriendlyError } from "../lib/errors";
import { Badge, EmptyState, Panel } from "./ui/Surface";
import { Button, IconButton } from "./ui/Button";
import { Field, Input, Select } from "./ui/Field";
import { Switch, Checkbox, Segmented } from "./ui/Controls";
import { ConfirmDialog, Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";
import {
  ChevronRightIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  ArrowUpDownIcon,
} from "./ui/icons";

interface PortForwardModalProps {
  sessionId?: string;
  connId?: string;
  onClose: () => void;
}

const RULE_TYPE_LABEL: Record<PortForwardType, string> = {
  local: "本地 -L",
  remote: "远程 -R",
  dynamic: "动态 SOCKS5 -D",
};

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
    updateRule,
    deleteRule,
    toggleRule,
  } = useForwardStore();
  const { sessions } = useSessionStore();
  const sshSessions = sessions.filter((s) => s.protocol === "ssh");

  const [formModalOpen, setFormModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [targetSessionId, setTargetSessionId] = useState<string>(sessionId || "");
  const [ruleType, setRuleType] = useState<PortForwardType>("local");
  const [name, setName] = useState("");
  const [bindHost, setBindHost] = useState("127.0.0.1");
  const [bindPort, setBindPort] = useState<number>(8080);
  const [destHost, setDestHost] = useState("127.0.0.1");
  const [destPort, setDestPort] = useState<number>(80);
  const [socksAuth, setSocksAuth] = useState<string>("none");
  const [socksUsername, setSocksUsername] = useState("");
  const [socksPassword, setSocksPassword] = useState("");
  const [clearSocksPassword, setClearSocksPassword] = useState(false);
  const [hasStoredSocksPassword, setHasStoredSocksPassword] = useState(false);
  const [exposeAck, setExposeAck] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    loadRules(sessionId);
  }, [sessionId]);

  const isExposeRisky = bindHost === "0.0.0.0" || bindHost === "::";

  const openCreateModal = () => {
    setEditingRuleId(null);
    setTargetSessionId(sessionId || "");
    setRuleType("local");
    setName("");
    setBindHost("127.0.0.1");
    setBindPort(8080);
    setDestHost("127.0.0.1");
    setDestPort(80);
    setSocksAuth("none");
    setSocksUsername("");
    setSocksPassword("");
    setClearSocksPassword(false);
    setHasStoredSocksPassword(false);
    setExposeAck(false);
    setAutoStart(false);
    setAutoReconnect(true);
    setErrorMsg(null);
    setFormModalOpen(true);
  };

  const openEditModal = (rule: PortForwardRule) => {
    setEditingRuleId(rule.id);
    setTargetSessionId(rule.session_id || sessionId || "");
    setRuleType(rule.rule_type);
    setName(rule.name);
    setBindHost(rule.bind_host || "127.0.0.1");
    setBindPort(rule.bind_port || 8080);
    setDestHost(rule.dest_host || "127.0.0.1");
    setDestPort(rule.dest_port || 80);
    const normalizedAuth =
      (rule.socks_auth as string) === "user_pass" ? "userpass" : (rule.socks_auth || "none");
    setSocksAuth(normalizedAuth);
    setSocksUsername(rule.socks_username || "");
    setSocksPassword("");
    setClearSocksPassword(false);
    setHasStoredSocksPassword(Boolean((rule as any).has_socks_password || rule.socks_password_ref));
    setExposeAck(rule.expose_warning_ack || false);
    setAutoStart(rule.auto_start || false);
    setAutoReconnect(rule.auto_reconnect ?? true);
    setErrorMsg(null);
    setFormModalOpen(true);
  };

  const handleSaveRule = async () => {
    if (!name.trim()) {
      setErrorMsg("请输入规则名称");
      return;
    }
    if (isExposeRisky && !exposeAck) {
      setErrorMsg("绑定 0.0.0.0 具有全网暴露风险，必须确认安全风险方可保存！");
      return;
    }
    const isUserPass = socksAuth === "userpass" || (socksAuth as string) === "user_pass";
    if (ruleType === "dynamic" && isUserPass) {
      if (!socksUsername.trim()) {
        setErrorMsg("选择用户名口令认证时必须填写认证用户名");
        return;
      }
      if (!editingRuleId && !socksPassword) {
        setErrorMsg("选择用户名口令认证时必须填写认证密码");
        return;
      }
      if (editingRuleId && clearSocksPassword && !socksPassword) {
        setErrorMsg("已选择清除原密码，请填写新密码或改选无须密码认证");
        return;
      }
      if (editingRuleId && !hasStoredSocksPassword && !socksPassword) {
        setErrorMsg("选择用户名口令认证时必须填写认证密码");
        return;
      }
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const effectiveSessionId = sessionId || targetSessionId.trim() || null;
      const input: any = {
        session_id: effectiveSessionId,
        name: name.trim(),
        rule_type: ruleType,
        bind_host: bindHost.trim() || "127.0.0.1",
        bind_port: Number(bindPort),
        dest_host: ruleType === "dynamic" ? null : destHost.trim() || "127.0.0.1",
        dest_port: ruleType === "dynamic" ? null : Number(destPort),
        socks_auth: ruleType === "dynamic" ? (isUserPass ? "userpass" : "none") : "none",
        socks_username: (ruleType === "dynamic" && isUserPass) ? socksUsername.trim() : null,
        expose_warning_ack: exposeAck,
        auto_start: autoStart,
        auto_reconnect: autoReconnect,
      };

      if (ruleType === "dynamic" && isUserPass) {
        if (editingRuleId) {
          if (clearSocksPassword) {
            input.socks_clear_password = true;
            input.socks_password = null;
          } else if (socksPassword) {
            input.socks_password = socksPassword;
            input.socks_clear_password = false;
          } else {
            input.socks_clear_password = false;
          }
        } else {
          input.socks_password = socksPassword || null;
        }
      } else if (editingRuleId) {
        input.socks_clear_password = true;
        input.socks_password = null;
      }

      delete input.socks_password_ref;

      if (editingRuleId) {
        await updateRule(editingRuleId, input);
      } else {
        await createRule(input);
      }

      setFormModalOpen(false);
      setEditingRuleId(null);
    } catch (e: any) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggle = async (rule: PortForwardRule) => {
    setErrorMsg(null);
    try {
      await toggleRule(rule, connId);
    } catch (err) {
      setErrorMsg(formatFriendlyError(err));
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteRule(pendingDelete);
      setErrorMsg(null);
      setPendingDelete(null);
    } catch (e) {
      setErrorMsg(formatFriendlyError(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="端口转发与 SOCKS5 代理"
        widthClassName="w-full max-w-[740px]"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              关闭
            </Button>
            <Button
              variant="primary"
              leading={<PlusIcon className="h-3.5 w-3.5" />}
              onClick={openCreateModal}
            >
              新建规则
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {errorMsg && !formModalOpen && (
            <InlineNotice tone="danger" onDismiss={() => setErrorMsg(null)}>
              {errorMsg}
            </InlineNotice>
          )}

          {loading ? (
            <div className="py-12 text-center text-os-xs text-ink-tertiary">加载规则中...</div>
          ) : rules.length === 0 ? (
            <EmptyState
              icon={<ArrowUpDownIcon className="h-8 w-8" />}
              title="暂无端口转发规则"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  leading={<PlusIcon className="h-3.5 w-3.5" />}
                  onClick={openCreateModal}
                >
                  新建规则
                </Button>
              }
            />
          ) : (
            rules.map((rule) => {
              const status = statuses[rule.id] || { state: "Stopped" };
              const isListening = status.state === "Listening";
              const isError = status.state === "Error";
              const boundSession = rule.session_id
                ? sshSessions.find((s) => s.id === rule.session_id)
                : undefined;

              return (
                <Panel key={rule.id} padded={false} className="p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-os-sm font-semibold text-ink">
                          {rule.name}
                        </span>
                        <Badge tone="accent" className="font-mono uppercase">
                          {RULE_TYPE_LABEL[rule.rule_type]}
                        </Badge>
                        {boundSession && !sessionId && (
                          <Badge tone="neutral">
                            会话: {boundSession.name}
                          </Badge>
                        )}
                        {rule.auto_start && (
                          <Badge tone="neutral">自动启动</Badge>
                        )}
                        {isListening ? (
                          <Badge tone="success" className="gap-1 font-mono">
                            <span className="h-1.5 w-1.5 rounded-full bg-state-success" />
                            运行中 ·{" "}
                            <span className="max-w-[180px] truncate">
                              {(status as any).details?.bound_addr ||
                                `${rule.bind_host}:${rule.bind_port}`}
                            </span>
                          </Badge>
                        ) : isError ? (
                          <Badge tone="danger" className="font-mono">
                            <span className="max-w-[180px] truncate">
                              错误: {(status as any).details}
                            </span>
                          </Badge>
                        ) : (
                          <Badge tone="neutral" className="font-mono">
                            未启动
                          </Badge>
                        )}
                      </div>

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-os-xs text-ink-secondary">
                        <span>
                          {rule.rule_type === "remote" ? "远端监听 " : "本机监听 "}
                          {rule.bind_host}:{rule.bind_port}
                        </span>
                        {rule.rule_type !== "dynamic" && (
                          <>
                            <ChevronRightIcon className="h-3 w-3 text-ink-tertiary" />
                            <span>
                              {rule.rule_type === "remote" ? "本机目标 " : "远端目标 "}
                              {rule.dest_host}:{rule.dest_port}
                            </span>
                          </>
                        )}
                        {rule.rule_type === "dynamic" && (
                          <span className="font-sans text-os-2xs text-ink-tertiary">
                            · SOCKS5 动态转发（认证: {rule.socks_auth === "none" ? "无密码" : "用户名密码"}
                            {rule.socks_username ? ` · ${rule.socks_username}` : ""}
                            {Boolean((rule as any).has_socks_password || rule.socks_password_ref) ? " · 已设密码" : ""}
                            ）
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant={isListening ? "secondary" : "primary"}
                        onClick={() => handleToggle(rule)}
                      >
                        {isListening ? "停止" : "启动"}
                      </Button>
                      <IconButton
                        label="编辑规则"
                        size="sm"
                        className="text-ink-tertiary hover:bg-line/10 hover:text-ink"
                        onClick={() => openEditModal(rule)}
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        label="删除规则"
                        size="sm"
                        className="text-ink-tertiary hover:bg-state-danger/10 hover:text-state-danger"
                        onClick={() => setPendingDelete(rule.id)}
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </div>
                </Panel>
              );
            })
          )}
        </div>
      </Modal>

      {/* 新增 / 编辑规则 */}
      <Modal
        open={formModalOpen}
        onClose={() => {
          setFormModalOpen(false);
          setEditingRuleId(null);
        }}
        title={editingRuleId ? "编辑端口转发规则" : "创建端口转发规则"}
        widthClassName="w-full max-w-[540px]"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setFormModalOpen(false);
                setEditingRuleId(null);
              }}
            >
              取消
            </Button>
            <Button variant="primary" loading={submitting} onClick={handleSaveRule}>
              {editingRuleId ? "保存修改" : "确认创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {errorMsg && (
            <InlineNotice tone="danger" onDismiss={() => setErrorMsg(null)}>
              {errorMsg}
            </InlineNotice>
          )}

          {!sessionId && (
            <Field label="所属 SSH 会话">
              <Select
                value={targetSessionId}
                onChange={(e) => setTargetSessionId(e.target.value)}
              >
                <option value="">全局规则（不固定绑定单个会话）</option>
                {sshSessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.username || "root"}@{s.host || "127.0.0.1"}:{s.port || 22})
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="规则类型">
            <Segmented<PortForwardType>
              value={ruleType}
              onChange={setRuleType}
              ariaLabel="转发规则类型"
              options={[
                { value: "local", label: "本地 -L" },
                { value: "remote", label: "远程 -R" },
                { value: "dynamic", label: "SOCKS5 -D" },
              ]}
            />
          </Field>

          <Field label="规则名称" required value={name}>
            <Input
              type="text"
              aria-label="规则名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={
                ruleType === "remote"
                  ? "远端监听地址 (Remote Bind Host)"
                  : "本地监听地址 (Bind Host)"
              }
            >
              <Input
                type="text"
                mono
                value={bindHost}
                onChange={(e) => setBindHost(e.target.value)}
              />
            </Field>
            <Field
              label={
                ruleType === "remote"
                  ? "远端监听端口 (Remote Bind Port)"
                  : "本地监听端口 (Bind Port)"
              }
            >
              <Input
                type="number"
                mono
                value={bindPort}
                onChange={(e) => setBindPort(Number(e.target.value))}
              />
            </Field>
          </div>

          {isExposeRisky && (
            <InlineNotice tone="danger" title="高危安全警告 (SEC-005)">
              <div className="space-y-2">
                <p>您将端口绑定到了 0.0.0.0，局域网与公网上的所有主机均可直接访问此端口。</p>
                <Checkbox
                  checked={exposeAck}
                  onChange={setExposeAck}
                  label={
                    <span className="text-state-danger">
                      我已知晓全网暴露风险，确认允许绑定到 0.0.0.0
                    </span>
                  }
                />
              </div>
            </InlineNotice>
          )}

          {ruleType !== "dynamic" && (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={
                  ruleType === "remote"
                    ? "本地目标地址 (Local Dest Host)"
                    : "远端目标地址 (Dest Host)"
                }
              >
                <Input
                  type="text"
                  mono
                  value={destHost}
                  onChange={(e) => setDestHost(e.target.value)}
                />
              </Field>
              <Field
                label={
                  ruleType === "remote"
                    ? "本地目标端口 (Local Dest Port)"
                    : "远端目标端口 (Dest Port)"
                }
              >
                <Input
                  type="number"
                  mono
                  value={destPort}
                  onChange={(e) => setDestPort(Number(e.target.value))}
                />
              </Field>
            </div>
          )}

          {ruleType === "dynamic" && (
            <div className="space-y-3">
              <Field label="SOCKS5 认证模式">
                <Select
                  value={socksAuth === "user_pass" ? "userpass" : socksAuth}
                  onChange={(e) => setSocksAuth(e.target.value)}
                >
                  <option value="none">无须密码认证 (No-Auth)</option>
                  <option value="userpass">用户名与密码认证 (RFC 1929)</option>
                </Select>
              </Field>

              {(socksAuth === "userpass" || socksAuth === "user_pass") && (
                <>
                  <Field label="认证用户名" required value={socksUsername}>
                    <Input
                      type="text"
                      aria-label="认证用户名"
                      value={socksUsername}
                      onChange={(e) => setSocksUsername(e.target.value)}
                    />
                  </Field>
                  <Field
                    label={
                      <div className="flex items-center justify-between w-full">
                        <span>
                          认证密码
                          {editingRuleId && hasStoredSocksPassword && !clearSocksPassword && (
                            <span className="ml-1.5 font-normal text-accent text-os-2xs">已存</span>
                          )}
                        </span>
                        {editingRuleId && hasStoredSocksPassword && (
                          <label className="flex items-center gap-1 text-[11px] font-normal text-ink-tertiary cursor-pointer">
                            <input
                              type="checkbox"
                              checked={clearSocksPassword}
                              onChange={(e) => {
                                setClearSocksPassword(e.target.checked);
                                if (e.target.checked) setSocksPassword("");
                              }}
                              className="rounded border-line/20 text-accent"
                            />
                            <span>清除</span>
                          </label>
                        )}
                      </div>
                    }
                    required={!editingRuleId || !hasStoredSocksPassword || clearSocksPassword}
                    value={socksPassword || (editingRuleId && hasStoredSocksPassword && !clearSocksPassword ? "saved" : "")}
                  >
                    <Input
                      type="password"
                      aria-label="认证密码"
                      disabled={clearSocksPassword}
                      value={socksPassword}
                      onChange={(e) => setSocksPassword(e.target.value)}
                    />
                  </Field>
                </>
              )}
            </div>
          )}

          <Switch
            checked={autoStart}
            onChange={setAutoStart}
            label="自动启动"
          />

          <Switch
            checked={autoReconnect}
            onChange={setAutoReconnect}
            label="断线自动恢复"
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除转发规则"
        tone="danger"
        confirmText="删除"
        busy={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        message={
          <>
            即将删除规则{" "}
            <strong className="text-ink">
              {rules.find((rule) => rule.id === pendingDelete)?.name}
            </strong>
            ，此操作不可恢复。
          </>
        }
      />
    </>
  );
};
