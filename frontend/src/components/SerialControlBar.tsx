import React, { useEffect } from "react";
import { useSerialStore } from "../stores/serialStore";
import { Badge } from "./ui/Surface";
import { Button } from "./ui/Button";
import { Checkbox, Segmented } from "./ui/Controls";
import { cn } from "./ui/cn";
import { PowerIcon } from "./ui/icons";

interface SerialControlBarProps {
  cardId: string;
  baudRate?: number;
}

type SerialViewMode = "ascii" | "hex";

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

  const lineState = [
    { key: "cts", label: "CTS", title: "Clear To Send", value: currentModem.cts },
    { key: "dsr", label: "DSR", title: "Data Set Ready", value: currentModem.dsr },
    { key: "cd", label: "CD", title: "Carrier Detect", value: currentModem.cd },
    { key: "ri", label: "RI", title: "Ring Indicator", value: currentModem.ri },
  ];

  const signalClass = (active: boolean) =>
    cn(
      "flex h-[24px] items-center gap-1 rounded-os-sm border px-1.5 font-mono text-os-2xs font-semibold",
      active
        ? "border-accent/30 bg-accent/10 text-accent"
        : "border-line/10 bg-surface text-ink-tertiary hover:text-ink-secondary",
    );

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b border-line/10 bg-surface-muted px-3 py-1.5 text-os-xs text-ink select-none">
      {/* 模式选择 & 时间戳 */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<SerialViewMode>
          value={viewMode}
          onChange={setViewMode}
          size="sm"
          ariaLabel="串口显示模式"
          options={[
            { value: "ascii", label: "ASCII" },
            { value: "hex", label: "HEX 转储" },
          ]}
        />

        <Checkbox
          checked={showTimestamp}
          onChange={setShowTimestamp}
          label={<span className="text-os-2xs text-ink-secondary">时间戳</span>}
          className="gap-1.5"
        />

        <Badge tone="neutral" className="font-mono">
          {baudRate} baud
        </Badge>
      </div>

      {/* 控制线与 Modem 状态灯 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleToggleDtr}
            title="Data Terminal Ready (点击切换电平)"
            className={signalClass(dtrState)}
          >
            DTR
          </button>
          <button
            type="button"
            onClick={handleToggleRts}
            title="Request To Send (点击切换电平)"
            className={signalClass(rtsState)}
          >
            RTS
          </button>
          <Button
            variant="secondary"
            size="sm"
            className="h-[24px] px-2 text-os-2xs"
            leading={<PowerIcon className="h-3 w-3" />}
            title="触发 ESP32 / STM32 硬件复位脉冲"
            onClick={() => esp32Reset(cardId)}
          >
            复位
          </Button>
        </div>

        <div className="flex items-center gap-2 font-mono text-os-2xs">
          {lineState.map((line) => (
            <span key={line.key} className="flex items-center gap-1" title={line.title}>
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  line.value ? "bg-accent" : "bg-line/20",
                )}
              />
              <span className={line.value ? "font-semibold text-ink" : "text-ink-tertiary"}>
                {line.label}
              </span>
            </span>
          ))}
        </div>

        {/* 流量统计 */}
        <div className="flex items-center gap-2.5 font-mono text-os-2xs tabular-nums text-ink-tertiary">
          <span title={`接收总计: ${currentStats.rx_bytes} 字节`}>
            RX{" "}
            <span className="font-semibold text-ink">{formatBytes(currentStats.rx_bytes)}</span>{" "}
            <span className="text-ink-tertiary">({formatRate(currentStats.rx_bps)})</span>
          </span>
          <span title={`发送总计: ${currentStats.tx_bytes} 字节`}>
            TX{" "}
            <span className="font-semibold text-ink">{formatBytes(currentStats.tx_bytes)}</span>{" "}
            <span className="text-ink-tertiary">({formatRate(currentStats.tx_bps)})</span>
          </span>
        </div>
      </div>
    </div>
  );
};
