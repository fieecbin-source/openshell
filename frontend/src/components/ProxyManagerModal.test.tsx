import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ProxyManagerModal } from "./ProxyManagerModal";
import { proxyListGet, proxyListSave } from "../lib/ipc";
import type { ProxyServerConfig, ProxyServerInput } from "../types/ipc";

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
  vi.resetAllMocks();
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

const legacyKey = "openshell_proxy_list_fallback_v1";
const legacyProxy: ProxyServerInput = {
  id: "legacy-1", name: "历史代理", proxy_type: "socks5", host: "127.0.0.9", port: 1089,
  username: "synthetic-user", password: "synthetic-migration-secret", notes: null,
  created_at: 100, updated_at: 101,
};
const migratedProxy: ProxyServerConfig = {
  id: "legacy-1", name: "历史代理", proxy_type: "socks5", host: "127.0.0.9", port: 1089,
  username: "synthetic-user", notes: null, created_at: 100, updated_at: 101,
  has_password: true, password_ref: "synthetic-encrypted-reference",
};
const backendProxy: ProxyServerConfig = {
  id: "backend-1", name: "后端代理", proxy_type: "http", host: "10.0.0.1", port: 7890,
  username: "backend-user", notes: null, has_password: true, password_ref: "synthetic-backend-reference",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function migrationFixture(raw: string, initial: ProxyServerConfig[] = []) {
  act(() => root.unmount());
  const real = await vi.importActual<typeof import("../lib/ipc")>("../lib/ipc");
  vi.mocked(proxyListGet).mockImplementation(real.proxyListGet);
  vi.mocked(proxyListSave).mockImplementation(real.proxyListSave);
  vi.mocked(invoke).mockReset();
  let stored = initial;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "proxy_list_get") return stored;
    if (command === "proxy_list_save") {
      const list = (args as { proxies: ProxyServerInput[] }).proxies;
      stored = list.map(({ password, clear_password: _clear, ...config }) => ({
        ...config, has_password: Boolean(password) || Boolean(config.has_password),
        password_ref: password ? "synthetic-encrypted-reference" : config.password_ref,
      }));
      return stored;
    }
    throw new Error(`Unexpected fixture command: ${command}`);
  });
  localStorage.setItem(legacyKey, raw);
  root = createRoot(container);
}
const renderModal = async (open = true) => act(async () => {
  root.render(<ProxyManagerModal open={open} onClose={() => {}} />);
});
const refresh = async () => act(async () => {
  container.querySelector<HTMLButtonElement>('button[title="刷新代理列表"]')!.click();
});
const saveCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "proxy_list_save");

it.each([{ initial: [] }, { initial: [backendProxy] }])("migrates independent legacy rows through the real DTO and verifies before removing cache ($initial)", async ({ initial }) => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, initial);
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(saveCalls()[0][1]).toEqual({ proxies: [
    ...initial.map((proxy) => ({ ...proxy, clear_password: false })),
    { ...legacyProxy, clear_password: false },
  ] });
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "proxy_list_get", "proxy_list_save", "proxy_list_get",
  ]);
  expect(localStorage.getItem(legacyKey)).toBeNull();
  expect(container.textContent).toContain("历史代理");
  if (initial.length) expect(container.textContent).toContain("后端代理");
  expect(container.textContent).not.toContain("synthetic-migration-secret");
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="编辑代理 历史代理"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[aria-label="密码"]')!.value).toBe("");
});

it.each([{ existing: { ...backendProxy, id: legacyProxy.id } }, { existing: migratedProxy }])("retains the original cache and backend row on same-ID conflicts ($existing.name)", async ({ existing }) => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, [existing]);
  await renderModal();
  expect(saveCalls()).toHaveLength(0);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/冲突.*处理/);
  expect(container.textContent).toContain(existing.name);
});

it.each([
  "{invalid-json", JSON.stringify({ proxies: [legacyProxy] }),
  JSON.stringify([{ ...legacyProxy, port: 1.5 }]),
  JSON.stringify([legacyProxy, { id: "invalid-row", password: "synthetic-invalid-secret" }]),
  JSON.stringify([legacyProxy, legacyProxy]),
  JSON.stringify([{ ...legacyProxy, password: undefined, password_ref: "untrusted-reference", has_password: true }]),
])("retains all original bytes and reports invalid legacy data: %s", async (raw) => {
  await migrationFixture(raw, [backendProxy]);
  await renderModal();
  expect(saveCalls()).toHaveLength(0);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/历史代理.*处理/);
  expect(container.textContent).toContain("后端代理");
});

