import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBadge } from "./UpdateBadge";
import { UpdateModal } from "./UpdateModal";
import { SettingsDropdown } from "../components/SettingsDropdown";
import { useUpdaterStore } from "./store";
import * as api from "./ipc";
import { DEFAULT_UPDATE_CONFIG, type UpdateCheckResult } from "./types";
import { ToastHost } from "../components/ToastHost";
import { useToastStore } from "../stores/toastStore";

vi.mock("./ipc", () => ({
  checkForUpdate: vi.fn(), fetchUpdaterState: vi.fn(), skipVersion: vi.fn(),
  remindLater: vi.fn(), downloadInstaller: vi.fn(), installUpdate: vi.fn(), cancelDownload: vi.fn(),
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
    vi.mocked(api.cancelDownload).mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useToastStore.getState().clear();
  });

  it("hides the badge and menu update text before a release is available", () => {
    act(() => root.render(<><UpdateBadge /><SettingsDropdown onOpenSettings={vi.fn()}
      onOpenSync={vi.fn()} onOpenAbout={vi.fn()} onCheckUpdate={vi.fn()} /></>));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="设置菜单"]')!.click());
    expect(container.querySelector('[aria-label="立即更新"]')).toBeNull();
    expect(container.textContent).not.toMatch(/新版本|软件更新/);
    act(() => useUpdaterStore.setState({ state: { kind: "latest", result: result(false) } }));
    expect(container.querySelector('[aria-label="立即更新"]')).toBeNull();
    act(() => useUpdaterStore.setState({ state: { kind: "available", result: result() } }));
    expect(container.querySelector('[aria-label="立即更新"]')).not.toBeNull();
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

  it("downloads once from the capsule, displays real progress and only offers installation after success", async () => {
    const release = { ...result(), mandatory: false, asset: {
      name: "OpenShell.exe", url: "https://github.com/a/b/x.exe", size: 100, sha256: "0".repeat(64),
    } };
    let finish!: (outcome: { path: string; bytes: number; resumed_from: number }) => void;
    vi.mocked(api.downloadInstaller).mockImplementation((_config, _asset, onProgress) => {
      onProgress({ received: 76, total: 100, percent: 76, bytes_per_sec: 10, phase: "downloading" });
      return new Promise((resolve) => { finish = resolve; });
    });
    act(() => {
      useUpdaterStore.setState({ state: { kind: "available", result: release } });
      root.render(<><UpdateBadge /><UpdateModal /><ToastHost /></>);
    });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="立即更新"]')!;
    expect(button.textContent).toBe("更新");
    expect(button.className).toContain("text-white");
    expect(button.className).toContain("rounded-full");
    act(() => button.click());
    expect(button.textContent).toBe("76%");
    expect(button.className).toContain("bg-[#3478f6]");
    expect(button.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("76");
    await act(async () => { await useUpdaterStore.getState().download(); });
    expect(api.downloadInstaller).toHaveBeenCalledTimes(1);
    act(() => button.click());
    expect(container.textContent).toContain("取消下载");
    expect(api.downloadInstaller).toHaveBeenCalledTimes(1);
    act(() => useUpdaterStore.setState({ modalOpen: false }));
    act(() => vi.mocked(api.downloadInstaller).mock.calls[0][2]({
      received: 100, total: 100, percent: 100, bytes_per_sec: 0, phase: "verifying",
    }));
    expect(button.textContent).toBe("校验中");
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => { finish({ path: "C:/Downloads/OpenShell.exe", bytes: 100, resumed_from: 0 }); });
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain("下载成功");
    expect(notice.parentElement?.className).toContain("top-4");
    expect(notice.parentElement?.className).toContain("items-center");
    expect(api.installUpdate).not.toHaveBeenCalled();
    act(() => button.click());
    expect(container.textContent).toContain("立即重启安装");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="关闭提示"]')!.click());
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("uses indeterminate progress when the download size is unknown", () => {
    act(() => {
      useUpdaterStore.setState({ state: { kind: "downloading", result: result(), progress: {
        received: 10, percent: 0, bytes_per_sec: 10, phase: "downloading",
      } } });
      root.render(<UpdateBadge />);
    });
    expect(container.textContent).toBe("下载中");
    expect(container.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(false);
  });

  it("shows a failed download without claiming success and keeps retry available", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(api.downloadInstaller).mockRejectedValueOnce({ code: "UPDATE_CHECKSUM_MISMATCH" });
    useUpdaterStore.setState({ state: { kind: "available", result: { ...result(), asset: {
      name: "OpenShell.exe", url: "https://github.com/a/b/x.exe", size: 100, sha256: "0".repeat(64),
    } } } });
    await act(async () => {
      root.render(<><UpdateBadge /><UpdateModal /><ToastHost /></>);
      await useUpdaterStore.getState().download();
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("校验未通过");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="立即更新"]')!.click());
    expect(container.textContent).toContain("重试");
    expect(api.installUpdate).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("opens release details when no matching installer exists", () => {
    act(() => {
      useUpdaterStore.setState({ state: { kind: "available", result: result() } });
      root.render(<UpdateBadge />);
    });
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(useUpdaterStore.getState().modalOpen).toBe(true);
    expect(api.downloadInstaller).not.toHaveBeenCalled();
  });

  it("does not announce success when a cancelled download finishes late", async () => {
    let finish!: (outcome: { path: string; bytes: number; resumed_from: number }) => void;
    vi.mocked(api.downloadInstaller).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    useUpdaterStore.setState({ state: { kind: "available", result: { ...result(), asset: {
      name: "OpenShell.exe", url: "https://github.com/a/b/x.exe", size: 100, sha256: "0".repeat(64),
    } } } });
    const pending = useUpdaterStore.getState().download();
    await useUpdaterStore.getState().cancelDownload();
    finish({ path: "C:/Downloads/OpenShell.exe", bytes: 100, resumed_from: 0 });
    await pending;
    expect(useUpdaterStore.getState().state.kind).toBe("available");
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
