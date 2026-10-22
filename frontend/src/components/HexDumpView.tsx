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
    <div className="flex flex-col h-full bg-slate-950 text-slate-300 font-mono text-xs select-text">
      {/* 顶部小工具栏 */}
      <div className="flex items-center justify-between px-3 py-1 bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 select-none">
        <div className="flex items-center gap-3">
          <span>总接收: {rawBytesRef.current.length} 字节</span>
          <span>行数: {lines.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 cursor-pointer hover:text-slate-200">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="w-3 h-3 rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-0"
            />
            <span>自动滚动</span>
          </label>
          <button
            type="button"
            onClick={handleExport}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
          >
            导出转储
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-rose-950/60 hover:text-rose-400 text-slate-300 transition"
          >
            清空
          </button>
        </div>
      </div>

      {/* Hex Dump 视口 */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-2 leading-relaxed">
        {lines.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 select-none">
            等待串口接收数据...
          </div>
        ) : (
          lines.map((l, idx) => (
            <div key={idx} className="flex gap-4 hover:bg-slate-900/60 rounded px-1">
              {showTimestamp && (
                <span className="text-slate-600 select-none">[{l.timestamp}]</span>
              )}
              {/* 偏移地址 */}
              <span className="text-indigo-400 select-none font-bold">
                {l.offset.toString(16).padStart(8, "0").toUpperCase()}:
              </span>
              {/* HEX 字节区 */}
              <span className="text-amber-300/90 tracking-wide font-medium whitespace-pre">
                {l.hexPart.padEnd(49, " ")}
              </span>
              {/* ASCII 可视字符 */}
              <span className="text-emerald-400 font-semibold select-none border-l border-slate-800 pl-3">
                |{l.asciiPart}|
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
