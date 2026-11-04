import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SnippetBar } from "./SnippetBar";
import { useSnippetStore } from "../stores/snippetStore";
import { writeTerminal } from "../lib/ipc";
import { useTerminalStore, type TerminalTab } from "../stores/terminalStore";
import type { Snippet } from "../types/ipc";

vi.mock("../lib/ipc", () => ({ writeTerminal: vi.fn().mockResolvedValue(1) }));
vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => cleanup());

it("exposes the full long name without changing the existing command send mode", async () => {
  const name = "查看生产服务器服务日志".repeat(12);
  useTerminalStore.setState({ tabs: [{ tabId: "active-terminal", status: "connected" } as TerminalTab] });
  useSnippetStore.setState({ snippets: [{ id: "snippet", name, command_template: "uptime", send_mode: "execute" } as Snippet], loadSnippets: vi.fn() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  act(() => root.render(<SnippetBar activeTabId="active-terminal" />));
  const button = container.querySelector<HTMLButtonElement>("[aria-label]")!;
  expect(button.getAttribute("aria-label")).toBe(name);
  expect(button.title).toContain(name);
  await act(async () => button.click());
  expect(writeTerminal).toHaveBeenCalledWith("active-terminal", new TextEncoder().encode("uptime\n"));
});
