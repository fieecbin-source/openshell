import React, { useState, useEffect } from "react";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { Checkbox } from "./ui/Controls";
import { Modal } from "./ui/Overlay";
import { cn } from "./ui/cn";

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
    or: boolean,
    ow: boolean,
    ox: boolean,
    gr: boolean,
    gw: boolean,
    gx: boolean,
    tr: boolean,
    tw: boolean,
    tx: boolean,
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
    val: boolean,
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

    const mode = calculateNumeric(nextOr, nextOw, nextOx, nextGr, nextGw, nextGx, nextTr, nextTw, nextTx);
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

  const renderCell = (checked: boolean, onChange: (next: boolean) => void, label: string) => (
    <div className="flex justify-center">
      <Checkbox
        checked={checked}
        onChange={onChange}
        label={<span className="sr-only">{label}</span>}
      />
    </div>
  );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="修改权限"
      description={`${entryName}${isDirectory ? " · 目录" : " · 文件"}`}
      widthClassName="w-full max-w-[460px]"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
            应用权限
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* 3x3 权限选择表 */}
        <div className="rounded-os-md border border-line/10 bg-surface-muted p-3">
          <div className="grid grid-cols-4 gap-2 border-b border-line/10 pb-1.5 text-center text-os-2xs font-medium text-ink-tertiary">
            <span className="pl-1 text-left">类别</span>
            <span>读取 (r)</span>
            <span>写入 (w)</span>
            <span>执行 (x)</span>
          </div>

          <div className="grid grid-cols-4 items-center gap-2 border-t border-line/5 py-1.5 text-center text-os-xs">
            <span className="pl-1 text-left font-medium text-ink-secondary">所有者</span>
            {renderCell(ownerR, (next) => handleCheckboxChange("or", next), "所有者读取")}
            {renderCell(ownerW, (next) => handleCheckboxChange("ow", next), "所有者写入")}
            {renderCell(ownerX, (next) => handleCheckboxChange("ox", next), "所有者执行")}
          </div>

          <div className="grid grid-cols-4 items-center gap-2 border-t border-line/5 py-1.5 text-center text-os-xs">
            <span className="pl-1 text-left font-medium text-ink-secondary">用户组</span>
            {renderCell(groupR, (next) => handleCheckboxChange("gr", next), "用户组读取")}
            {renderCell(groupW, (next) => handleCheckboxChange("gw", next), "用户组写入")}
            {renderCell(groupX, (next) => handleCheckboxChange("gx", next), "用户组执行")}
          </div>

          <div className="grid grid-cols-4 items-center gap-2 border-t border-line/5 py-1.5 text-center text-os-xs">
            <span className="pl-1 text-left font-medium text-ink-secondary">其他人</span>
            {renderCell(otherR, (next) => handleCheckboxChange("tr", next), "其他人读取")}
            {renderCell(otherW, (next) => handleCheckboxChange("tw", next), "其他人写入")}
            {renderCell(otherX, (next) => handleCheckboxChange("tx", next), "其他人执行")}
          </div>
        </div>

        {/* 八进制输入与联动 */}
        <div className="flex items-center justify-between gap-3 text-os-xs">
          <span className="font-medium text-ink-secondary">八进制数值</span>
          <Input
            mono
            value={octalStr}
            maxLength={4}
            onChange={(e) => handleOctalInputChange(e.target.value)}
            className="h-[30px] w-24 text-center"
          />
        </div>

        {/* 目录递归选项 */}
        {isDirectory && (
          <div className={cn("rounded-os-md border border-line/10 bg-surface-muted p-2.5")}>
            <Checkbox
              checked={recursive}
              onChange={setRecursive}
              label="递归应用到所有子文件与子目录 (-R)"
            />
          </div>
        )}
      </div>
    </Modal>
  );
};
