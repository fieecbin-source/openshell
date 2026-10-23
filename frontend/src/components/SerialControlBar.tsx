import React, { useEffect } from "react";
import { useSerialStore } from "../stores/serialStore";

interface SerialControlBarProps {
  cardId: string;
  baudRate?: number;
}

export const SerialControlBar: React.FC<SerialControlBarProps> = ({
  cardId,
  baudRate = 115200,
}) => {
  const {
    viewMode,
    setViewMode,
    showTimestamp,
    setShowTimestamp,
    modemStatus,
    stats,
    setDtr,
    setRts,
    esp32Reset,
    fetchModemStatus,
    fetchStats,
  } = useSerialStore();

  const currentModem = modemStatus[cardId] || {
    cts: false,
    dsr: false,
    ri: false,
    cd: false,
  };

  const currentStats = stats[cardId] || {
    rx_bytes: 0,
    tx_bytes: 0,
    rx_bps: 0,
    tx_bps: 0,
  };

  const [dtrState, setDtrState] = React.useState(true);
  const [rtsState, setRtsState] = React.useState(true);

  useEffect(() => {
    fetchModemStatus(cardId);
    fetchStats(cardId);
    const interval = setInterval(() => {
      fetchModemStatus(cardId);
      fetchStats(cardId);
    }, 1000);
    return () => clearInterval(interval);
  }, [cardId]);

  const handleToggleDtr = async () => {
    const next = !dtrState;
    setDtrState(next);
    await setDtr(cardId, next);
  };

  const handleToggleRts = async () => {
    const next = !rtsState;
    setRtsState(next);
    await setRts(cardId, next);
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatRate = (bps: number) => {
    if (bps < 1024) return `${bps} B/s`;
    if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
    return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-[#f5f5f7] border-b border-black/[0.06] text-xs text-[#1d1d1f] select-none">
      {/* 模式选择 & 时间戳 */}
      <div className="flex items-center gap-3">
        <div className="flex items-center bg-black/[0.06] rounded-lg p-0.5">
          <button
            type="button"
            className={`px-2.5 py-0.5 rounded-md text-xs transition active:scale-[0.98] ${
              viewMode === "ascii"
                ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                : "text-[#86868b] hover:text-[#1d1d1f]"
            }`}
            onClick={() => setViewMode("ascii")}
          >
            ASCII
          </button>
          <button
            type="button"
            className={`px-2.5 py-0.5 rounded-md text-xs transition active:scale-[0.98] ${
              viewMode === "hex"
                ? "bg-white text-[#1d1d1f] font-semibold shadow-apple-sm"
                : "text-[#86868b] hover:text-[#1d1d1f]"
            }`}
            onClick={() => setViewMode("hex")}
          >
            HEX 转储
          </button>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer text-[#424245] hover:text-[#1d1d1f]">
          <input
            type="checkbox"
            checked={showTimestamp}
            onChange={(e) => setShowTimestamp(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-black/[0.2] text-[#0071e3] focus:ring-0 accent-[#0071e3]"
          />
          <span className="text-[11px] font-medium">时间戳</span>
        </label>

        <span className="text-black/[0.15]">|</span>

        {/* 波特率胶囊 */}
        <span className="px-2 py-0.5 rounded-md bg-white border border-black/[0.08] shadow-apple-sm font-mono text-[11px] text-emerald-700 font-semibold">
          {baudRate} baud
        </span>
      </div>

      {/* 控制线与 Modem 状态灯 */}
      <div className="flex items-center gap-4">
        {/* 控制线开关 */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggleDtr}
            title="Data Terminal Ready (点击切换电平)"
            className={`px-2 py-0.5 rounded-md font-mono text-[11px] font-bold border transition active:scale-[0.98] ${
              dtrState
                ? "bg-emerald-50 text-emerald-700 border-emerald-300 shadow-apple-sm"
                : "bg-black/[0.04] text-[#86868b] border-black/[0.08]"
            }`}
          >
            DTR
          </button>
          <button
            type="button"
            onClick={handleToggleRts}
            title="Request To Send (点击切换电平)"
            className={`px-2 py-0.5 rounded-md font-mono text-[11px] font-bold border transition active:scale-[0.98] ${
              rtsState
                ? "bg-emerald-50 text-emerald-700 border-emerald-300 shadow-apple-sm"
                : "bg-black/[0.04] text-[#86868b] border-black/[0.08]"
            }`}
          >
            RTS
          </button>
          <button
            type="button"
            onClick={() => esp32Reset(cardId)}
            title="触发 ESP32 / STM32 硬件复位脉冲"
            className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 transition active:scale-95 shadow-apple-sm"
          >
            ⚡ 复位
          </button>
        </div>

        {/* 状态引脚指示灯 */}
        <div className="flex items-center gap-2.5 font-mono text-[10px]">
          <div className="flex items-center gap-1" title="Clear To Send">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.cts ? "bg-emerald-500 shadow-sm" : "bg-black/20"
              }`}
            />
            <span className={currentModem.cts ? "text-[#1d1d1f] font-bold" : "text-[#86868b]"}>CTS</span>
          </div>

          <div className="flex items-center gap-1" title="Data Set Ready">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.dsr ? "bg-emerald-500 shadow-sm" : "bg-black/20"
              }`}
            />
            <span className={currentModem.dsr ? "text-[#1d1d1f] font-bold" : "text-[#86868b]"}>DSR</span>
          </div>

          <div className="flex items-center gap-1" title="Carrier Detect">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.cd ? "bg-emerald-500 shadow-sm" : "bg-black/20"
              }`}
            />
            <span className={currentModem.cd ? "text-[#1d1d1f] font-bold" : "text-[#86868b]"}>CD</span>
          </div>

          <div className="flex items-center gap-1" title="Ring Indicator">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.ri ? "bg-emerald-500 shadow-sm" : "bg-black/20"
              }`}
            />
            <span className={currentModem.ri ? "text-[#1d1d1f] font-bold" : "text-[#86868b]"}>RI</span>
          </div>
        </div>

        <span className="text-black/[0.15]">|</span>

        {/* 流量统计 */}
        <div className="flex items-center gap-3 font-mono text-[11px] text-[#86868b]">
          <span title={`接收总计: ${currentStats.rx_bytes} 字节`}>
            ↓ <strong className="text-[#1d1d1f]">{formatBytes(currentStats.rx_bytes)}</strong>{" "}
            <span>({formatRate(currentStats.rx_bps)})</span>
          </span>
          <span title={`发送总计: ${currentStats.tx_bytes} 字节`}>
            ↑ <strong className="text-[#1d1d1f]">{formatBytes(currentStats.tx_bytes)}</strong>{" "}
            <span>({formatRate(currentStats.tx_bps)})</span>
          </span>
        </div>
      </div>
    </div>
  );
};
