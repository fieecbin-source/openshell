import React, { useState, useEffect, useRef } from "react";
import type { SshKey } from "../types/ipc";
import { listSshKeys, importSshKey, deleteSshKey, setSshKeyPassphrase } from "../lib/ipc";
import { formatFriendlyError } from "../lib/errors";

interface SshKeyManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedKeyId?: string;
  onSelectKey?: (key: SshKey) => void;
}

export const SshKeyManagerModal: React.FC<SshKeyManagerModalProps> = ({
  isOpen,
  onClose,
  selectedKeyId: initialSelectedKeyId,
  onSelectKey,
}) => {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [activeKeyId, setActiveKeyId] = useState<string>(initialSelectedKeyId || "");
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Import Drawer State
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPem, setNewKeyPem] = useState("");
  const [newKeyFileName, setNewKeyFileName] = useState("");
  const [newKeyPassphrase, setNewKeyPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [importing, setImporting] = useState(false);

  // 为已加密私钥补录/重置口令
  const [passphraseKey, setPassphraseKey] = useState<SshKey | null>(null);
  const [passphraseValue, setPassphraseValue] = useState("");
  const [showEditPassphrase, setShowEditPassphrase] = useState(false);
  const [savingPassphrase, setSavingPassphrase] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadKeys = async (preferSelectId?: string) => {
    setIsLoading(true);
    try {
      const data = await listSshKeys();
      setKeys(data);
      if (preferSelectId) {
        setActiveKeyId(preferSelectId);
      } else if (!activeKeyId && data.length > 0) {
        setActiveKeyId(data[0].id);
      }
    } catch (err: any) {
      setError(formatFriendlyError(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadKeys(initialSelectedKeyId);
      setShowImportPanel(false);
      setError(null);
      setNotice(null);
      setNewKeyName("");
      setNewKeyPem("");
      setNewKeyFileName("");
      setNewKeyPassphrase("");
      setPassphraseKey(null);
      setPassphraseValue("");
    }
  }, [isOpen, initialSelectedKeyId]);

  if (!isOpen) return null;

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setNewKeyFileName(file.name);
    if (!newKeyName.trim()) {
      const baseName = file.name.replace(/\.(pem|key|pub)$/i, "");
      setNewKeyName(baseName);
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setNewKeyPem(content);
        setShowImportPanel(true);
        setNotice(null);
        setError(null);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImportSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyPem.trim()) {
      setError("请选择私钥文件或在下方文本框中粘贴私钥 PEM 内容");
      return;
    }

    setImporting(true);
    setError(null);
    setNotice(null);

    const nameToSave =
      newKeyName.trim() ||
      `key-${new Date().toISOString().slice(5, 10).replace("-", "")}`;

    try {
      const imported = await importSshKey(
        nameToSave,
        newKeyPem.trim(),
        newKeyPassphrase.trim() || undefined
      );

      // 检查是否已经存在于旧列表中
      const alreadyExisted = keys.some((k) => k.id === imported.id);

      await loadKeys(imported.id);
      setActiveKeyId(imported.id);
      setShowImportPanel(false);
      setNewKeyName("");
      setNewKeyPem("");
      setNewKeyFileName("");
      setNewKeyPassphrase("");

      if (alreadyExisted) {
        setNotice(`该私钥（指纹：${imported.fingerprint_sha256.slice(0, 16)}...）已存在于私钥库中，已为您自动定位并选中！`);
      } else {
        setNotice(`私钥「${imported.name}」导入成功，已安全加密存入保险库并自动选中！`);
      }
    } catch (err: any) {
      setError(formatFriendlyError(err));
    } finally {
      setImporting(false);
    }
  };

  const handleSavePassphrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphraseKey) return;
    if (!passphraseValue) {
      setError("请输入该私钥的口令 (Passphrase)");
      return;
    }

    setSavingPassphrase(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await setSshKeyPassphrase(passphraseKey.id, passphraseValue);
      await loadKeys(updated.id);
      setNotice(`私钥「${updated.name}」的口令已保存，现在可以使用它连接服务器了。`);
      setPassphraseKey(null);
      setPassphraseValue("");
      setShowEditPassphrase(false);
    } catch (err: any) {
      setError(formatFriendlyError(err));
    } finally {
      setSavingPassphrase(false);
    }
  };

  const handleDelete = async (key: SshKey) => {
    const confirmMsg =
      `确定要从 OpenShell 中移除私钥「${key.name}」的配置记录吗？\n\n` +
      `🛡️ 安全提示：\n` +
      `• 本操作仅从软件私钥库中移除配置，绝对不会删除您硬盘上的任何物理私钥文件；\n` +
      `• 关联了此私钥的服务器会话将自动解除绑定。`;

    if (!window.confirm(confirmMsg)) return;

    try {
      await deleteSshKey(key.id);
      setNotice(`私钥「${key.name}」配置已成功移除，磁盘原文件未受任何影响。`);
      await loadKeys();
      if (activeKeyId === key.id) {
        setActiveKeyId("");
      }
    } catch (err: any) {
      setError(`删除私钥配置失败: ${formatFriendlyError(err)}`);
    }
  };

  const handleConfirmSelect = () => {
    const selectedKey = keys.find((k) => k.id === activeKeyId);
    if (selectedKey && onSelectKey) {
      onSelectKey(selectedKey);
    }
    onClose();
  };

  const filteredKeys = keys.filter((k) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      k.name.toLowerCase().includes(q) ||
      k.algorithm.toLowerCase().includes(q) ||
      k.fingerprint_sha256.toLowerCase().includes(q)
    );
  });

  const selectedKey = keys.find((k) => k.id === activeKeyId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="flex flex-col w-full max-w-4xl max-h-[90vh] rounded-2xl border border-slate-200/80 bg-white shadow-2xl overflow-hidden text-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-apple-blue/10 text-apple-blue shadow-apple-sm text-lg font-bold">
              🔑
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 tracking-tight">
                  SSH 私钥管理中心
                </h2>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 border border-emerald-200">
                  端到端保险库加密
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                集中配置与管理用于 SSH 免密登录的私钥凭据（支持 RSA、ED25519、ECDSA）
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-600 transition"
            title="关闭模态框"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Safety Banner */}
        <div className="bg-amber-50/60 border-b border-amber-200/50 px-6 py-2 flex items-center justify-between text-xs text-amber-800">
          <div className="flex items-center gap-2">
            <span>🛡️</span>
            <span>
              <strong>安全原则：</strong> 此处配置和删除仅维护 OpenShell 内的私钥条目，<strong>绝对不会删除或修改您本地硬盘上的实际文件</strong>。
            </span>
          </div>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-apple-blue text-white text-xs font-semibold hover:bg-apple-hoverBlue shadow-apple-sm transition shrink-0 ml-4"
          >
            <span>📁 选取本地私钥文件导入</span>
          </button>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="hidden"
            accept=".pem,.key,id_rsa,id_ed25519,id_ecdsa,*"
          />
        </div>

        {/* Notification / Error alert */}
        {notice && (
          <div className="mx-6 mt-3 px-3.5 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-700 flex items-center justify-between animate-in fade-in">
            <div className="flex items-center gap-2">
              <span>✅</span>
              <span>{notice}</span>
            </div>
            <button onClick={() => setNotice(null)} className="text-emerald-500 hover:text-emerald-700 font-bold ml-2">
              ✕
            </button>
          </div>
        )}

        {error && (
          <div className="mx-6 mt-3 px-3.5 py-2 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between animate-in fade-in">
            <div className="flex items-center gap-2">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
            <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700 font-bold ml-2">
              ✕
            </button>
          </div>
        )}

        {/* Toolbar & Search */}
        <div className="flex items-center justify-between px-6 pt-3 pb-2 gap-3">
          <div className="relative flex-1 max-w-sm">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索私钥名称、算法或指纹..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:bg-white focus:border-apple-blue focus:outline-none transition"
            />
            <svg
              className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowImportPanel(!showImportPanel)}
              className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition flex items-center gap-1.5 ${
                showImportPanel
                  ? "bg-slate-200 border-slate-300 text-slate-800"
                  : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 shadow-apple-sm"
              }`}
            >
              <span>{showImportPanel ? "收起录入面板" : "➕ 录入/粘贴私钥"}</span>
            </button>
          </div>
        </div>

        {/* Import Panel Collapsible */}
        {showImportPanel && (
          <div className="mx-6 mb-3 p-4 rounded-xl border border-apple-blue/20 bg-apple-blue/[0.03] space-y-3 animate-in fade-in duration-150">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <span>📥</span>
                <span>导入新私钥</span>
              </span>
            </div>

            <form onSubmit={handleImportSubmit} className="space-y-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  私钥文件 / 内容
                </label>
                <div className="flex items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:border-apple-blue/40 hover:text-apple-blue shadow-apple-sm transition"
                  >
                    📁 浏览本地私钥文件
                  </button>
                  <span className="text-[11px] text-slate-500 truncate" title={newKeyFileName}>
                    {newKeyFileName || "尚未选择文件，可在下方直接粘贴"}
                  </span>
                </div>
                <textarea
                  rows={4}
                  value={newKeyPem}
                  onChange={(e) => setNewKeyPem(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY----- 或 -----BEGIN RSA PRIVATE KEY-----&#10;..."
                  className="w-full font-mono text-[11px] rounded-lg border border-slate-200 bg-white p-2.5 text-slate-800 focus:border-apple-blue focus:outline-none transition"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  私钥口令 Passphrase (私钥未加密可留空)
                </label>
                <div className="relative">
                  <input
                    type={showPassphrase ? "text" : "password"}
                    value={newKeyPassphrase}
                    onChange={(e) => setNewKeyPassphrase(e.target.value)}
                    placeholder="未加密私钥无需填写..."
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 pr-8 text-xs text-slate-800 focus:border-apple-blue focus:outline-none transition"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassphrase(!showPassphrase)}
                    className="absolute right-2 top-1.5 text-slate-400 hover:text-slate-600 text-xs"
                  >
                    {showPassphrase ? "隐藏" : "显示"}
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-slate-400">
                  私钥若带口令，请在此填写；已导入的私钥可稍后在列表中单独设置口令。
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  私钥别名 (Name)
                </label>
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="如：生产集群密钥、id_rsa_web"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800 focus:border-apple-blue focus:outline-none transition"
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowImportPanel(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-100 transition"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={importing}
                  className="px-4 py-1.5 rounded-lg bg-apple-blue text-white text-xs font-semibold hover:bg-apple-hoverBlue shadow-apple-sm transition disabled:opacity-50"
                >
                  {importing ? "正在解析导入..." : "确认并导入私钥"}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Key List Section */}
        <div className="flex-1 overflow-y-auto px-6 py-2 space-y-2">
          {isLoading && keys.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-400">正在加载已配置的私钥...</div>
          ) : filteredKeys.length === 0 ? (
            <div className="py-16 text-center border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50 p-8 space-y-3">
              <div className="text-3xl">🔑</div>
              <h3 className="text-sm font-semibold text-slate-700">
                {searchQuery ? "未找到匹配的私钥" : "尚未导入任何 SSH 私钥"}
              </h3>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">
                {searchQuery
                  ? "请尝试搜索其他关键字"
                  : "点击上方「选取本地私钥文件导入」或「录入/粘贴私钥」，即可快速将私钥加入列表，用于服务器免密公钥连接。"}
              </p>
              {!showImportPanel && !searchQuery && (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-apple-blue text-white text-xs font-semibold shadow-apple-md hover:bg-apple-hoverBlue transition"
                >
                  <span>📁 选择本地私钥文件 (.pem / id_rsa)</span>
                </button>
              )}
            </div>
          ) : (
            filteredKeys.map((k) => {
              const isSelected = activeKeyId === k.id;
              return (
                <div
                  key={k.id}
                  onClick={() => setActiveKeyId(k.id)}
                  className={`group relative p-3.5 rounded-xl border transition cursor-pointer flex items-center justify-between ${
                    isSelected
                      ? "bg-apple-blue/5 border-apple-blue ring-2 ring-apple-blue/30 shadow-apple-sm"
                      : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50/60"
                  }`}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center border transition shrink-0 ${
                        isSelected
                          ? "border-apple-blue bg-apple-blue text-white"
                          : "border-slate-300 bg-white group-hover:border-slate-400"
                      }`}
                    >
                      {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>

                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-slate-900 truncate">
                          {k.name}
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-slate-600 shrink-0">
                          {k.algorithm.toUpperCase()}
                        </span>
                        {k.has_passphrase ? (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200 shrink-0">
                            🔒 密码口令保护
                          </span>
                        ) : (
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 shrink-0">
                            无口令
                          </span>
                        )}
                        {isSelected && (
                          <span className="rounded-full bg-apple-blue/10 px-2 py-0.5 text-[10px] font-bold text-apple-blue">
                            当前选中
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-[11px] text-slate-400 font-mono">
                        <span className="truncate max-w-xs" title={k.fingerprint_sha256}>
                          指纹: {k.fingerprint_sha256}
                        </span>
                        <span>•</span>
                        <span>{new Date(k.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-4">
                    {k.has_passphrase && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPassphraseKey(k);
                          setPassphraseValue("");
                          setShowEditPassphrase(false);
                          setError(null);
                        }}
                        className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-600 hover:text-apple-blue hover:border-apple-blue/40 shadow-apple-sm transition"
                        title="设置或更新该私钥的口令 (Passphrase)"
                      >
                        设置口令
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(k);
                      }}
                      className="px-2 py-1 rounded-lg text-[11px] text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                      title="删除此私钥配置（不影响本地磁盘物理文件）"
                    >
                      <span>🗑️ 删除配置</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-100 px-6 py-4 bg-slate-50/70 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            {selectedKey ? (
              <span>
                已选定私钥：<strong className="text-slate-800">{selectedKey.name}</strong> ({selectedKey.algorithm.toUpperCase()})
              </span>
            ) : (
              <span>未选定任何私钥</span>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 transition shadow-apple-sm"
            >
              取消
            </button>

            {onSelectKey && (
              <button
                type="button"
                onClick={handleConfirmSelect}
                disabled={!selectedKey}
                className="px-5 py-2 rounded-xl bg-apple-blue text-xs font-semibold text-white shadow-apple-md hover:bg-apple-hoverBlue transition disabled:opacity-40"
              >
                选定并应用到会话
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 设置私钥口令 */}
      {passphraseKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4 animate-in fade-in">
          <form
            onSubmit={handleSavePassphrase}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🔒</span>
                <h3 className="text-sm font-bold text-slate-900">
                  设置私钥口令 - {passphraseKey.name}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPassphraseKey(null)}
                className="text-slate-400 hover:text-slate-600 text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                私钥口令 Passphrase
              </label>
              <div className="relative">
                <input
                  type={showEditPassphrase ? "text" : "password"}
                  value={passphraseValue}
                  onChange={(e) => setPassphraseValue(e.target.value)}
                  autoFocus
                  placeholder="输入解密该私钥所用的口令"
                  className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-10 text-xs text-slate-800 focus:border-apple-blue focus:outline-none transition"
                />
                <button
                  type="button"
                  onClick={() => setShowEditPassphrase(!showEditPassphrase)}
                  className="absolute right-2 top-2 text-slate-400 hover:text-slate-600 text-xs"
                >
                  {showEditPassphrase ? "隐藏" : "显示"}
                </button>
              </div>
              <p className="mt-1.5 text-[10px] text-slate-400">
                口令会加密保存到主保险库，连接服务器时自动使用。
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setPassphraseKey(null)}
                className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-100 transition"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={savingPassphrase}
                className="px-4 py-1.5 rounded-xl bg-apple-blue text-white text-xs font-semibold hover:bg-apple-hoverBlue shadow-apple-sm transition disabled:opacity-50"
              >
                {savingPassphrase ? "正在校验口令..." : "保存口令"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
