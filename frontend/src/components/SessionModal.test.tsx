import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionModal } from "./SessionModal";
import { importSshKey } from "../lib/ipc";

vi.mock("../stores/sessionStore", () => ({ useSessionStore: () => ({ sessions: [], groups: [] }) }));
vi.mock("../stores/serialStore", () => ({ useSerialStore: () => ({ ports: [], loadPorts: vi.fn() }) }));
vi.mock("../stores/vaultStore", () => ({ useVaultStore: Object.assign(
  () => ({ status: { state: "unlocked" }, checkStatus: vi.fn().mockResolvedValue(undefined) }),
  { getState: () => ({ status: { state: "unlocked" } }) },
) }));
vi.mock("../lib/ipc", () => ({
  listSshKeys: vi.fn().mockResolvedValue([]),
  importSshKey: vi.fn(), setSshKeyPassphrase: vi.fn(), deleteSshKey: vi.fn(), createCredential: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = () => {};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows a labelled passphrase before import and retries the same key with the corrected passphrase", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => { act(() => root.unmount()); container.remove(); };
  await act(async () => root.render(<SessionModal isOpen onClose={() => {}} initialValues={{ auth_method: "publickey" }} />));
  const input = container.querySelector<HTMLInputElement>("#session-key-passphrase")!;
  expect(input?.type).toBe("password");
  expect(container.querySelector('label[for="session-key-passphrase"]')?.textContent).toContain("私钥口令");
  const changePassphrase = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  changePassphrase("wrong");
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----";
  vi.mocked(importSshKey).mockRejectedValueOnce({ code: "VALIDATION", message: "私钥口令不正确" });
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(fileInput, "files", { value: [{ name: "id_ed25519", text: async () => pem }] });
  await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
  expect(importSshKey).toHaveBeenLastCalledWith("id_ed25519", pem, "wrong");
  changePassphrase("correct");
  vi.mocked(importSshKey).mockResolvedValueOnce({ id: "key", name: "id_ed25519" } as Awaited<ReturnType<typeof importSshKey>>);
  const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "重试导入")!;
  await act(async () => retry.click());
  expect(importSshKey).toHaveBeenLastCalledWith("id_ed25519", pem, "correct");
  expect(input.value).toBe("");
});
