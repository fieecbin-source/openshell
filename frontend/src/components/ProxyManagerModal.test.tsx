import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ProxyManagerModal } from "./ProxyManagerModal";
import { proxyListGet, proxyListSave } from "../lib/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: vi.fn() }));

vi.mock("../lib/ipc", async () => ({
  ...await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc"),
  proxyListGet: vi.fn(),
  proxyListSave: vi.fn(),
  isTauriRuntime: () => true,
}));

let container: HTMLDivElement;
let root: Root;
const input = (id: string) => container.querySelector<HTMLInputElement>(`#${id}`)!;
const fill = (id: string, value: string) => act(() => {
  const field = input(id);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const marked = (id: string) => container.querySelector(`label[for="${id}"] [title="必填"]`) !== null;

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(proxyListGet).mockResolvedValue([]);
  vi.mocked(proxyListSave).mockImplementation(async (list) => list);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it("removes explanatory copy, placeholders and optional suffixes", () => {
  expect(container.querySelector("[placeholder]")).toBeNull();
  expect(container.textContent).not.toMatch(/配置全局|请在右侧|可选|选填/);
  expect(input("proxy-host").value).toBe("");
  expect(input("proxy-port").value).toBe("1080");
});

it("hides required stars after filling and restores them after clearing", () => {
  expect(marked("proxy-name")).toBe(true);
  expect(marked("proxy-host")).toBe(true);
  expect(marked("proxy-port")).toBe(false);
  fill("proxy-name", "本地代理");
  fill("proxy-host", "127.0.0.1");
  expect(marked("proxy-name")).toBe(false);
  expect(marked("proxy-host")).toBe(false);
  fill("proxy-name", "   ");
  fill("proxy-port", "");
  expect(marked("proxy-name")).toBe(true);
  expect(marked("proxy-port")).toBe(true);
  expect(input("proxy-port").value).toBe("");
});

it("retains validation and saves the entered proxy with optional fields empty", async () => {
  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("请输入代理名称");
  expect(proxyListSave).not.toHaveBeenCalled();
  fill("proxy-name", "本地代理");
  fill("proxy-host", "127.0.0.1");
  await submit();
  expect(proxyListSave).toHaveBeenCalledWith([expect.objectContaining({
    name: "本地代理", host: "127.0.0.1", port: 1080,
    username: null, password: null, notes: null,
  })]);
  expect(marked("proxy-name")).toBe(true);
  expect(marked("proxy-host")).toBe(true);
});

it("preserves legacy cache when the backend is empty and never caches new passwords", async () => {
  act(() => root.unmount());
  const legacy = JSON.stringify([{ id: "p1", password: "synthetic_legacy_secret" }]);
  localStorage.setItem("openshell_proxy_list_fallback_v1", legacy);
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));
  expect(localStorage.getItem("openshell_proxy_list_fallback_v1")).toBe(legacy);

  fill("proxy-name", "密码代理");
  fill("proxy-host", "127.0.0.1");
  const pwdInput = container.querySelector<HTMLInputElement>('input[aria-label="密码"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pwdInput, "super_secret_pwd_99");
    pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await submit();

  expect(proxyListSave).toHaveBeenCalledWith([expect.objectContaining({
    name: "密码代理",
    password: "super_secret_pwd_99",
  })]);

  expect(localStorage.getItem("openshell_proxy_list_fallback_v1")).toBe(legacy);
  expect(JSON.stringify(localStorage)).not.toContain("super_secret_pwd_99");
});

it("preserves legacy cache when the backend read fails", async () => {
  act(() => root.unmount());
  const legacy = JSON.stringify([{ id: "p1", password: "synthetic_legacy_secret" }]);
  localStorage.setItem("openshell_proxy_list_fallback_v1", legacy);
  vi.mocked(proxyListGet).mockRejectedValueOnce(new Error("Vault is locked"));
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));

  expect(proxyListGet).toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Vault is locked");
  expect(localStorage.getItem("openshell_proxy_list_fallback_v1")).toBe(legacy);
});

