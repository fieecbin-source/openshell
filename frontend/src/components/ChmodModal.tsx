import React, { useState, useEffect } from "react";

interface ChmodModalProps {
  isOpen: boolean;
  entryName: string;
  initialMode: number;
  isDirectory: boolean;
  onConfirm: (mode: number, recursive: boolean) => Promise<void>;
  onClose: () => void;
}

export const ChmodModal: React.FC<ChmodModalProps> = ({
  isOpen,
  entryName,
  initialMode,
  isDirectory,
  onConfirm,
  onClose,
}) => {
  const [octalStr, setOctalStr] = useState("0755");
  const [recursive, setRecursive] = useState(false);
  const [saving, setSaving] = useState(false);

  // 3x3 权限矩阵状态
  const [ownerR, setOwnerR] = useState(true);
  const [ownerW, setOwnerW] = useState(true);
  const [ownerX, setOwnerX] = useState(true);

  const [groupR, setGroupR] = useState(true);
  const [groupW, setGroupW] = useState(false);
  const [groupX, setGroupX] = useState(true);

  const [otherR, setOtherR] = useState(true);
  const [otherW, setOtherW] = useState(false);
  const [otherX, setOtherX] = useState(true);

  useEffect(() => {
    if (!isOpen) return;
    const mode = initialMode & 0o777;
    const octal = mode.toString(8).padStart(3, "0");
    setOctalStr("0" + octal);
    syncFromNumeric(mode);
    setRecursive(false);
  }, [isOpen, initialMode]);

  const syncFromNumeric = (mode: number) => {
    setOwnerR((mode & 0o400) !== 0);
    setOwnerW((mode & 0o200) !== 0);
    setOwnerX((mode & 0o100) !== 0);

    setGroupR((mode & 0o040) !== 0);
    setGroupW((mode & 0o020) !== 0);
    setGroupX((mode & 0o010) !== 0);

    setOtherR((mode & 0o004) !== 0);
    setOtherW((mode & 0o002) !== 0);
    setOtherX((mode & 0o001) !== 0);
  };

  const calculateNumeric = (
    or: boolean, ow: boolean, ox: boolean,
    gr: boolean, gw: boolean, gx: boolean,
    tr: boolean, tw: boolean, tx: boolean
  ) => {
    let mode = 0;
    if (or) mode |= 0o400;
    if (ow) mode |= 0o200;
    if (ox) mode |= 0o100;

    if (gr) mode |= 0o040;
    if (gw) mode |= 0o020;
    if (gx) mode |= 0o010;

    if (tr) mode |= 0o004;
    if (tw) mode |= 0o002;
    if (tx) mode |= 0o001;

    return mode;
  };

  const handleCheckboxChange = (
    type: "or" | "ow" | "ox" | "gr" | "gw" | "gx" | "tr" | "tw" | "tx",
    val: boolean
  ) => {
    const nextOr = type === "or" ? val : ownerR;
    const nextOw = type === "ow" ? val : ownerW;
    const nextOx = type === "ox" ? val : ownerX;

    const nextGr = type === "gr" ? val : groupR;
    const nextGw = type === "gw" ? val : groupW;
    const nextGx = type === "gx" ? val : groupX;

    const nextTr = type === "tr" ? val : otherR;
    const nextTw = type === "tw" ? val : otherW;
    const nextTx = type === "tx" ? val : otherX;

    if (type === "or") setOwnerR(val);
    if (type === "ow") setOwnerW(val);
    if (type === "ox") setOwnerX(val);

    if (type === "gr") setGroupR(val);
    if (type === "gw") setGroupW(val);
    if (type === "gx") setGroupX(val);

    if (type === "tr") setOtherR(val);
    if (type === "tw") setOtherW(val);
    if (type === "tx") setOtherX(val);

    const mode = calculateNumeric(
      nextOr, nextOw, nextOx,
      nextGr, nextGw, nextGx,
      nextTr, nextTw, nextTx
    );
    setOctalStr("0" + mode.toString(8).padStart(3, "0"));
  };

  const handleOctalInputChange = (text: string) => {
    setOctalStr(text);
    const cleaned = text.replace(/^0+/, "") || "0";
    const parsed = parseInt(cleaned, 8);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 0o777) {
      syncFromNumeric(parsed);
    }
  };

  const handleSave = async () => {
    const cleaned = octalStr.replace(/^0+/, "") || "0";
    const mode = parseInt(cleaned, 8) || 0o755;
    setSaving(true);
    try {
      await onConfirm(mode, recursive);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-xl border border-surface-700 bg-surface-900 p-5 shadow-2xl text-slate-200 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between pb-3 border-b border-surface-800">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-500/20 text-teal-400 border border-teal-500/30">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">修改权限 (chmod)</h3>
              <p className="text-[11px] text-slate-400 truncate max-w-[200px]" title={entryName}>
                {entryName}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-surface-800 transition"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 3x3 权限选择表 */}
        <div className="mt-4 bg-surface-950/60 rounded-lg p-3 border border-surface-800 text-xs">
          <div className="grid grid-cols-4 gap-2 text-center font-medium text-slate-400 mb-2 pb-1 border-b border-surface-800/80">
            <span className="text-left pl-1">类别</span>
            <span>读取 (r)</span>
            <span>写入 (w)</span>
            <span>执行 (x)</span>
          </div>

          {/* 所有者 */}
          <div className="grid grid-cols-4 gap-2 items-center text-center py-1">
            <span className="text-left pl-1 font-semibold text-slate-300">所有者</span>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={ownerR}
                onChange={(e) => handleCheckboxChange("or", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={ownerW}
                onChange={(e) => handleCheckboxChange("ow", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={ownerX}
                onChange={(e) => handleCheckboxChange("ox", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
          </div>

          {/* 用户组 */}
          <div className="grid grid-cols-4 gap-2 items-center text-center py-1 border-t border-surface-800/50">
            <span className="text-left pl-1 font-semibold text-slate-300">用户组</span>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={groupR}
                onChange={(e) => handleCheckboxChange("gr", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={groupW}
                onChange={(e) => handleCheckboxChange("gw", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={groupX}
                onChange={(e) => handleCheckboxChange("gx", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
          </div>

          {/* 公共 / 其他 */}
          <div className="grid grid-cols-4 gap-2 items-center text-center py-1 border-t border-surface-800/50">
            <span className="text-left pl-1 font-semibold text-slate-300">其他人</span>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={otherR}
                onChange={(e) => handleCheckboxChange("tr", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={otherW}
                onChange={(e) => handleCheckboxChange("tw", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
            <label className="flex justify-center cursor-pointer">
              <input
                type="checkbox"
                checked={otherX}
                onChange={(e) => handleCheckboxChange("tx", e.target.checked)}
                className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0 focus:ring-offset-0"
              />
            </label>
          </div>
        </div>

        {/* 八进制输入与联动 */}
        <div className="mt-4 flex items-center justify-between text-xs">
          <label className="text-slate-400 font-medium">八进制数值：</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={octalStr}
              maxLength={4}
              onChange={(e) => handleOctalInputChange(e.target.value)}
              className="w-20 rounded border border-surface-700 bg-surface-950 px-2 py-1 text-center font-mono text-teal-400 focus:border-teal-500 focus:outline-none"
            />
          </div>
        </div>

        {/* 目录递归选项 */}
        {isDirectory && (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-300 bg-surface-950/40 p-2 rounded border border-surface-800">
            <input
              type="checkbox"
              id="chmod-recursive"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
              className="rounded border-surface-700 bg-surface-800 text-teal-500 focus:ring-0"
            />
            <label htmlFor="chmod-recursive" className="cursor-pointer select-none">
              递归应用到所有子文件与子目录 (-R)
            </label>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-surface-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-surface-800 hover:text-white transition"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-teal-500 shadow-md shadow-teal-950 transition disabled:opacity-50"
          >
            {saving ? "应用中..." : "应用权限"}
          </button>
        </div>
      </div>
    </div>
  );
};
