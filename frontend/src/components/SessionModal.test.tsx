import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionModal } from "./SessionModal";
import { importSshKey, listSshKeys, pickSshKeyFile } from "../lib/ipc";
import type { Session, SessionInput, SshKey } from "../types/ipc";

vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

const { vault } = vi.hoisted(() => ({
  vault: {
    status: { state: "unlocked" }, checkStatus: vi.fn().mockResolvedValue(undefined),
  }
}));
const actions = vi.hoisted(() => ({ createSession: vi.fn(), updateSession: vi.fn() }));
vi.mock("../stores/sessionStore", () => ({ useSessionStore: () => ({ sessions: [], groups: [], ...actions }) }));
vi.mock("../stores/serialStore", () => ({ useSerialStore: () => ({ ports: [], loadPorts: vi.fn() }) }));
vi.mock("../stores/vaultStore", () => ({
  useVaultStore: Object.assign(
    (selector?: (state: typeof vault) => unknown) => selector ? selector(vault) : vault,
    { getState: () => vault },
  )
}));
vi.mock("../lib/ipc", () => ({
  listSshKeys: vi.fn(), importSshKey: vi.fn(), pickSshKeyFile: vi.fn(),
  deleteSshKey: vi.fn(), createCredential: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => { };
afterEach(() => { cleanup(); vault.status.state = "unlocked"; vi.clearAllMocks(); });

function click(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text);
  expect(button, text).toBeTruthy();
  button!.click();
}
function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  setInputValue(input, value);
}
function fillByLabel(label: string, value: string) {
  const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  setInputValue(input, value);
}
function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function render(keys: SshKey[] = [], initialValues: Partial<SessionInput> = { auth_method: "publickey" }, editingSession?: Session, onClose = () => { }) {
  vi.mocked(listSshKeys).mockResolvedValue(keys);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => root.render(<SessionModal isOpen onClose={onClose} initialValues={initialValues} editingSession={editingSession} />));
  return container;
}

it("exposes the connection dialog and closes it on Escape", async () => {
  const onClose = vi.fn();
  await render([], undefined, undefined, onClose);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"][aria-label="新建 SSH 连接"][aria-modal="true"]')).toBeTruthy();
});

it("closes only the nested proxy dialog before its connection dialog", async () => {
  const onClose = vi.fn();
  await render([], undefined, undefined, onClose);
  await act(async () => click("管理代理..."));
  expect(document.querySelector('[role="dialog"][aria-label="代理服务器管理"]')).toBeTruthy();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"][aria-label="代理服务器管理"]')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("chooses historical aliases and opens an import dialog before entering a password", async () => {
  const keys = [{ id: "first", name: "生产主机" }, { id: "second", name: "测试主机" }] as SshKey[];
  const container = await render(keys);
  expect(container.textContent).toContain("公钥连接");
  expect(document.getElementById("ssh-key-password")).toBeNull();
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="已保存的私钥"]')!;
  await act(async () => { select.value = "second"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelector('[aria-label="当前私钥"]')?.textContent).toBe("测试主机");
  await act(async () => click("导入私钥"));
  expect(document.querySelector('[role="dialog"][aria-label="导入 SSH 私钥"]')).toBeTruthy();
  vi.mocked(pickSshKeyFile).mockResolvedValue({ file_name: "id_ed25519", pem: "encrypted private key" });
  await act(async () => click("选择文件"));
  expect(importSshKey).not.toHaveBeenCalled();
  expect((document.getElementById("ssh-key-file") as HTMLInputElement).value).toBe("id_ed25519");
  await act(async () => document.querySelector<HTMLDivElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"][aria-label="导入 SSH 私钥"]')).toBeNull();
  expect(select.options.length).toBe(3);
  expect(importSshKey).not.toHaveBeenCalled();
});

it("keeps failed imports out of the list until the password is corrected", async () => {
  const container = await render();
  await act(async () => click("导入私钥"));
  vi.mocked(pickSshKeyFile).mockResolvedValue({ file_name: "id_rsa", pem: "encrypted private key" });
  await act(async () => click("选择文件"));
  act(() => fill("ssh-key-name", "自定义主机"));
  for (const [password, message] of [["", "该私钥已加密，请填写私钥口令。"], ["wrong", "私钥口令不正确。"]]) {
    act(() => fill("ssh-key-password", password));
    vi.mocked(importSshKey).mockRejectedValueOnce({ code: "VALIDATION", message });
    await act(async () => click("保存私钥"));
    expect(document.body.textContent).toContain(message);
    expect((document.getElementById("ssh-key-file") as HTMLInputElement).value).toBe("id_rsa");
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="已保存的私钥"]')!.options.length).toBe(1);
  }
  act(() => fill("ssh-key-password", "correct"));
  vi.mocked(importSshKey).mockResolvedValueOnce({ id: "new", name: "自定义主机", has_passphrase: true } as SshKey);
  await act(async () => click("保存私钥"));
  expect(importSshKey).toHaveBeenLastCalledWith("自定义主机", "encrypted private key", "correct");
  expect(document.querySelector('[role="dialog"][aria-label="导入 SSH 私钥"]')).toBeNull();
  expect(container.querySelector('[aria-label="当前私钥"]')?.textContent).toBe("自定义主机");
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="已保存的私钥"]')!.value).toBe("new");
});

