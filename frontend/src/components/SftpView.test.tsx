import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SftpView } from "./SftpView";
import { useSftpStore } from "../stores/sftpStore";
import type { SftpFileEntry } from "../types/ipc";

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }));
vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => cleanup());

it("keeps terminal and text editing keys separate from SFTP shortcuts", () => {
  useSftpStore.setState({
    remoteFiles: [{ name: "file.txt", path: "/file.txt", file_type: "regular", size: 1, modified_at: 1, accessed_at: 1, permissions: 420, uid: 0, gid: 0 } as SftpFileEntry],
    selectedPaths: ["/file.txt"], remotePath: "/", remoteLoading: false,
    initLocal: vi.fn(), loadRemoteFiles: vi.fn(),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  act(() => root.render(<><textarea aria-label="terminal input" /><SftpView connId="connection" sessionId="session" /></>));
  const terminal = container.querySelector("textarea")!;
  terminal.focus();
  const clearTerminal = new KeyboardEvent("keydown", { key: "l", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => terminal.dispatchEvent(clearTerminal));
  expect(clearTerminal.defaultPrevented).toBe(false);
  expect(container.querySelector('input[aria-label="远程路径"]')).toBeNull();
  const filter = container.querySelector<HTMLInputElement>('input[aria-label="过滤文件"]')!;
  filter.focus();
  const deleteText = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
  act(() => filter.dispatchEvent(deleteText));
  expect(deleteText.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const files = container.querySelector<HTMLDivElement>('[aria-label="SFTP 文件浏览器"]')!;
  files.focus();
  const editPath = new KeyboardEvent("keydown", { key: "l", ctrlKey: true, bubbles: true, cancelable: true });
  act(() => files.dispatchEvent(editPath));
  expect(editPath.defaultPrevented).toBe(true);
  expect(container.querySelector('input[aria-label="远程路径"]')).not.toBeNull();
});
