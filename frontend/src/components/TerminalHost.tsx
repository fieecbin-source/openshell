import React, { useEffect } from "react";
import type { Session } from "../types/ipc";
import { useTerminalStore } from "../stores/terminalStore";
import { useSerialStore } from "../stores/serialStore";
import { XtermView } from "./XtermView";
import { SerialControlBar } from "./SerialControlBar";
import { SerialSendBar } from "./SerialSendBar";
import { HexDumpView } from "./HexDumpView";
import { RdpSessionView } from "./RdpSessionView";

interface TerminalHostProps {
  /** 终端区当前是否真正展示（例如「全 SFTP」视图下为 false） */
  visible: boolean;
  /** 终端区高度：分屏模式下由外层传入，其余情况铺满 */
  style?: React.CSSProperties;
  /** 从 RDP 面板直接打开会话配置编辑弹窗 */
  onEditSession?: (session: Session) => void;
  /** 从 RDP 面板打开连接详情与诊断面板 */
  onOpenConnectionDetails?: () => void;
}

/**
 * 终端宿主：把所有已打开标签的终端实例常驻挂载，只用可见性控制显隐。
 * 错误信息与重连提示直接在终端内打印，禁止使用模态弹窗/遮罩层阻挡终端视窗。
 */
export const TerminalHost: React.FC<TerminalHostProps> = ({
  visible,
  style,
  onEditSession,
  onOpenConnectionDetails,
}) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const viewMode = useSerialStore((s) => s.viewMode);
  const sendError = useSerialStore((s) => s.sendError);
  const clearSendError = useSerialStore((s) => s.clearSendError);

  // 串口写入失败不能只停留在 toast：把对应标签标记为断开并触发现有自动重连。
  useEffect(() => {
    if (!sendError) return;
    const tab = useTerminalStore
      .getState()
      .tabs.find((item) => (item.cardId || item.tabId) === sendError.cardId);
    if (tab && tab.status === "connected") {
      useTerminalStore
        .getState()
        .markDisconnected(tab.tabId, `串口发送失败：${sendError.message}`);
    }
    clearSendError();
  }, [sendError, clearSendError]);

  return (
    <div
      className="absolute inset-x-0 top-0 overflow-hidden bg-surface"
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
            {tab.protocol === "rdp" ? (
              <RdpSessionView
                tab={tab}
                onEditSession={onEditSession}
                onOpenConnectionDetails={onOpenConnectionDetails}
              />
            ) : tab.protocol === "serial" ? (
              <>
                <SerialControlBar cardId={tab.cardId || tab.tabId} baudRate={tab.baudRate} />
                <div className="relative flex-1 overflow-hidden">
                  <XtermView tab={tab} visible={slotVisible} />
                  {/* HEX 视图作为覆盖层，终端实例不卸载，切回文本模式无需重开通道 */}
                  {slotVisible && viewMode === "hex" && (
                    <div className="absolute inset-0 z-20 bg-surface">
                      <HexDumpView cardId={tab.cardId || tab.tabId} />
                    </div>
                  )}
                </div>
                <SerialSendBar cardId={tab.cardId || tab.tabId} sessionId={tab.sessionId} />
              </>
            ) : (
              <XtermView tab={tab} visible={slotVisible} />
            )}
          </div>
        );
      })}
    </div>
  );
};