it("saves an unencrypted key without a password", async () => {
  const container = await render();
  await act(async () => click("导入私钥"));
  vi.mocked(pickSshKeyFile).mockResolvedValue({ file_name: "id_ed25519", pem: "unencrypted private key" });
  await act(async () => click("选择文件"));
  vi.mocked(importSshKey).mockResolvedValueOnce({ id: "plain", name: "id_ed25519", has_passphrase: false } as SshKey);
  await act(async () => click("保存私钥"));
  expect(importSshKey).toHaveBeenLastCalledWith("id_ed25519", "unencrypted private key", undefined);
  expect(container.querySelector('[aria-label="当前私钥"]')?.textContent).toBe("id_ed25519");
});

it("does not save a previously selected key after a replacement file cannot be read", async () => {
  await render();
  await act(async () => click("导入私钥"));
  vi.mocked(pickSshKeyFile).mockResolvedValueOnce({ file_name: "id_ed25519", pem: "old key" });
  await act(async () => click("选择文件"));
  vi.mocked(pickSshKeyFile).mockRejectedValueOnce({ code: "VALIDATION", message: "无法读取私钥文件。" });
  await act(async () => click("选择文件"));
  await act(async () => click("保存私钥"));
  expect(importSshKey).not.toHaveBeenCalled();
  expect((document.getElementById("ssh-key-file") as HTMLInputElement).value).toBe("");
});

it("keeps the selected file when the vault is locked and saves only after unlocking", async () => {
  vault.status.state = "locked";
  const container = await render();
  await act(async () => click("导入私钥"));
  vi.mocked(pickSshKeyFile).mockResolvedValue({ file_name: "id_ed25519", pem: "unencrypted private key" });
  await act(async () => click("选择文件"));
  await act(async () => click("保存私钥"));
  expect(importSshKey).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("请先解锁保险库");
  expect(document.querySelector('input[aria-label="保险库主密码"]')).toBeTruthy();
  vault.status.state = "unlocked";
  vi.mocked(importSshKey).mockResolvedValueOnce({ id: "unlocked", name: "id_ed25519" } as SshKey);
  await act(async () => click("保存私钥"));
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="已保存的私钥"]')!.value).toBe("unlocked");
});

it("saves a system selected from the first-host flow", async () => {
  const container = await render([], { host: "demo.example.invalid", icon_key: "os:ubuntu", auth_method: "password" });
  await act(async () => click("主机图标"));
  expect(container.querySelector<HTMLInputElement>('input[value="os:ubuntu"]')!.checked).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[value="os:debian"]')!.click());
  actions.createSession.mockResolvedValue({ id: "created" });
  await act(async () => click("仅保存"));
  expect(actions.createSession).toHaveBeenCalledWith(expect.objectContaining({ icon_key: "os:debian", host: "demo.example.invalid" }));
});

