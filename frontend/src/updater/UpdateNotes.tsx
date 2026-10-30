import React, { useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface UpdateNotesProps {
  /** 后端 `notes.rs` 已消毒的 HTML（只允许标题/列表/代码/链接等白名单标签）。 */
  html: string;
  /** 说明为空时的兜底文案（由调用方从 `copy.ts` 传入，保持文案集中）。 */
  fallback: string;
}

/**
 * 渲染更新说明。
 *
 * 安全前提：HTML 由 Rust 侧 `ammonia` 白名单重建，不含 `<script>`、事件属性与
 * `javascript:` 协议；这里再拦截所有链接点击交给系统浏览器，避免 WebView 内跳转。
 */
export const UpdateNotes: React.FC<UpdateNotesProps> = ({ html, fallback }) => {
  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (!/^https:\/\//i.test(href)) {
      console.warn("blocked non-https link in release notes", href);
      return;
    }
    void openUrl(href).catch((err) => console.error("open notes link failed", err));
  }, []);

  const isEmpty = !html || html.trim().length === 0;

  if (isEmpty) {
    return <p className="text-[12px] text-[#86868b] leading-relaxed">{fallback}</p>;
  }

  return (
    <div
      onClick={handleClick}
      className={[
        "max-h-[40vh] overflow-y-auto pr-1 text-[12px] leading-relaxed text-[#1d1d1f]",
        // 说明区的排版规则：标题克制、列表有节奏、代码块浅灰底
        "[&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5",
        "[&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5",
        "[&_h3]:text-[12px] [&_h3]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1",
        "[&_p]:my-1.5 [&_p]:text-[#3a3a3c]",
        "[&_ul]:my-1.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:pl-4 [&_ol]:list-decimal",
        "[&_li]:my-0.5 [&_li]:marker:text-[#86868b]",
        "[&_code]:rounded-md [&_code]:bg-line/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px]",
        "[&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-line/5 [&_pre]:p-2.5 [&_pre]:overflow-x-auto",
        "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-line/10 [&_blockquote]:pl-3 [&_blockquote]:text-[#86868b]",
        "[&_hr]:my-3 [&_hr]:border-line/10",
        "[&_a]:text-accent [&_a]:underline-offset-2 hover:[&_a]:underline [&_a]:cursor-pointer",
      ].join(" ")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