it("passes the clear-password choice through the real proxyTest IPC wrapper", async () => {
  act(() => root.unmount());
  vi.mocked(proxyListGet).mockResolvedValue([{
    id: "p_test",
    name: "认证代理",
    proxy_type: "socks5",
    host: "10.0.0.1",
    port: 1080,
    username: "synthetic-user",
    has_password: true,
    password_ref: "synthetic-reference",
  }]);
  vi.mocked(invoke).mockResolvedValue({ ok: true, latency_ms: 1, message: "ok" });
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑代理 认证代理"]')!.click());
  const testButton = Array.from(container.querySelectorAll("button"))
    .find((button) => button.textContent === "测试当前配置")!;

  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => testButton.click());
  expect(invoke).toHaveBeenLastCalledWith("proxy_test", {
    proxy: expect.objectContaining({ id: "p_test", clear_password: true }),
  });
  const payload = vi.mocked(invoke).mock.calls.at(-1)![1] as { proxy: Record<string, unknown> };
  expect(payload.proxy.password).toBeUndefined();
  expect(payload.proxy.password_ref).toBeUndefined();
  expect(proxyListSave).not.toHaveBeenCalled();

  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => testButton.click());
  expect(invoke).toHaveBeenLastCalledWith("proxy_test", {
    proxy: expect.objectContaining({ id: "p_test", clear_password: false }),
  });
});

it("editing existing proxy with stored password does not echo password and preserves it when left blank", async () => {
  act(() => root.unmount());
  const existingProxy = {
    id: "p_existing",
    name: "已有代理",
    proxy_type: "socks5" as const,
    host: "10.0.0.1",
    port: 1080,
    username: "user1",
    password: null,
    has_password: true,
    password_ref: "vault://secret/123",
    notes: null,
    created_at: 100,
    updated_at: 100,
  };
  vi.mocked(proxyListGet).mockResolvedValue([existingProxy as any]);
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));

  const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="编辑代理 已有代理"]')!;
  act(() => editBtn.click());

  const pwdInput = container.querySelector<HTMLInputElement>('input[aria-label="密码"]')!;
  expect(pwdInput.value).toBe("");

  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await submit();

  expect(proxyListSave).toHaveBeenCalledWith([expect.objectContaining({
    id: "p_existing",
    name: "已有代理",
    clear_password: false,
  })]);
  const savedItem = (proxyListSave as any).mock.calls[0][0][0];
  expect(savedItem.password).toBeUndefined();
});

it("checking clear password sends clear_password: true and password: null", async () => {
  act(() => root.unmount());
  const existingProxy = {
    id: "p_existing",
    name: "已有代理",
    proxy_type: "socks5" as const,
    host: "10.0.0.1",
    port: 1080,
    username: "user1",
    password: null,
    has_password: true,
    password_ref: "vault://secret/123",
    notes: null,
    created_at: 100,
    updated_at: 100,
  };
  vi.mocked(proxyListGet).mockResolvedValue([existingProxy as any]);
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));

  const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="编辑代理 已有代理"]')!;
  act(() => editBtn.click());

  const clearCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  act(() => {
    clearCheckbox.click();
  });

  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await submit();

  expect(proxyListSave).toHaveBeenCalledWith([expect.objectContaining({
    id: "p_existing",
    clear_password: true,
    password: null,
  })]);
});

it("explicitly re-enters a proxy password without echoing or reusing the stored reference", async () => {
  act(() => root.unmount());
  const existingProxy = {
    id: "p_ref",
    name: "引用代理",
    proxy_type: "socks5" as const,
    host: "10.0.0.2",
    port: 1081,
    username: "user2",
    password: null,
    has_password: true,
    password_ref: "vault://secret/456",
    notes: null,
    created_at: 100,
    updated_at: 100,
  };
  vi.mocked(proxyListGet).mockResolvedValue([existingProxy as any]);
  root = createRoot(container);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} />));

  const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="编辑代理 引用代理"]')!;
  act(() => editBtn.click());

  const pwdInput = container.querySelector<HTMLInputElement>('input[aria-label="密码"]')!;
  expect(pwdInput.value).toBe("");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(pwdInput, "new_proxy_pwd_77");
    pwdInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await submit();

  const savedItem = vi.mocked(proxyListSave).mock.calls[0][0][0];
  expect(savedItem).toMatchObject({
    id: "p_ref",
    password: "new_proxy_pwd_77",
    clear_password: false,
  });
  expect(savedItem.password_ref).toBe("vault://secret/456");
  expect(localStorage.getItem("openshell_proxy_list_fallback_v1")).toBeNull();
});

it("retains form values and displays alert if proxyListSave fails", async () => {
  vi.mocked(proxyListSave).mockRejectedValueOnce(new Error("Vault is locked"));
  fill("proxy-name", "测试失败");
  fill("proxy-host", "127.0.0.1");

  const submit = async () => act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await submit();

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Vault is locked");
  expect(input("proxy-name").value).toBe("测试失败");
  expect(input("proxy-host").value).toBe("127.0.0.1");
});
