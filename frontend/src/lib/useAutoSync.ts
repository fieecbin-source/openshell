import { useEffect } from "react";
import { useSyncStore } from "../stores/syncStore";
import { useVaultStore } from "../stores/vaultStore";

export function useAutoSync() {
  useEffect(() => {
    void useSyncStore.getState().loadConfig();
    const sync = () => {
      const state = useSyncStore.getState();
      if (document.visibilityState !== "visible" || !navigator.onLine || state.syncing ||
          !state.config?.auto_sync || !state.config.is_logged_in ||
          useVaultStore.getState().status?.state !== "unlocked") return;
      void state.syncNow().catch(() => { /* The sync store keeps the actionable error. */ });
    };
    const timer = window.setInterval(sync, 15_000);
    window.addEventListener("online", sync);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", sync);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
}
