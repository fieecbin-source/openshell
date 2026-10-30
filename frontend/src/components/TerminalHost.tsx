import React from "react";
import { useTerminalStore } from "../stores/terminalStore";
import { useSerialStore } from "../stores/serialStore";
import { XtermView } from "./XtermView";
import { SerialControlBar } from "./SerialControlBar";
import { SerialSendBar } from "./SerialSendBar";
import { HexDumpView } from "./HexDumpView";

interface TerminalHostProps {
  /** 终端区当前是否真正展示（例如「全 SFTP」视图下为 false） */
  visible: boolean;
  /** 终端区高度：分屏模式下由外层传入，其余情况铺满 */
  style?: React.CSSProperties;
}

/**
 * 终端宿主：把所有已打开标签的终端实例常驻挂载，只用可见性控制显隐。
 * 错误信息与重连提示直接在终端内打印，禁止使用模态弹窗/遮罩层阻挡终端视窗。
 */
export const TerminalHost: React.FC<TerminalHostProps> = ({ visible, style }) => {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const viewMode = useSerialStore((s) => s.viewMode);

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
            {tab.protocol === "serial" ? (
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
                <SerialSendBar cardId={tab.cardId || tab.tabId} />
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
