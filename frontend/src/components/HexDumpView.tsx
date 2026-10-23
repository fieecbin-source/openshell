import React, { useState, useEffect, useRef } from "react";
import { readSerial } from "../lib/ipc";
import { useSerialStore } from "../stores/serialStore";

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

  // 轮询消费串口缓冲并格式化为十六进制转储表
  useEffect(() => {
    let isMounted = true;

    const poll = async () => {
      if (!isMounted) return;
      try {
        const bytes = await readSerial(cardId, 4096);
        if (bytes.length > 0 && isMounted) {
          const currentOffset = rawBytesRef.current.length;
          rawBytesRef.current.push(...bytes);

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
    <div className="flex flex-col h-full bg-[#fbfbfd] text-[#1d1d1f] font-mono text-xs select-text">
      {/* 顶部小工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#f5f5f7] border-b border-black/[0.06] text-[11px] text-[#86868b] select-none">
        <div className="flex items-center gap-3">
          <span>总接收: <strong className="text-[#1d1d1f]">{rawBytesRef.current.length}</strong> 字节</span>
          <span>行数: <strong className="text-[#1d1d1f]">{lines.length}</strong></span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer hover:text-[#1d1d1f] text-[#424245]">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-black/[0.2] text-[#0071e3] focus:ring-0 accent-[#0071e3]"
            />
            <span className="font-medium">自动滚动</span>
          </label>
          <button
            type="button"
            onClick={handleExport}
            className="px-2.5 py-0.5 rounded-md bg-white border border-black/[0.08] shadow-apple-sm text-[#1d1d1f] hover:bg-black/[0.04] transition active:scale-[0.98] font-medium"
          >
            导出转储
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="px-2.5 py-0.5 rounded-md bg-white border border-black/[0.08] shadow-apple-sm text-red-600 hover:bg-red-50 transition active:scale-[0.98] font-medium"
          >
            清空
          </button>
        </div>
      </div>

      {/* Hex Dump 视口 */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 leading-relaxed">
        {lines.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[#86868b] select-none">
            等待串口接收数据...
          </div>
        ) : (
          lines.map((l, idx) => (
            <div key={idx} className="flex gap-4 hover:bg-black/[0.03] rounded px-1.5 py-0.5">
              {showTimestamp && (
                <span className="text-[#86868b] select-none">[{l.timestamp}]</span>
              )}
              {/* 偏移地址 */}
              <span className="text-[#0071e3] select-none font-bold">
                {l.offset.toString(16).padStart(8, "0").toUpperCase()}:
              </span>
              {/* HEX 字节区 */}
              <span className="text-amber-800 tracking-wide font-medium whitespace-pre">
                {l.hexPart.padEnd(49, " ")}
              </span>
              {/* ASCII 可视字符 */}
              <span className="text-emerald-700 font-semibold select-none border-l border-black/[0.1] pl-3">
                |{l.asciiPart}|
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
