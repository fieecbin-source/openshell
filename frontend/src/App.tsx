import React, { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVaultStore } from "./stores/vaultStore";
import { useSessionStore } from "./stores/sessionStore";
import { useTerminalStore } from "./stores/terminalStore";
import { AppLayout } from "./components/AppLayout";
import { ToastHost } from "./components/ToastHost";
import { useVaultAutoLock } from "./lib/useVaultAutoLock";
import { useAutoSync } from "./lib/useAutoSync";

export const App: React.FC = () => {
  const { checkStatus, status } = useVaultStore();
  const { loadAll } = useSessionStore();

  useEffect(() => {
    checkStatus();
    loadAll();
  }, []);

  useEffect(() => {
    if (status?.state === "unlocked") {
      loadAll();
    }
  }, [status?.state]);

  // 解锁后 15 分钟无操作自动锁定保险库（避免进程长期持有解密后的会话密钥）
  useVaultAutoLock();
  useAutoSync();

  // 监听后端推送的 AppEvent
  useEffect(() => {
    let disposed = false;
    let unlistenFn: (() => void) | undefined;

    listen<any>("openshell://event", (event) => {
      const payload = event.payload;
      if (!payload) return;

      if (payload.event === "vault_state") {
        checkStatus();
      } else if (payload.event === "connection_state") {
        const { connection_id, state, error } = payload;
        const store = useTerminalStore.getState();
        const tab = store.tabs.find((t) => t.connectionId === connection_id);
        if (tab) {
          if (state === "ready") {
            store.updateTabStatus(tab.tabId, "connected");
          } else if (state === "closed") {
            // 远端关闭 / 心跳失联：交给 store 决定是否按退避策略自动重连。
            // 旧实现只把状态改成 disconnected，且没有自动重连，用户只能手动点。
            store.markDisconnected(tab.tabId, error ?? undefined);
          }
        }
      } else if (payload.event === "terminal_notice") {
        const { tab_id, kind, paused, dropped_bytes, exit_code, value } = payload;
        const store = useTerminalStore.getState();
        if (kind === "flow") {
          if (paused) {
            console.warn(`[Flow Control] Terminal tab ${tab_id} reading paused due to backpressure.`);
          } else if (dropped_bytes) {
            console.warn(`[Flow Control] Terminal tab ${tab_id} dropped ${dropped_bytes} bytes due to hard threshold.`);
          }
        } else if (kind === "exit") {
          // 远端 shell 已退出：标签必须变成「已断开」，否则界面会一直显示已连接
          const tab = store.tabs.find((t) => t.tabId === tab_id);
          if (tab) {
            store.markDisconnected(
              tab.tabId,
              value || "远端会话已结束",
              typeof exit_code === "number" ? exit_code : null
            );
          }
        } else if (kind === "title") {
          // 暂未在标签上展示窗口标题，先保留事件通道（后续可映射到标签名）
        }
      }
    })
      .then((fn) => {
        // 卸载/StrictMode 双挂载竞态：如果已经清理过，立即退订，避免监听泄漏
        if (disposed) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((err) => console.warn("failed to subscribe app events", err));

    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  return (
    <>
      <AppLayout />
      {/* 全局通知层：错误/警告统一浮层呈现，支持展开详情与复制 */}
      <ToastHost />
    </>
  );
};

export default App;