it.each(["proxy_list_get", "proxy_list_save"])("retains cache and current backend UI when %s fails", async (failedCommand) => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, [backendProxy]);
  const fixture = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === failedCommand
    ? Promise.reject(new Error("Vault is locked")) : fixture(command, args));
  await renderModal();
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(saveCalls()).toHaveLength(failedCommand === "proxy_list_get" ? 0 : 1);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Vault is locked");
  expect(container.textContent).not.toContain("加载代理列表中");
  if (failedCommand === "proxy_list_save") expect(container.textContent).toContain("后端代理");
});

it("retries only reading after a committed migration cannot be verified", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  const fixture = vi.mocked(invoke).getMockImplementation()!;
  let reads = 0;
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "proxy_list_get" && ++reads === 2) return Promise.reject(new Error("verification offline"));
    return fixture(command, args);
  });
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/已保存.*刷新/);
  await refresh();
  expect(saveCalls()).toHaveLength(1);
  expect(container.textContent).toContain("历史代理");
  expect(container.textContent).not.toContain("加载代理列表中");
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  await renderModal(false);
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
});

it("keeps every backend row when verification reports an incomplete merged list", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, [backendProxy]);
  vi.mocked(invoke).mockResolvedValueOnce([backendProxy])
    .mockResolvedValueOnce([backendProxy, migratedProxy]).mockResolvedValue([migratedProxy]);
  await renderModal();
  expect(saveCalls()[0][1]).toEqual({ proxies: [
    { ...backendProxy, clear_password: false }, { ...legacyProxy, clear_password: false },
  ] });
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/确认.*刷新/);
  expect(container.textContent).toContain("后端代理");
});

it("migrates a credential-free row without inventing a secret reference", async () => {
  const credentialFree = { ...legacyProxy, password: null };
  await migrationFixture(JSON.stringify([credentialFree]));
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(saveCalls()[0][1]).toEqual({ proxies: [{ ...credentialFree, clear_password: false }] });
  expect(localStorage.getItem(legacyKey)).toBeNull();
  expect(container.querySelector('[title="已加密保存凭据"]')).toBeNull();
});

it.each(["resolve", "reject"])("prevents a late read %s from clearing the reopened load or error", async (outcome) => {
  await migrationFixture(JSON.stringify([legacyProxy]));
  const old = deferred<ProxyServerConfig[]>();
  const current = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await renderModal();
  await renderModal(false);
  await renderModal();
  await act(async () => {
    if (outcome === "resolve") old.resolve([]);
    else old.reject(new Error("stale-error"));
  });
  expect(saveCalls()).toHaveLength(0);
  expect(container.textContent).toContain("加载代理列表中");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => current.reject(new Error("current-error")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("current-error");
  expect(container.textContent).not.toContain("加载代理列表中");
  expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify([legacyProxy]));
});

it("shares an in-flight migration with refresh and reports only sanitized committed output", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  const saving = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockImplementation(async (command) => command === "proxy_list_save"
    ? saving.promise : saveCalls().length ? [migratedProxy] : []);
  const changed = vi.fn();
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} onChanged={changed} />));
  await refresh();
  expect(saveCalls()).toHaveLength(1);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  fill("proxy-name", "不得竞争保存");
  fill("proxy-host", "127.0.0.10");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(saveCalls()).toHaveLength(1);
  await act(async () => saving.resolve([{ ...migratedProxy, password: "synthetic-response-secret" } as ProxyServerInput]));
  expect(saveCalls()).toHaveLength(1);
  expect(changed).toHaveBeenCalledWith([migratedProxy]);
  expect(JSON.stringify(changed.mock.calls)).not.toMatch(/synthetic-response-secret|synthetic-migration-secret/);
  expect(container.textContent).toContain("历史代理");
  expect(container.textContent).not.toContain("加载代理列表中");
  expect(localStorage.getItem(legacyKey)).toBeNull();
});

it("continues verification after onChanged fails without classifying the committed write as failed", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  await act(async () => root.render(<ProxyManagerModal open onClose={() => {}} onChanged={() => {
    throw new Error("notification failed");
  }} />));
  expect(saveCalls()).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "proxy_list_get", "proxy_list_save", "proxy_list_get",
  ]);
  expect(localStorage.getItem(legacyKey)).toBeNull();
  expect(container.textContent).toContain("历史代理");
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/已保存.*刷新/);
  await refresh();
  expect(saveCalls()).toHaveLength(1);
});

