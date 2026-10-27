import React, { useState } from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { useSerialStore } from "../stores/serialStore";
import { XtermView } from "./XtermView";
import { SerialControlBar } from "./SerialControlBar";
import { SerialSendBar } from "./SerialSendBar";
import { HexDumpView } from "./HexDumpView";
import { DisconnectedBackdrop } from "./DisconnectedBackdrop";

interface TerminalHostProps {
  /** 终端区当前是否真正展示（例如「全 SFTP」视图下为 false） */
  visible: boolean;
  /** 终端区高度：分屏模式下由外层传入，其余情况铺满 */
  style?: React.CSSProperties;
}

/**
 * 终端宿主：把**所有已打开标签**的终端实例常驻挂载，只用可见性控制显隐。
 *
 * 为什么不再「只渲染 activeTab」：
 *  - 旧实现切标签 / 切视图会 unmount → `term.dispose()`，scrollback 全部丢失；
 *  - 切回来时会重新 `terminal_open`，在远端多开一个 shell，旧 stream 被覆盖泄漏；
 *  - 串口标签还会重复占用设备。
 *
 * 显隐用 `visibility` 而不是 `display:none`：后者会让容器尺寸变为 0，
 * `fit()` 会算出极小列宽并把错误尺寸同步给远端 PTY。
 */
export const TerminalHost: React.FC<TerminalHostProps> = ({ visible, style }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const reconnectTab = useTerminalStore((s) => s.reconnectTab);
  const cancelAutoReconnect = useTerminalStore((s) => s.cancelAutoReconnect);
  const viewMode = useSerialStore((s) => s.viewMode);

  // 重连中状态必须按标签隔离：旧实现用 AppLayout 里的全局布尔值，
  // 一个标签重连会同时禁用其它标签的重连按钮。
  const [reconnectingTabId, setReconnectingTabId] = useState<string | null>(null);

  return (
    <div
      className="absolute inset-x-0 top-0 overflow-hidden bg-white"
      style={style ?? { height: "100%" }}
    >
      {tabs.map((tab) => {
        const slotVisible = visible && tab.tabId === activeTabId;
        return (
          <div
            key={tab.tabId}
            className="absolute inset-0 flex flex-col"
            style={{
              visibility: slotVisible ? "visible" : "hidden",
              pointerEvents: slotVisible ? "auto" : "none",
              zIndex: slotVisible ? 1 : 0,
            }}
            aria-hidden={!slotVisible}
          >
            {tab.protocol === "serial" ? (
              <>
                <SerialControlBar cardId={tab.cardId || tab.tabId} baudRate={tab.baudRate} />
                <div className="relative flex-1 overflow-hidden">
                  <XtermView tab={tab} visible={slotVisible} />
                  {/* HEX 视图作为覆盖层，终端实例不卸载，切回文本模式无需重开通道 */}
                  {slotVisible && viewMode === "hex" && (
                    <div className="absolute inset-0 z-20 bg-white">
                      <HexDumpView cardId={tab.cardId || tab.tabId} />
                    </div>
                  )}
                </div>
                <SerialSendBar cardId={tab.cardId || tab.tabId} />
              </>
            ) : (
              <XtermView tab={tab} visible={slotVisible} />
            )}

            {slotVisible && (tab.status === "disconnected" || tab.status === "reconnecting") && (
              <DisconnectedBackdrop
                isSerial={tab.protocol === "serial"}
                reason={tab.error}
                exitCode={tab.exitCode}
                attempt={tab.reconnectAttempt}
                maxAttempts={tab.reconnect.maxAttempts}
                nextRetryAt={tab.status === "reconnecting" ? tab.nextRetryAt : undefined}
                reconnecting={reconnectingTabId === tab.tabId}
                onCancelAutoReconnect={() => cancelAutoReconnect(tab.tabId)}
                onReconnect={async () => {
                  setReconnectingTabId(tab.tabId);
                  try {
                    await reconnectTab(tab.tabId);
                  } finally {
                    setReconnectingTabId(null);
                  }
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
