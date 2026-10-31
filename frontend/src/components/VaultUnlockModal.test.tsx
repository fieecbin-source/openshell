import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { VaultUnlockModal } from "./VaultUnlockModal";

vi.mock("../stores/vaultStore", () => ({ useVaultStore: () => ({
  status: { state: "uninitialized" }, unlock: vi.fn(), isLoading: false, error: null,
}) }));

it("does not ask for an existing app password or initialize a vault on a factory launch", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<VaultUnlockModal />));
  expect(container.innerHTML).toBe("");
  expect(document.querySelector('[role="dialog"][aria-label="解锁 OpenShell 保险库"]')).toBeNull();
  act(() => root.unmount());
  container.remove();
});