it("does not resubmit a committed migration after verification fails and the component is unmounted", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  const fixture = vi.mocked(invoke).getMockImplementation()!;
  let reads = 0;
  vi.mocked(invoke).mockImplementation((command, args) => command === "proxy_list_get" && ++reads === 2
    ? Promise.reject(new Error("verification failed")) : fixture(command, args));
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  act(() => root.unmount());
  root = createRoot(container);
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/冲突.*处理/);
  expect(container.textContent).toContain("历史代理");
});

it("retains cache when verification does not confirm the persisted credential", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  vi.mocked(invoke).mockImplementation(async (command) => command === "proxy_list_save"
    ? [migratedProxy] : []);
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/确认.*刷新/);
  await refresh();
  expect(saveCalls()).toHaveLength(1);
});

it("keeps a concurrent cache replacement while finishing the original migration", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  const saving = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockImplementation(async (command) => command === "proxy_list_save"
    ? saving.promise : saveCalls().length ? [migratedProxy] : []);
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  const replacement = JSON.stringify([{ ...legacyProxy, password: "synthetic-concurrent-secret" }]);
  localStorage.setItem(legacyKey, replacement);
  await act(async () => saving.resolve([migratedProxy]));
  expect(localStorage.getItem(legacyKey)).toBe(replacement);
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/变化.*处理/);
  expect(container.textContent).toContain("历史代理");
});

it("does not let a stale backend read overwrite a reopened dialog or initiate migration", async () => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw);
  const reading = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockReturnValueOnce(reading.promise).mockResolvedValue([backendProxy]);
  await renderModal();
  await renderModal(false);
  localStorage.removeItem(legacyKey);
  await renderModal();
  expect(container.textContent).toContain("后端代理");
  await act(async () => reading.resolve([]));
  expect(saveCalls()).toHaveLength(0);
  expect(container.textContent).toContain("后端代理");
  expect(container.textContent).not.toContain("暂无代理服务器");
});

it.each(["resolve", "reject"])("owns migration loading across close/reopen while an old save %s", async (outcome) => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, [backendProxy]);
  const saving = deferred<ProxyServerConfig[]>();
  const verifying = deferred<ProxyServerConfig[]>();
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "proxy_list_save") return saving.promise;
    return ++reads === 1 ? [backendProxy] : verifying.promise;
  });
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  await renderModal(false);
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(container.textContent).toContain("加载代理列表中");
  if (outcome === "reject") {
    await act(async () => saving.reject(new Error("migration save failed")));
    expect(localStorage.getItem(legacyKey)).toBe(raw);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("migration save failed");
  } else {
    await act(async () => saving.resolve([backendProxy, migratedProxy]));
    expect(container.textContent).toContain("加载代理列表中");
    expect(localStorage.getItem(legacyKey)).toBe(raw);
    await act(async () => verifying.resolve([backendProxy, migratedProxy]));
    expect(container.textContent).toContain("历史代理");
    expect(container.textContent).toContain("后端代理");
    expect(localStorage.getItem(legacyKey)).toBeNull();
  }
  expect(container.textContent).not.toContain("加载代理列表中");
});

const dispatchSubmit = () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const readCalls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "proxy_list_get");

it.each([
  { action: "save", outcome: "resolve" }, { action: "save", outcome: "reject" },
  { action: "delete", outcome: "resolve" }, { action: "delete", outcome: "reject" },
])("blocks refreshing/migrating and same-tick writes while ordinary $action is pending ($outcome)", async ({ action, outcome }) => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, [backendProxy]);
  const fixture = vi.mocked(invoke).getMockImplementation()!;
  const mutation = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "proxy_list_save") {
      if (saveCalls().length === 1) return Promise.reject(new Error("first migration failed"));
      return mutation.promise;
    }
    return fixture(command, args);
  });
  await renderModal();
  expect(saveCalls()).toHaveLength(1);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  fill("proxy-name", "用户新增代理");
  fill("proxy-host", "127.0.0.11");
  const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除代理 后端代理"]')!;
  const refreshButton = container.querySelector<HTMLButtonElement>('button[title="刷新代理列表"]')!;
  await act(async () => {
    if (action === "save") dispatchSubmit();
    else deleteButton.click();
    // Same event turn: React has not rendered disabled controls yet.
    dispatchSubmit();
    deleteButton.click();
    refreshButton.click();
  });
  expect(saveCalls()).toHaveLength(2);
  expect(readCalls()).toHaveLength(1);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="删除代理 后端代理"]')!.disabled).toBe(true);
  await refresh();
  expect(readCalls()).toHaveLength(1);
  expect(saveCalls()).toHaveLength(2);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  const payload = saveCalls()[1][1] as { proxies: ProxyServerInput[] };
  if (action === "save") expect(payload.proxies.map((proxy) => proxy.name)).toEqual(["后端代理", "用户新增代理"]);
  else expect(payload.proxies).toEqual([]);
  if (outcome === "resolve") {
    await act(async () => mutation.resolve(payload.proxies.map(({ password: _password, clear_password: _clear, ...proxy }) => proxy)));
    if (action === "save") expect(container.textContent).toContain("用户新增代理");
    else expect(container.textContent).not.toContain("后端代理");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } else {
    await act(async () => mutation.reject(new Error("ordinary mutation failed")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("ordinary mutation failed");
    expect(container.textContent).toContain("后端代理");
  }
  expect(readCalls()).toHaveLength(1);
  expect(saveCalls()).toHaveLength(2);
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(container.textContent).not.toContain("保存中...");
  expect(container.textContent).not.toContain("加载代理列表中");
});

