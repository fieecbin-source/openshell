import React, { useEffect, useState } from "react";
import { useForwardStore } from "../stores/forwardStore";
import { useSessionStore } from "../stores/sessionStore";
import type {
  PortForwardRule,
  PortForwardRuleInput,
  PortForwardType,
  SocksAuth,
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

const RULE_TYPE_DIRECTION_DESC: Record<PortForwardType, string> = {
  local: "本地端口转发 (-L)：监听本机端口，将流量经 SSH 隧道转发至远端目标地址",
  remote: "远端反向转发 (-R)：监听远端 SSH 服务器端口，将流量经隧道反向转发至本机侧目标",
  dynamic: "动态 SOCKS5 代理 (-D)：在本机启动 SOCKS5 代理服务器，按请求目标动态经 SSH 转发",
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
  const [socksAuth, setSocksAuth] = useState<SocksAuth>("none");
  const [socksUsername, setSocksUsername] = useState("");
  // 动态转发的 SOCKS5 口令。后端要求「选了用户名口令认证就必须给出非空口令」，
  // 否则会拒绝启动（历史上口令被写死为 None，等于任意凭据都放行）。
  const [socksPassword, setSocksPassword] = useState("");
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
    setSocksAuth(rule.socks_auth || "none");
    setSocksUsername(rule.socks_username || "");
    setSocksPassword(rule.socks_password_ref || "");
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
    if (
      ruleType === "dynamic" &&
      socksAuth === "user_pass" &&
      (!socksUsername.trim() || !socksPassword)
    ) {
      setErrorMsg("选择用户名口令认证时必须填写用户名与口令，否则无法启动代理");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    try {
      const effectiveSessionId = sessionId || targetSessionId.trim() || null;
      const input: PortForwardRuleInput = {
        session_id: effectiveSessionId,
        name: name.trim(),
        rule_type: ruleType,
        bind_host: bindHost.trim() || "127.0.0.1",
        bind_port: Number(bindPort),
        dest_host: ruleType === "dynamic" ? null : destHost.trim() || "127.0.0.1",
        dest_port: ruleType === "dynamic" ? null : Number(destPort),
        socks_auth: socksAuth,
        socks_username: socksAuth === "user_pass" ? socksUsername.trim() : null,
        socks_password_ref: socksAuth === "user_pass" ? socksPassword : null,
        expose_warning_ack: exposeAck,
        auto_start: autoStart,
        auto_reconnect: autoReconnect,
      };

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
        description="本地端口转发 (-L)、远程反向转发 (-R) 及动态 SOCKS5 代理 (-D)"
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
              description="新建规则以创建本地转发 (-L)、远程转发 (-R) 或动态 SOCKS5 代理 (-D)。"
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
                            · SOCKS5 动态转发（认证: {rule.socks_auth === "none" ? "无密码" : "用户名密码"}）
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant={isListening ? "secondary" : "primary"}
                        onClick={() => toggleRule(rule, connId)}
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
            <Field label="所属 SSH 会话" hint="将此转发规则关联到指定 SSH 主机">
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

          <Field label="规则类型" hint={RULE_TYPE_DIRECTION_DESC[ruleType]}>
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

          <Field label="规则名称" required>
            <Input
              type="text"
              placeholder="例如: MySQL 隧道 / 内网 Web 暴露"
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
                  value={socksAuth}
                  onChange={(e) => setSocksAuth(e.target.value as SocksAuth)}
                >
                  <option value="none">无须密码认证 (No-Auth)</option>
                  <option value="user_pass">用户名与密码认证 (RFC 1929)</option>
                </Select>
              </Field>

              {socksAuth === "user_pass" && (
                <>
                  <Field label="认证用户名">
                    <Input
                      type="text"
                      placeholder="用户名"
                      value={socksUsername}
                      onChange={(e) => setSocksUsername(e.target.value)}
                    />
                  </Field>
                  <Field label="认证口令 (密码)">
                    <Input
                      type="password"
                      placeholder="SOCKS5 认证口令"
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
            hint="连接会话时自动启动此转发规则"
          />

          <Switch
            checked={autoReconnect}
            onChange={setAutoReconnect}
            label="断线自动恢复"
            hint="SSH 重连后自动重新建立此端口转发隧道"
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
