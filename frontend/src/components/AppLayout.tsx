import React, { useEffect, useState } from "react";
import type { Session, SessionInput } from "../types/ipc";
import { useVaultStore } from "../stores/vaultStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSessionStore } from "../stores/sessionStore";
import { SessionTree } from "./SessionTree";
import { TerminalTabs } from "./TerminalTabs";
import { XtermView } from "./XtermView";
import { SessionModal } from "./SessionModal";
import { VaultUnlockModal } from "./VaultUnlockModal";
import { TransferQueueDrawer } from "./TransferQueueDrawer";
import { RemoteEditorModal } from "./RemoteEditorModal";
import { MonitorDashboard } from "./MonitorDashboard";
import { PortForwardModal } from "./PortForwardModal";
import { SnippetBar } from "./SnippetBar";
import { MultiExecBar } from "./MultiExecBar";
import { ImportExportModal } from "./ImportExportModal";
import { SettingsModal } from "./SettingsModal";
import { SyncSettingsModal } from "./SyncSettingsModal";
import { PortCheckerModal } from "./PortCheckerModal";
import { SyncStatusWidget } from "./SyncStatusWidget";
import { CommandPaletteModal } from "./CommandPaletteModal";
import { useSyncStore } from "../stores/syncStore";
import { SerialControlBar } from "./SerialControlBar";
import { SerialSendBar } from "./SerialSendBar";
import { HexDumpView } from "./HexDumpView";
import { useSerialStore } from "../stores/serialStore";
import { SftpView } from "./SftpView";
import { DisconnectedBackdrop } from "./DisconnectedBackdrop";
import { useSftpStore } from "../stores/sftpStore";