it.each([
  { action: "save", outcome: "resolve" }, { action: "save", outcome: "reject" },
  { action: "delete", outcome: "resolve" }, { action: "delete", outcome: "reject" },
])("keeps current view ownership when ordinary $action finishes after close/reopen ($outcome)", async ({ action, outcome }) => {
  const raw = "{invalid-legacy";
  await migrationFixture(raw, [backendProxy]);
  const mutation = deferred<ProxyServerConfig[]>();
  const reading = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockImplementation((command) => command === "proxy_list_save"
    ? mutation.promise : readCalls().length === 1 ? Promise.resolve([backendProxy]) : reading.promise);
  await renderModal();
  fill("proxy-name", "旧表单代理");
  fill("proxy-host", "127.0.0.12");
  await act(async () => {
    if (action === "save") dispatchSubmit();
    else container.querySelector<HTMLButtonElement>('button[aria-label="删除代理 后端代理"]')!.click();
  });
  expect(saveCalls()).toHaveLength(1);
  await renderModal(false);
  await renderModal();
  expect(readCalls()).toHaveLength(1);
  fill("proxy-name", "新表单保留");
  fill("proxy-host", "127.0.0.13");
  if (outcome === "resolve") await act(async () => mutation.resolve(action === "delete" ? [] : [backendProxy]));
  else await act(async () => mutation.reject(new Error("obsolete mutation failure")));
  expect(readCalls()).toHaveLength(2);
  expect(container.textContent).toContain("加载代理列表中");
  expect(input("proxy-name").value).toBe("新表单保留");
  expect(container.textContent).not.toContain("obsolete mutation failure");
  await act(async () => reading.resolve([backendProxy]));
  expect(input("proxy-name").value).toBe("新表单保留");
  expect(container.textContent).toContain("后端代理");
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/历史代理.*处理/);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(container.textContent).not.toContain("加载代理列表中");
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  expect(saveCalls()).toHaveLength(1);
});

it.each(["resolve", "reject"])("blocks same-tick ordinary writes after refresh starts a pending read (%s)", async (outcome) => {
  const raw = JSON.stringify([legacyProxy]);
  await migrationFixture(raw, [backendProxy]);
  const reading = deferred<ProxyServerConfig[]>();
  vi.mocked(invoke).mockImplementation((command) => command === "proxy_list_save"
    ? Promise.reject(new Error("migration cannot save"))
    : readCalls().length === 1 ? Promise.resolve([backendProxy]) : reading.promise);
  await renderModal();
  fill("proxy-name", "读取期间禁止提交");
  fill("proxy-host", "127.0.0.14");
  const deleteButton = container.querySelector<HTMLButtonElement>('button[aria-label="删除代理 后端代理"]')!;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[title="刷新代理列表"]')!.click();
    dispatchSubmit();
    deleteButton.click();
    dispatchSubmit();
  });
  expect(readCalls()).toHaveLength(2);
  expect(saveCalls()).toHaveLength(1);
  expect(container.textContent).toContain("加载代理列表中");
  expect(localStorage.getItem(legacyKey)).toBe(raw);
  if (outcome === "resolve") await act(async () => reading.resolve([backendProxy]));
  else await act(async () => reading.reject(new Error("current refresh failed")));
  expect(saveCalls()).toHaveLength(outcome === "resolve" ? 2 : 1);
  expect(container.textContent).toContain("后端代理");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(outcome === "resolve" ? "migration cannot save" : "current refresh failed");
  expect(input("proxy-name").value).toBe("读取期间禁止提交");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(container.textContent).not.toContain("加载代理列表中");
  expect(localStorage.getItem(legacyKey)).toBe(raw);
});
