import React, { useEffect, useState } from "react";
import { useSyncStore } from "../stores/syncStore";
import { formatFriendlyError } from "../lib/errors";
import { Panel } from "./ui/Surface";
import { Button } from "./ui/Button";
import { Field, Input } from "./ui/Field";
import { Segmented, Switch } from "./ui/Controls";
import { Modal } from "./ui/Overlay";
import { InlineNotice } from "./ui/Notice";
import { CloudIcon, DownloadIcon, RefreshIcon, ShieldIcon } from "./ui/icons";

type AuthMode = "login" | "register";

/**
 * 统一服务端地址：用户可能只填 `sync.example.com`、带尾斜杠或带空格。
 * 客户端会自行拼接 `/v1/...`，所以这里只补协议、去尾斜杠，不做任何域名白名单限制
 * —— 每个人填自己的公网 / 内网服务端都能用。
 */
const normalizeServerUrl = (raw: string): string => {
  const value = raw.trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "");
  // 没写协议时按端口推断：带 8085 这类非 443 端口说明是明文直连，其余默认 https
  const host = value.split("/")[0];
  const port = /:(\d+)$/.exec(host)?.[1];
  const scheme = port && port !== "443" ? "http" : "https";
  return `${scheme}://${value}`.replace(/\/+$/, "");
};

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
    clearLocalSyncData,
    syncNow,
    checkUpdates,
  } = useSyncStore();

  const [mode, setMode] = useState<AuthMode>("login");
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
    const target = normalizeServerUrl(serverUrl);
    if (!/^https?:\/\/[^\s/]+/i.test(target)) {
      setSyncFeedback("服务端地址格式不正确，示例：https://sync.example.com 或 http://1.2.3.4:8080");
      return;
    }
    // 回填规范化后的地址，避免用户看到的与实际使用的不同
    setServerUrl(target);
    try {
      if (mode === "register") {
        await register(target, email, password, inviteCode || undefined);
        setSyncFeedback("注册并完成首次同步。");
      } else {
        await login(target, email, password);
        setPassword("");
        setSyncFeedback("登录并完成首次同步，后续变更将自动同步。");
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
      setSyncFeedback(`同步失败: ${formatFriendlyError(err)}`);
    }
  };

  const handleAutoSyncToggle = async (val: boolean) => {
    setAutoSync(val);
    try {
      await saveConfig(normalizeServerUrl(serverUrl), val);
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

  const feedbackFailed = syncFeedback?.startsWith("同步失败");

  return (
    <Modal
      open
      onClose={() => setModalOpen(false)}
      title="自建服务端与加密同步"
      description="填写自己的域名、账号和密码，登录后自动同步"
      widthClassName="w-full max-w-[520px]"
    >
      <div className="space-y-3.5">
        <InlineNotice
          tone="accent"
          title={
            <span className="flex items-center gap-1.5">
              <ShieldIcon className="h-3.5 w-3.5" />
              客户端加密同步
            </span>
          }
        >
          数据在客户端加密后上传。同步密码同时用于解锁同步保险库，请妥善保管服务器上的账号配置。
        </InlineNotice>

        {error && (
          <InlineNotice tone="danger">
            {error}
          </InlineNotice>
        )}

        {syncFeedback && (
          <InlineNotice tone={feedbackFailed ? "danger" : "success"} onDismiss={() => setSyncFeedback(null)}>
            {syncFeedback}
          </InlineNotice>
        )}

        {config?.is_logged_in ? (
          <div className="space-y-3.5">
            <Panel className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-os-xs">
                <span className="text-ink-tertiary">同步服务端地址</span>
                <span className="max-w-[260px] truncate font-mono text-accent" title={config.server_url || ""}>
                  {config.server_url || "未配置"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-os-xs">
                <span className="text-ink-tertiary">本地设备 ID</span>
                <span className="max-w-[220px] truncate font-mono text-ink-secondary">
                  {config.device_id}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-os-xs">
                <span className="text-ink-tertiary">上次拉取时间</span>
                <span className="text-ink-secondary">
                  {config.last_sync_at
                    ? new Date(config.last_sync_at).toLocaleString()
                    : "未同步"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 text-os-xs">
                <span className="text-ink-tertiary">冲突副本状态</span>
                <span
                  className={
                    config.conflict_count > 0
                      ? "font-medium text-state-warning"
                      : "text-ink-tertiary"
                  }
                >
                  {config.conflict_count > 0
                    ? `${config.conflict_count} 个冲突副本（已保留）`
                    : "正常（无冲突）"}
                </span>
              </div>
            </Panel>

            <Panel>
              <Switch
                checked={autoSync}
                onChange={handleAutoSyncToggle}
                label="自动增量同步"
                hint="数据变动时及周期自动推送与合并"
              />
            </Panel>

            <div className="grid grid-cols-2 gap-2.5">
              <Button
                variant="primary"
                loading={syncing}
                leading={<RefreshIcon className="h-3.5 w-3.5" />}
                onClick={handleManualSync}
              >
                {syncing ? "同步中..." : "立即同步"}
              </Button>
              <Button
                variant="secondary"
                leading={<DownloadIcon className="h-3.5 w-3.5" />}
                onClick={handleCheckUpdate}
              >
                检查软件更新
              </Button>
            </div>

            <div className="flex items-center justify-between pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-ink-tertiary hover:text-ink text-xs"
                onClick={async () => {
                  if (window.confirm("确定要清除本地同步状态与缓存吗？本地保存的会话和配置不会受到影响。")) {
                    await clearLocalSyncData();
                    setSyncFeedback("本地同步数据已清除");
                  }
                }}
              >
                清除本地同步数据
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-state-danger hover:bg-state-danger/10 hover:text-state-danger text-xs"
                onClick={() => logout()}
              >
                退出当前账号
              </Button>
            </div>
          </div>
        ) : (
          /* 登录 / 注册表单 */
          <form onSubmit={handleSubmitAuth} className="space-y-3">
            <Segmented<AuthMode>
              value={mode}
              onChange={setMode}
              ariaLabel="同步账号认证方式"
              className="w-full"
              options={[
                { value: "login", label: "登录账号 (单用户/自建)" },
                { value: "register", label: "注册账号" },
              ]}
            />

            <Field label="服务端地址 (HTTPS/HTTP)" required>
              <Input
                type="text"
                required
                mono
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="http://1.2.3.4:8085 或 https://sync.example.com"
              />
            </Field>

            <Field label="账号 / 用户名" required hint="支持单用户自用模式下配置的用户名或邮箱">
              <Input
                type="text"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin 或自定义账号名"
              />
            </Field>

            <Field label="密码" required hint="非空，最多 128 位">
              <Input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
            </Field>

            {mode === "register" && (
              <Field label="邀请码 / 引导令牌" hint="单用户首次注册或受邀注册时填写，选填">
                <Input
                  type="text"
                  mono
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="选填"
                />
              </Field>
            )}

            <Button
              type="submit"
              variant="primary"
              loading={syncing}
              className="mt-1 w-full"
              leading={!syncing ? <CloudIcon className="h-3.5 w-3.5" /> : undefined}
            >
              {syncing ? "处理中..." : mode === "login" ? "登录" : "注册并绑定"}
            </Button>
          </form>
        )}
      </div>
    </Modal>
  );
};
