import React, { useState, useEffect, useRef } from "react";
import { readSerial } from "../lib/ipc";
import { useSerialStore } from "../stores/serialStore";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Controls";
import { DownloadIcon, TrashIcon } from "./ui/icons";

interface HexDumpViewProps {
  cardId: string;
}

interface HexLine {
  offset: number;
  timestamp: string;
  hexPart: string;
  asciiPart: string;
}

export const HexDumpView: React.FC<HexDumpViewProps> = ({ cardId }) => {
  const { showTimestamp } = useSerialStore();
  const [lines, setLines] = useState<HexLine[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rawBytesRef = useRef<number[]>([]);
  // 绝对偏移量（rawBytesRef 会裁剪历史数据，不能再用其长度作为偏移）
  const totalOffsetRef = useRef(0);

  // 轮询消费串口缓冲并格式化为十六进制转储表
  useEffect(() => {
    let isMounted = true;

    const poll = async () => {
      if (!isMounted) return;
      try {
        const bytes = await readSerial(cardId, 4096);
        if (bytes.length > 0 && isMounted) {
          const currentOffset = totalOffsetRef.current;
          rawBytesRef.current.push(...bytes);
          totalOffsetRef.current += bytes.length;
          // 只保留最近 1 MiB 历史数据用于偏移参考，避免长时间采集内存持续增长
          const maxHistory = 1024 * 1024;
          if (rawBytesRef.current.length > maxHistory) {
            rawBytesRef.current.splice(
              0,
              rawBytesRef.current.length - maxHistory
            );
          }

          // 格式化为 16 字节每行的 Hex Dump
          const newLines: HexLine[] = [];
          const nowStr = new Date().toTimeString().split(" ")[0] + "." + String(new Date().getMilliseconds()).padStart(3, "0");

          for (let i = 0; i < bytes.length; i += 16) {
            const chunk = bytes.slice(i, i + 16);
            const lineOffset = currentOffset + i;

            // Hex string with extra space after 8th byte
            const hexParts = chunk.map((b) => b.toString(16).padStart(2, "0").toUpperCase());
            let hexStr = "";
            for (let j = 0; j < 16; j++) {
              if (j < hexParts.length) {
                hexStr += hexParts[j] + " ";
              } else {
                hexStr += "   ";
              }
              if (j === 7) hexStr += " ";
            }

            // Ascii string
            const asciiStr = chunk
              .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : "."))
              .join("");

            newLines.push({
              offset: lineOffset,
              timestamp: nowStr,
              hexPart: hexStr.trimEnd(),
              asciiPart: asciiStr,
            });
          }

          setLines((prev) => [...prev.slice(-2000), ...newLines]);
        }
      } catch {}
    };

    const interval = setInterval(poll, 40);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [cardId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleClear = () => {
    rawBytesRef.current = [];
    setLines([]);
  };

  const handleExport = () => {
    const text = lines
      .map((l) => `${showTimestamp ? `[${l.timestamp}] ` : ""}${l.offset.toString(16).padStart(8, "0").toUpperCase()}:  ${l.hexPart.padEnd(49, " ")}  |${l.asciiPart}|`)
      .join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `serial_dump_${cardId}_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full select-text flex-col bg-canvas font-mono text-os-2xs text-ink">
      {/* 顶部小工具栏 */}
      <div className="flex shrink-0 select-none flex-wrap items-center justify-between gap-2 border-b border-line/10 bg-surface-muted px-3 py-1.5">
        <div className="flex items-center gap-3 tabular-nums text-ink-tertiary">
          <span>
            总接收{" "}
            <span className="font-semibold text-ink">{rawBytesRef.current.length}</span> 字节
          </span>
          <span>
            行数 <span className="font-semibold text-ink">{lines.length}</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Checkbox
            checked={autoScroll}
            onChange={setAutoScroll}
            label={<span className="text-os-2xs text-ink-secondary">自动滚动</span>}
            className="mr-1.5 gap-1.5"
          />
          <Button
            variant="secondary"
            size="sm"
            className="h-[24px] px-2 text-os-2xs"
            leading={<DownloadIcon className="h-3 w-3" />}
            onClick={handleExport}
          >
            导出转储
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-[24px] px-2 text-os-2xs text-state-danger hover:bg-state-danger/10 hover:text-state-danger"
            leading={<TrashIcon className="h-3 w-3" />}
            onClick={handleClear}
          >
            清空
          </Button>
        </div>
      </div>

      {/* Hex Dump 视口 */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-2.5 py-2 leading-[1.55]">
        {lines.length === 0 ? (
          <div className="flex h-full select-none items-center justify-center text-ink-tertiary">
            等待串口接收数据...
          </div>
        ) : (
          lines.map((l, idx) => (
            <div
              key={idx}
              className="flex gap-3 rounded-[4px] px-1.5 py-px transition-colors duration-os hover:bg-line/[0.03]"
            >
              {showTimestamp && (
                <span className="shrink-0 select-none tabular-nums text-ink-tertiary">
                  [{l.timestamp}]
                </span>
              )}
              {/* 偏移地址 */}
              <span className="shrink-0 select-none font-semibold tabular-nums text-accent">
                {l.offset.toString(16).padStart(8, "0").toUpperCase()}:
              </span>
              {/* HEX 字节区 */}
              <span className="whitespace-pre text-ink-secondary">
                {l.hexPart.padEnd(49, " ")}
              </span>
              {/* ASCII 可视字符 */}
              <span className="select-none border-l border-line/10 pl-3 text-ink">
                |{l.asciiPart}|
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
