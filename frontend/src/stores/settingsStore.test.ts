import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { allThemes, applyThemeToDocument, colorContrast, DEFAULT_SETTINGS, resolveTheme, useSettingsStore } from "./settingsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("shell and terminal appearance isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(null);
    document.documentElement.removeAttribute("style");
    document.documentElement.className = "";
    useSettingsStore.setState({ theme: "clean_light", backgroundOpacity: DEFAULT_SETTINGS.backgroundOpacity, customThemes: {} });
  });

  it("keeps light chrome when switching between light, dark and imported terminal themes", () => {
    for (const theme of ["clean_light", "dark", "custom_light"]) {
      document.documentElement.style.setProperty("--os-ink", "0 0 0");
      document.documentElement.style.setProperty("--os-surface", "255 255 255");
      applyThemeToDocument(theme);
      expect(document.documentElement.classList.contains("dark")).toBe(false);
      expect(document.documentElement.style.getPropertyValue("--os-ink")).toBe("");
      expect(document.documentElement.style.getPropertyValue("--os-surface")).toBe("");
    }
  });

  it("limits wallpaper opacity before persisting it", async () => {
    const setOpacity = useSettingsStore.getState().setBackgroundOpacity;
    await setOpacity(100);
    expect(useSettingsStore.getState().backgroundOpacity).toBe(100);
    expect(invoke).toHaveBeenLastCalledWith("settings_set", expect.objectContaining({ value: 100 }));
    await setOpacity(64);
    expect(useSettingsStore.getState().backgroundOpacity).toBe(64);
    expect(invoke).toHaveBeenLastCalledWith("settings_set", expect.objectContaining({ value: 64 }));
    await setOpacity(150);
    expect(useSettingsStore.getState().backgroundOpacity).toBe(100);
    await setOpacity(-10);
    expect(useSettingsStore.getState().backgroundOpacity).toBe(0);
    await setOpacity(Number.NaN);
    expect(useSettingsStore.getState().backgroundOpacity).toBe(100);
  });

  it("restores full wallpaper opacity without changing the terminal theme", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "settings_get") return null;
      const key = (args as { key: string }).key;
      return key === "terminal.background_opacity" ? { value_json: 100 }
        : key === "terminal.theme" ? { value_json: "clean_light" } : null;
    });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().backgroundOpacity).toBe(100);
    expect(useSettingsStore.getState().theme).toBe("clean_light");
  });

  it("defaults to full wallpaper opacity and pure black terminal text", async () => {
    await useSettingsStore.getState().loadSettings();
    const store = useSettingsStore.getState();
    expect(store.backgroundOpacity).toBe(100);
    expect(resolveTheme(store.theme, store.customThemes).foreground).toBe("#000000");
    expect(resolveTheme(store.theme, store.customThemes).black).toBe("#000000");
  });

  it.each([0, 35, 70, 100])("preserves saved wallpaper opacity %i across reloads", async (opacity) => {
    const values = new Map<string, unknown>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const data = args as { key: string; value: unknown };
      if (command === "settings_set") { values.set(data.key, data.value); return null; }
      return values.has(data.key) ? { value_json: values.get(data.key) } : null;
    });
    await useSettingsStore.getState().setBackgroundOpacity(opacity);
    useSettingsStore.setState({ backgroundOpacity: 50 });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().backgroundOpacity).toBe(opacity);
  });

  it("rejects dark background changes and preserves the current readable theme", async () => {
    await expect(useSettingsStore.getState().setTerminalColor("background", "#101010")).rejects.toThrow("浅色背景");
    expect(useSettingsStore.getState().theme).toBe("clean_light");
    expect(Object.keys(useSettingsStore.getState().customThemes)).toHaveLength(0);
  });

  it("persists a custom foreground and restores it on reload", async () => {
    const values = new Map<string, unknown>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const data = args as { key: string; value: unknown };
      if (command === "settings_set") { values.set(data.key, data.value); return null; }
      return values.has(data.key) ? { value_json: values.get(data.key) } : null;
    });
    await useSettingsStore.getState().setTerminalColor("foreground", "#24466b");
    useSettingsStore.setState({ theme: "clean_light", customThemes: {} });
    await useSettingsStore.getState().loadSettings();
    const store = useSettingsStore.getState();
    expect(resolveTheme(store.theme, store.customThemes).foreground).toBe("#24466b");
    expect(colorContrast(resolveTheme(store.theme, store.customThemes).foreground, "#fcfdff")).toBeGreaterThan(7);
  });

  it("filters dark presets and falls back safely when a legacy theme is selected", async () => {
    expect(Object.keys(allThemes({}))).not.toContain("dark");
    await useSettingsStore.getState().setTheme("dark");
    expect(useSettingsStore.getState().theme).toBe(DEFAULT_SETTINGS.theme);
    expect(resolveTheme("dark", {}).background).toBe("#fcfdff");
  });

  it("rejects low-contrast and malformed foreground values", async () => {
    await expect(useSettingsStore.getState().setTerminalColor("foreground", "#eeeeee")).rejects.toThrow("对比度");
    await expect(useSettingsStore.getState().setTerminalColor("foreground", "invalid")).rejects.toThrow("六位");
  });

  it("migrates old 13px defaults once and then respects the saved size", async () => {
    const values = new Map<string, unknown>([["terminal.font_size", 13], ["terminal.theme", "dark"]]);
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const data = args as { key: string; value: unknown };
      if (command === "settings_set") { values.set(data.key, data.value); return null; }
      return values.has(data.key) ? { value_json: values.get(data.key) } : null;
    });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().fontSize).toBe(14);
    expect(useSettingsStore.getState().theme).toBe("clean_light");
    await useSettingsStore.getState().setFontSize(15);
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().fontSize).toBe(15);
  });

});
