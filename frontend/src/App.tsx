import React, { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useVaultStore } from "./stores/vaultStore";
import { useSessionStore } from "./stores/sessionStore";
import { useTerminalStore } from "./stores/terminalStore";
import { AppLayout } from "./components/AppLayout";

export const App: React.FC = () => {
  const { checkStatus, status } = useVaultStore();
  const { loadAll } = useSessionStore();
  const { updateTabStatus } = useTerminalStore();

  useEffect(() => {
    checkStatus();
    loadAll();
  }, []);

  useEffect(() => {
    if (status?.state === "unlocked") {
      loadAll();
    }
  }, [status?.state]);

  // 监听后端推送的 AppEvent
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    listen<any>("openshell://event", (event) => {
      const payload = event.payload;
      if (!payload) return;

      if (payload.event === "vault_state") {
        checkStatus();
      } else if (payload.event === "connection_state") {
        const { connection_id, state, error } = payload;
        const tab = useTerminalStore.getState().tabs.find((t) => t.connectionId === connection_id);
        if (tab) {
          if (state === "ready") {
            updateTabStatus(tab.tabId, "connected");
          } else if (state === "closed") {
            updateTabStatus(tab.tabId, "disconnected", error);
          }
        }
      } else if (payload.event === "terminal_notice") {
        const { tab_id, kind, paused, dropped_bytes } = payload;
        if (kind === "flow") {
          if (paused) {
            console.warn(`[Flow Control] Terminal tab ${tab_id} reading paused due to backpressure.`);
          } else if (dropped_bytes) {
            console.warn(`[Flow Control] Terminal tab ${tab_id} dropped ${dropped_bytes} bytes due to hard threshold.`);
          }
        }
      }
    }).then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  return <AppLayout />;
};

export default App;