it("loads the saved system when editing and can restore the default icon", async () => {
  const session = { id: "existing", name: "Production", protocol: "ssh", host: "demo.example.invalid", port: 22, username: "deploy", auth_method: "password", icon_key: "os:macos" } as Session;
  const container = await render([], {}, session);
  await act(async () => click("主机图标"));
  expect(container.querySelector<HTMLInputElement>('input[value="os:macos"]')!.checked).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[value="os:tux"]')!.click());
  actions.updateSession.mockResolvedValue({ ...session, icon_key: null });
  await act(async () => click("仅保存"));
  expect(actions.updateSession).toHaveBeenCalledWith(session.id, expect.objectContaining({ icon_key: null }));
});

it("filters the icon grid by keyword and auto-detects a device from session info", async () => {
  const container = await render([], { name: "Office router", host: "192.168.1.1", protocol: "ssh" });
  await act(async () => click("主机图标"));
  act(() => container.querySelector<HTMLButtonElement>('button[title="根据会话名称、主机地址和用户名匹配图标"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[value="device:router"]')!.checked).toBe(true);
  act(() => fillByLabel("搜索图标", "ubuntu"));
  expect(container.querySelector('input[value="device:router"]')).toBeNull();
  expect(container.querySelector('input[value="os:ubuntu"]')).toBeTruthy();
});

it("edits the icon from its own top-level tab", async () => {
  const session = { id: "existing", name: "Production", protocol: "ssh", host: "demo.example.invalid", port: 22, username: "deploy", auth_method: "password", icon_key: "os:macos" } as Session;
  const container = await render([], {}, session);
  await act(async () => click("高级与终端"));
  expect(container.textContent).not.toContain("首次连接会显示主机指纹");
  await act(async () => click("主机图标"));
  expect(container.querySelector<HTMLInputElement>('input[name="icon-tab-host-icon"][value="os:macos"]')!.checked).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[name="icon-tab-host-icon"][value="os:ubuntu"]')!.click());
  expect(container.querySelector<HTMLInputElement>('input[name="icon-tab-host-icon"][value="os:ubuntu"]')!.checked).toBe(true);
  actions.updateSession.mockResolvedValue({ ...session, icon_key: "os:ubuntu" });
  await act(async () => click("仅保存"));
  expect(actions.updateSession).toHaveBeenCalledWith(session.id, expect.objectContaining({ icon_key: "os:ubuntu" }));
});

it("renders dedicated protocol titles and allows compact switching for new sessions", async () => {
  const container = await render([], { protocol: "ssh" });
  expect(container.querySelector("h3")?.textContent).toBe("新建 SSH 连接");
  const switcher = container.querySelector<HTMLSelectElement>('select[aria-label="切换连接类型"]');
  expect(switcher).toBeTruthy();

  await act(async () => {
    switcher!.value = "rdp";
    switcher!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("h3")?.textContent).toBe("新建 Windows 远程桌面 (RDP)");

  await act(async () => {
    switcher!.value = "serial";
    switcher!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("h3")?.textContent).toBe("新建串口连接 (Serial)");

  await act(async () => {
    switcher!.value = "telnet";
    switcher!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("h3")?.textContent).toBe("新建 Telnet 连接");

  await act(async () => {
    switcher!.value = "local_shell";
    switcher!.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.querySelector("h3")?.textContent).toBe("新建本地终端");
});

it("ensures all input and textarea fields in the modal have no placeholder attribute", async () => {
  const container = await render([], { protocol: "ssh" });
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
  const inputsWithPlaceholder = inputs.filter((el) => el.getAttribute("placeholder") !== null);
  expect(inputsWithPlaceholder).toEqual([]);
});