export const AppLayout: React.FC = () => {
  const { status, lock } = useVaultStore();
  const { tabs, activeTabId, reconnectTab, toggleMode } = useTerminalStore();
  const { sessions } = useSessionStore();
  const { loadSettings, setSettingsModalOpen } = useSettingsStore();
  const { loadConfig: loadSyncConfig } = useSyncStore();
  const { viewMode } = useSerialStore();
  const { transfers, transferQueueOpen, setTransferQueueOpen } = useSftpStore();

  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<Session | null>(null);
  const [initialSessionValues, setInitialSessionValues] = useState<Partial<SessionInput> | undefined>();

  // 命令面板快捷键与状态
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // M3/M5 侧边栏与功能抽屉状态
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [forwardModalOpen, setForwardModalOpen] = useState(false);
  const [multiExecOpen, setMultiExecOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [portCheckerOpen, setPortCheckerOpen] = useState(false);

  useEffect(() => {
    loadSettings();
    loadSyncConfig();
  }, []);

  // 监听全局 Ctrl+K / Cmd+K 唤起命令面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const activeTab = tabs.find((t) => t.tabId === activeTabId);
  const isConnected = activeTab && activeTab.status === "connected" && (activeTab.connectionId || activeTab.protocol === "serial");

  const handleNewSession = (initialGroupId?: string) => {
    setEditingSession(null);
    setInitialSessionValues(initialGroupId ? { group_id: initialGroupId } : undefined);
    setIsSessionModalOpen(true);
  };

  const handleNewSessionWithValues = (values?: Partial<SessionInput>) => {
    setEditingSession(null);
    setInitialSessionValues(values);
    setIsSessionModalOpen(true);
  };

  const handleEditSession = (session: Session) => {
    setEditingSession(session);
    setInitialSessionValues(undefined);
    setIsSessionModalOpen(true);
  };

  // 快捷保存当前活动标签为新会话或编辑对应会话
  const handleSaveActiveTabAsSession = () => {
    if (!activeTab) return;
    const existing = sessions.find((s) => s.id === activeTab.sessionId);
    if (existing) {
      handleEditSession(existing);
    } else {
      handleNewSessionWithValues({
        name: activeTab.sessionName,
        protocol: activeTab.protocol,
      });
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-surface-950 font-sans antialiased select-none text-slate-200">
      {/* 顶部主导航栏 */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-surface-800 bg-surface-950 px-3">
        <div className="flex items-center space-x-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/20 text-emerald-400 font-black text-xs border border-emerald-500/30">
            OS
          </div>
          <span className="text-sm font-bold tracking-tight text-white">
            OpenShell
          </span>
          <span className="rounded bg-surface-800/80 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 font-mono">
            v1.0.0
          </span>
        </div>

        {/* 顶部中央快捷搜索与直连触发器 (⌘K) */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="flex items-center space-x-2 px-3 py-1 rounded-lg border border-surface-800 bg-surface-900 text-slate-400 hover:text-slate-200 hover:border-surface-700 transition text-xs w-64 justify-between"
            title="搜索会话、快速连接或切换主题 (Ctrl+K / ⌘K)"
          >
            <div className="flex items-center space-x-1.5 truncate">
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <span className="truncate">搜索会话或输入直连...</span>
            </div>
            <kbd className="px-1.5 py-0.2 text-[10px] font-mono bg-surface-950 border border-surface-800 rounded text-slate-500">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* 顶部右侧快捷工具栏 */}
        <div className="flex items-center space-x-1.5 text-xs">
          {isConnected && (
            <>
              {activeTab?.protocol !== "serial" && (
                <button
                  onClick={() => activeTab && toggleMode(activeTab.tabId)}
                  className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border transition ${
                    activeTab?.currentMode === "view"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                      : "bg-surface-900 border-surface-800 text-slate-400 hover:text-white"
                  }`}
                  title="切换命令终端/SFTP视图模式 (Ctrl+Shift+Tab)"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>
                  <span>{activeTab?.currentMode === "view" ? "返回命令行" : "SFTP 视图"}</span>
                </button>
              )}

              <button
                onClick={() => setMonitorOpen(true)}
                className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border bg-surface-900 border-surface-800 text-slate-400 hover:text-white hover:border-surface-700 transition"
                title="查看服务器监控"
              >
                <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span>服务器监控</span>
              </button>
            </>
          )}

          <button
            onClick={() => setForwardModalOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border bg-surface-900 border-surface-800 text-slate-400 hover:text-white hover:border-surface-700 transition"
            title="端口转发与代理"
          >
            <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            <span>端口转发</span>
          </button>

          <button
            onClick={() => setMultiExecOpen(!multiExecOpen)}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded-lg border transition ${
              multiExecOpen
                ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
                : "bg-surface-900 border-surface-800 text-slate-400 hover:text-white"
            }`}
            title="多会话同步输入"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" />
            </svg>
            <span>多机同步</span>
          </button>

          <button
            onClick={() => setPortCheckerOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border bg-surface-900 border-surface-800 text-slate-400 hover:text-white hover:border-surface-700 transition"
            title="网络探测与插件机制 (Architecture §21)"
          >
            <svg className="w-3.5 h-3.5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>网络探测</span>
          </button>

          <button
            onClick={() => setImportExportOpen(true)}
            className="flex items-center space-x-1 px-2.5 py-1 rounded-lg border bg-surface-900 border-surface-800 text-slate-400 hover:text-white hover:border-surface-700 transition"
            title="导入/导出备份"
          >
            <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <span>导入/导出</span>
          </button>

          {/* 顶部同步小组件 */}
          <SyncStatusWidget variant="header" />

          {/* 右侧保险库与设置控制 */}
          <button
            onClick={() => setSettingsModalOpen(true)}
            className="p-1.5 rounded-lg border border-surface-800 bg-surface-900 text-slate-400 hover:border-surface-700 hover:text-white transition"
            title="偏好设置与主题"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {status && status.state === "unlocked" && (
            <button
              onClick={() => lock()}
              className="flex items-center space-x-1.5 rounded-lg border border-surface-800 bg-surface-900 px-2.5 py-1 text-xs text-slate-300 hover:border-surface-700 hover:text-white transition"
              title="锁定保险库"
            >
              <svg className="h-3.5 w-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
              </svg>
              <span>锁定</span>
            </button>
          )}
        </div>
      </header>

      {/* 主工作区 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧会话导航树 */}
        <aside className="w-64 shrink-0 overflow-hidden border-r border-surface-800">
          <SessionTree
            onNewSession={(groupId) => handleNewSession(groupId)}
            onEditSession={handleEditSession}
          />
        </aside>

        {/* 中间主工作区：标签栏 + 命令片段栏 + xterm 终端 + MultiExec 同步输入 */}
        <main className="flex flex-1 flex-col overflow-hidden bg-surface-950">
          <TerminalTabs onNewTabClick={() => handleNewSession()} />

          {/* 快捷命令片段栏 (SSH 模式) */}
          {activeTab?.protocol !== "serial" && <SnippetBar activeTabId={activeTabId} />}

          <div className="relative flex-1 overflow-hidden flex">
            {activeTab ? (
              activeTab.protocol === "serial" ? (
                <div className="flex-1 h-full relative overflow-hidden flex flex-col bg-surface-950">
                  <SerialControlBar
                    cardId={activeTab.cardId || activeTab.tabId}
                    baudRate={activeTab.baudRate}
                  />
                  <div className="flex-1 relative overflow-hidden">
                    {viewMode === "hex" ? (
                      <HexDumpView cardId={activeTab.cardId || activeTab.tabId} />
                    ) : (
                      <XtermView key={activeTab.tabId} tab={activeTab} />
                    )}
                  </div>
                  <SerialSendBar cardId={activeTab.cardId || activeTab.tabId} />

                  {/* 串口断开半透明遮罩 */}
                  {activeTab.status === "disconnected" && (
                    <DisconnectedBackdrop
                      isSerial={true}
                      reason={activeTab.error}
                      onReconnect={async () => {
                        setIsReconnecting(true);
                        await reconnectTab(activeTab.tabId);
                        setIsReconnecting(false);
                      }}
                      reconnecting={isReconnecting}
                    />
                  )}
                </div>
              ) : (
                <div className="flex-1 h-full relative overflow-hidden flex flex-col">
                  {/* 命令模式：全屏终端，切到视图模式时隐藏 DOM 但保持挂载与缓冲 */}
                  <div className={activeTab.currentMode === "command" ? "w-full h-full relative" : "hidden"}>
                    <XtermView key={activeTab.tabId} tab={activeTab} />

                    {/* 浮动监控仪表盘 */}
                    {monitorOpen && activeTab.connectionId && (
                      <MonitorDashboard
                        connId={activeTab.connectionId}
                        sessionId={activeTab.sessionId}
                        onClose={() => setMonitorOpen(false)}
                      />
                    )}
                  </div>

                  {/* 视图模式：全屏 SFTP 文件资源管理器 */}
                  <div className={activeTab.currentMode === "view" ? "w-full h-full relative" : "hidden"}>
                    {activeTab.connectionId && (
                      <SftpView
                        connId={activeTab.connectionId}
                        sessionId={activeTab.sessionId}
                      />
                    )}
                  </div>

                  {/* 会话断开半透明遮罩 */}
                  {activeTab.status === "disconnected" && (
                    <DisconnectedBackdrop
                      isSerial={false}
                      reason={activeTab.error}
                      onReconnect={async () => {
                        setIsReconnecting(true);
                        await reconnectTab(activeTab.tabId);
                        setIsReconnecting(false);
                      }}
                      reconnecting={isReconnecting}
                    />
                  )}
                </div>
              )
            ) : (
              <div className="flex h-full flex-1 flex-col items-center justify-center p-8 text-center text-slate-500">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-900 border border-surface-800 mb-4 shadow-xl">
                  <svg className="h-8 w-8 text-emerald-500/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <h3 className="text-base font-bold text-slate-200 mb-1">
                  欢迎使用 OpenShell 工作台
                </h3>
                <p className="max-w-md text-xs text-slate-400 mb-5">
                  全 Rust 核心驱动、零 Agent 监控、视图卡 SFTP 双模式无缝切换与串口调试的现代独立终端。
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleNewSession()}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-950 hover:bg-emerald-500 transition"
                  >
                    创建连接会话
                  </button>
                  <button
                    onClick={() => setCommandPaletteOpen(true)}
                    className="rounded-lg bg-surface-900 border border-surface-800 px-4 py-2 text-xs font-semibold text-slate-300 hover:text-white hover:border-surface-700 transition"
                  >
                    按 ⌘K 快速查找 / 直连
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 多会话同步输入栏 */}
          {multiExecOpen && (
            <MultiExecBar onClose={() => setMultiExecOpen(false)} />
          )}
        </main>
      </div>

      {/* 底部状态栏 */}
      <footer className="flex h-6 shrink-0 items-center justify-between border-t border-surface-800/80 bg-surface-950 px-3 text-[11px] text-slate-400 select-none">
        <div className="flex items-center space-x-3">
          <span className="flex items-center space-x-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span>核心引擎: Ready</span>
          </span>

          {activeTab && (
            <>
              <span className="text-surface-700">|</span>
              <span className="text-slate-300 font-medium">
                当前: {activeTab.sessionName} ({activeTab.currentMode === "view" ? "SFTP 视图" : "终端命令行"})
              </span>

              {/* 快捷保存/编辑活动会话动作 */}
              <button
                onClick={handleSaveActiveTabAsSession}
                className="text-[10px] text-emerald-400 hover:text-emerald-300 px-1 py-0.2 rounded hover:bg-surface-900 transition"
                title="保存或编辑该活动会话属性"
              >
                💾 保存会话
              </button>

              {activeTab.protocol === "ssh" && (
                <span className="text-slate-500 font-mono">延迟: ~18ms</span>
              )}
            </>
          )}
        </div>

        <div className="flex items-center space-x-3">
          {transfers.length > 0 && (
            <button
              onClick={() => setTransferQueueOpen(!transferQueueOpen)}
              className="flex items-center space-x-1 px-2 py-0.5 rounded bg-surface-900 border border-surface-800 text-slate-300 hover:text-white hover:border-surface-700 transition"
              title="点击打开/关闭传输抽屉"
            >
              <span className="text-emerald-400 font-bold">⚡</span>
              <span>
                传输: {transfers.filter((t) => t.state === "transferring" || t.state === "queued").length} 活动 / {transfers.length} 项
              </span>
            </button>
          )}

          {/* 底部常驻同步小组件 */}
          <SyncStatusWidget variant="footer" />

          <span className="text-surface-700">|</span>
          <span>UTF-8</span>

          <span className="flex items-center space-x-1 text-emerald-400/80">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span>XChaCha20-Poly1305</span>
          </span>
        </div>
      </footer>

      {/* 全局模态弹窗与抽屉 */}
      <VaultUnlockModal />
      <SessionModal
        isOpen={isSessionModalOpen}
        onClose={() => {
          setIsSessionModalOpen(false);
          setInitialSessionValues(undefined);
        }}
        editingSession={editingSession}
        initialValues={initialSessionValues}
      />
      <CommandPaletteModal
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNewSession={handleNewSessionWithValues}
        onOpenPortForward={() => setForwardModalOpen(true)}
        onOpenSync={() => useSyncStore.getState().setModalOpen(true)}
        onOpenPortChecker={() => setPortCheckerOpen(true)}
        onOpenImportExport={() => setImportExportOpen(true)}
        onToggleMultiExec={() => setMultiExecOpen((prev) => !prev)}
      />
      <TransferQueueDrawer />
      <RemoteEditorModal />
      {forwardModalOpen && (
        <PortForwardModal
          sessionId={activeTab?.sessionId}
          connId={activeTab?.connectionId || undefined}
          onClose={() => setForwardModalOpen(false)}
        />
      )}
      {importExportOpen && (
        <ImportExportModal onClose={() => setImportExportOpen(false)} />
      )}
      <SettingsModal />
      <SyncSettingsModal />
      <PortCheckerModal
        isOpen={portCheckerOpen}
        onClose={() => setPortCheckerOpen(false)}
        defaultHost={activeTab?.sessionName ? undefined : "127.0.0.1"}
      />
    </div>
  );
};
