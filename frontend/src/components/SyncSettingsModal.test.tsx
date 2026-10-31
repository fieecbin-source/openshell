import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncSettingsModal } from "./SyncSettingsModal";

const mock = vi.hoisted(() => ({
  modalOpen: true, config: null, syncing: false, error: null,
  setModalOpen: vi.fn(), loadConfig: vi.fn(), saveConfig: vi.fn(),
  register: vi.fn(), login: vi.fn(), logout: vi.fn(), clearLocalSyncData: vi.fn(),
  syncNow: vi.fn(), checkUpdates: vi.fn(),
}));
vi.mock("../stores/syncStore", () => ({ useSyncStore: () => mock }));
vi.mock("./ui/Overlay", () => ({ Modal: ({ children, onClose }: any) => <div><button onClick={onClose}>close</button>{children}</div> }));
vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

describe("sync login privacy", () => {
  let container: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<SyncSettingsModal />));
  const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  const change = (field: HTMLInputElement, value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    mock.modalOpen = true;
    mock.login.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it("starts with empty server, username and password fields", () => {
    render();
    expect([...container.querySelectorAll("input")].every((field) => field.value === "")).toBe(true);
    expect(input("请输入同步密码").getAttribute("autocomplete")).toBe("new-password");
  });

  it("forgets an entered password when the dialog is closed and reopened", () => {
    render();
    change(input("请输入同步密码"), "test-only-password");
    expect(input("请输入同步密码").value).toBe("test-only-password");
    mock.modalOpen = false; render();
    mock.modalOpen = true; render();
    expect(input("请输入同步密码").value).toBe("");
  });

  it("clears the password even when authentication fails", async () => {
    mock.login.mockRejectedValueOnce(new Error("test failure"));
    render();
    change(input("http://1.2.3.4:8085 或 https://sync.example.com"), "https://sync.example.invalid");
    change(input("admin 或自定义账号名"), "test-user");
    change(input("请输入同步密码"), "test-only-password");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mock.login).toHaveBeenCalledTimes(1);
    expect(input("请输入同步密码").value).toBe("");
  });
});
