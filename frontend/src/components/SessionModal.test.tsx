import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionModal } from "./SessionModal";
import { importSshKey, listSshKeys, pickSshKeyFile } from "../lib/ipc";
import type { SshKey } from "../types/ipc";

vi.mock("./ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

const { vault } = vi.hoisted(() => ({ vault: {
  status: { state: "unlocked" }, checkStatus: vi.fn().mockResolvedValue(undefined),
} }));
vi.mock("../stores/sessionStore", () => ({ useSessionStore: () => ({ sessions: [], groups: [] }) }));
vi.mock("../stores/serialStore", () => ({ useSerialStore: () => ({ ports: [], loadPorts: vi.fn() }) }));
vi.mock("../stores/vaultStore", () => ({ useVaultStore: Object.assign(
  (selector?: (state: typeof vault) => unknown) => selector ? selector(vault) : vault,
  { getState: () => vault },
) }));
vi.mock("../lib/ipc", () => ({
  listSshKeys: vi.fn(), importSshKey: vi.fn(), pickSshKeyFile: vi.fn(),
  deleteSshKey: vi.fn(), createCredential: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); vault.status.state = "unlocked"; vi.clearAllMocks(); });

function click(text: string) {
  const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text);
  expect(button, text).toBeTruthy();
  button!.click();
}
function fill(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function render(keys: SshKey[] = []) {
  vi.mocked(listSshKeys).mockResolvedValue(keys);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => root.render(<SessionModal isOpen onClose={() => {}} initialValues={{ auth_method: "publickey" }} />));
  return container;
}

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
