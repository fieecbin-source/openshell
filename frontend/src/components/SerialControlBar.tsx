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
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-300 select-none">
      {/* 模式选择 & 时间戳 */}
      <div className="flex items-center gap-3">
        <div className="flex items-center bg-slate-800 rounded p-0.5 border border-slate-700">
          <button
            type="button"
            className={`px-2 py-0.5 rounded transition ${
              viewMode === "ascii"
                ? "bg-indigo-600 text-white font-medium shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            onClick={() => setViewMode("ascii")}
          >
            ASCII
          </button>
          <button
            type="button"
            className={`px-2 py-0.5 rounded transition ${
              viewMode === "hex"
                ? "bg-indigo-600 text-white font-medium shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
            onClick={() => setViewMode("hex")}
          >
            HEX 转储
          </button>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer text-slate-400 hover:text-slate-200">
          <input
            type="checkbox"
            checked={showTimestamp}
            onChange={(e) => setShowTimestamp(e.target.checked)}
            className="w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-0"
          />
          <span>时间戳</span>
        </label>

        <span className="text-slate-600">|</span>

        {/* 波特率胶囊 */}
        <span className="px-1.5 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 font-mono text-[11px] text-emerald-400">
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
            className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold border transition ${
              dtrState
                ? "bg-emerald-950/80 text-emerald-400 border-emerald-600/80 shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                : "bg-slate-800 text-slate-500 border-slate-700"
            }`}
          >
            DTR
          </button>
          <button
            type="button"
            onClick={handleToggleRts}
            title="Request To Send (点击切换电平)"
            className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold border transition ${
              rtsState
                ? "bg-emerald-950/80 text-emerald-400 border-emerald-600/80 shadow-[0_0_8px_rgba(16,185,129,0.3)]"
                : "bg-slate-800 text-slate-500 border-slate-700"
            }`}
          >
            RTS
          </button>
          <button
            type="button"
            onClick={() => esp32Reset(cardId)}
            title="触发 ESP32 / STM32 硬件复位脉冲"
            className="px-2 py-0.5 rounded text-[11px] bg-slate-800 hover:bg-slate-700 text-amber-400 border border-amber-600/40 hover:border-amber-500 transition active:scale-95"
          >
            ⚡ 复位
          </button>
        </div>

        {/* 状态引脚指示灯 */}
        <div className="flex items-center gap-2 font-mono text-[10px]">
          <div className="flex items-center gap-1" title="Clear To Send">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.cts ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-slate-700"
              }`}
            />
            <span className={currentModem.cts ? "text-slate-200" : "text-slate-500"}>CTS</span>
          </div>

          <div className="flex items-center gap-1" title="Data Set Ready">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.dsr ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-slate-700"
              }`}
            />
            <span className={currentModem.dsr ? "text-slate-200" : "text-slate-500"}>DSR</span>
          </div>

          <div className="flex items-center gap-1" title="Carrier Detect">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.cd ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-slate-700"
              }`}
            />
            <span className={currentModem.cd ? "text-slate-200" : "text-slate-500"}>CD</span>
          </div>

          <div className="flex items-center gap-1" title="Ring Indicator">
            <span
              className={`w-2 h-2 rounded-full ${
                currentModem.ri ? "bg-emerald-400 shadow-[0_0_6px_#34d399]" : "bg-slate-700"
              }`}
            />
            <span className={currentModem.ri ? "text-slate-200" : "text-slate-500"}>RI</span>
          </div>
        </div>

        <span className="text-slate-600">|</span>

        {/* 流量统计 */}
        <div className="flex items-center gap-3 font-mono text-[11px] text-slate-400">
          <span title={`接收总计: ${currentStats.rx_bytes} 字节`}>
            ↓ {formatBytes(currentStats.rx_bytes)}{" "}
            <span className="text-slate-500">({formatRate(currentStats.rx_bps)})</span>
          </span>
          <span title={`发送总计: ${currentStats.tx_bytes} 字节`}>
            ↑ {formatBytes(currentStats.tx_bytes)}{" "}
            <span className="text-slate-500">({formatRate(currentStats.tx_bps)})</span>
          </span>
        </div>
      </div>
    </div>
  );
};
