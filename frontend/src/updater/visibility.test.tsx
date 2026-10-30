import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBadge } from "./UpdateBadge";
import { UpdateModal } from "./UpdateModal";
import { SettingsDropdown } from "../components/SettingsDropdown";
import { useUpdaterStore } from "./store";
import * as api from "./ipc";
import { DEFAULT_UPDATE_CONFIG, type UpdateCheckResult } from "./types";

vi.mock("./ipc", () => ({
  checkForUpdate: vi.fn(), fetchUpdaterState: vi.fn(), skipVersion: vi.fn(),
  remindLater: vi.fn(), downloadInstaller: vi.fn(), installUpdate: vi.fn(),
}));
vi.mock("../components/ui/GlassMaterial", () => ({ GlassMaterial: () => null }));

const result = (has_update = true): UpdateCheckResult => ({
  has_update, current_version: "1.1.1", latest_version: "1.1.2", tag: "v1.1.2",
  release_name: "OpenShell 1.1.2", release_notes: "", notes_html: "",
  mandatory: true, channel: "stable", from_cache: false,
  release_page_url: "https://github.com/fieecbin-source/openshell/releases/tag/v1.1.2",
  source: "github", checked_at_ms: 1,
});

describe("optional update notifications", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    useUpdaterStore.setState({ state: { kind: "idle" }, modalOpen: false, config: DEFAULT_UPDATE_CONFIG });
    vi.mocked(api.fetchUpdaterState).mockResolvedValue(null as never);
    vi.mocked(api.skipVersion).mockResolvedValue(undefined);
    vi.mocked(api.remindLater).mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("hides the badge and menu update text before a release is available", () => {
    act(() => root.render(<><UpdateBadge /><SettingsDropdown onOpenSettings={vi.fn()}
      onOpenSync={vi.fn()} onOpenAbout={vi.fn()} onCheckUpdate={vi.fn()} /></>));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="设置菜单"]')!.click());
    expect(container.querySelector('[aria-label="检查更新"]')).toBeNull();
    expect(container.textContent).not.toMatch(/新版本|软件更新/);
    act(() => useUpdaterStore.setState({ state: { kind: "latest", result: result(false) } }));
    expect(container.querySelector('[aria-label="检查更新"]')).toBeNull();
    act(() => useUpdaterStore.setState({ state: { kind: "available", result: result() } }));
    expect(container.querySelector('[aria-label="检查更新"]')).not.toBeNull();
    expect(container.textContent).toContain("发现新版本");
  });

  it("only shows a passive badge on a background check and keeps updating optional", async () => {
    vi.mocked(api.checkForUpdate).mockResolvedValue({ result: result(), decision: "notify", from_cache: false });
    await useUpdaterStore.getState().check(false);
    expect(useUpdaterStore.getState().modalOpen).toBe(false);
    expect(useUpdaterStore.getState().state).toMatchObject({ kind: "available", result: { mandatory: false } });
    expect(api.downloadInstaller).not.toHaveBeenCalled();
    expect(api.installUpdate).not.toHaveBeenCalled();
    act(() => { useUpdaterStore.setState({ modalOpen: true }); root.render(<UpdateModal />); });
    expect(container.textContent).toContain("跳过此版本");
    expect(container.textContent).toContain("稍后提醒");
    expect(container.textContent).not.toContain("此版本必须升级");
  });

  it.each(["skipped", "remind_later"] as const)("honors %s on future background checks", async (decision) => {
    vi.mocked(api.checkForUpdate).mockResolvedValue({ result: result(), decision, from_cache: false });
    await useUpdaterStore.getState().check(false);
    expect(useUpdaterStore.getState().state.kind).toBe("idle");
    expect(useUpdaterStore.getState().modalOpen).toBe(false);
    await useUpdaterStore.getState().check(true);
    expect(useUpdaterStore.getState().state.kind).toBe("available");
    expect(useUpdaterStore.getState().modalOpen).toBe(true);
  });

  it.each(["skipVersion", "remindLater"] as const)("dismisses the notification with %s without installing", async (action) => {
    useUpdaterStore.setState({ state: { kind: "available", result: result() }, modalOpen: true });
    await useUpdaterStore.getState()[action]();
    expect(useUpdaterStore.getState().state.kind).toBe("idle");
    expect(useUpdaterStore.getState().modalOpen).toBe(false);
    expect(api.installUpdate).not.toHaveBeenCalled();
  });
});
