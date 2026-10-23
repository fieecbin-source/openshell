import { create } from "zustand";
import { settingsGet, settingsSet } from "../lib/ipc";

export type TerminalTheme =
  | "dark"
  | "tokyo_night"
  | "catppuccin_mocha"
  | "catppuccin_latte"
  | "dracula"
  | "nord"
  | "solarized"
  | "monokai"
  | "onedark"
  | "gruvbox"
  | "synthwave"
  | "high_contrast"
  | "clean_light";

export interface TerminalThemeConfig {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const THEMES: Record<TerminalTheme, TerminalThemeConfig> = {
  dark: {
    name: "Midnight (OpenShell)",
    background: "#0d0f14",
    foreground: "#f8fafc",
    cursor: "#10b981",
    cursorAccent: "#0d0f14",
    selectionBackground: "#33415580",
    black: "#1e293b",
    red: "#ef4444",
    green: "#10b981",
    yellow: "#f59e0b",
    blue: "#3b82f6",
    magenta: "#ec4899",
    cyan: "#06b6d4",
    white: "#f8fafc",
    brightBlack: "#475569",
    brightRed: "#f87171",
    brightGreen: "#34d399",
    brightYellow: "#fbbf24",
    brightBlue: "#60a5fa",
    brightMagenta: "#f472b6",
    brightCyan: "#22d3ee",
    brightWhite: "#ffffff",
  },
  tokyo_night: {
    name: "Tokyo Night",
    background: "#1a1b26",
    foreground: "#a9b1d6",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#33467c",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  catppuccin_mocha: {
    name: "Catppuccin Mocha",
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#585b7066",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  catppuccin_latte: {
    name: "Catppuccin Latte",
    background: "#eff1f5",
    foreground: "#4c4f69",
    cursor: "#dc8a78",
    cursorAccent: "#eff1f5",
    selectionBackground: "#acb0be66",
    black: "#5c5f77",
    red: "#d20f39",
    green: "#40a02b",
    yellow: "#df8e1d",
    blue: "#1e66f5",
    magenta: "#ea76cb",
    cyan: "#179299",
    white: "#acb0be",
    brightBlack: "#6c6f85",
    brightRed: "#d20f39",
    brightGreen: "#40a02b",
    brightYellow: "#df8e1d",
    brightBlue: "#1e66f5",
    brightMagenta: "#ea76cb",
    brightCyan: "#179299",
    brightWhite: "#bcc0cc",
  },
  dracula: {
    name: "Dracula",
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#50fa7b",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  nord: {
    name: "Nord",
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#d08770",
    brightGreen: "#8fbcbb",
    brightYellow: "#eceff4",
    brightBlue: "#5e81ac",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  solarized: {
    name: "Solarized Dark",
    background: "#002b36",
    foreground: "#839496",
    cursor: "#2aa198",
    cursorAccent: "#002b36",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  monokai: {
    name: "Monokai Pro",
    background: "#2d2a2e",
    foreground: "#fcfcfa",
    cursor: "#ffd866",
    cursorAccent: "#2d2a2e",
    selectionBackground: "#403e41",
    black: "#403e41",
    red: "#ff6188",
    green: "#a9dc76",
    yellow: "#ffd866",
    blue: "#78dce8",
    magenta: "#ab9df2",
    cyan: "#78dce8",
    white: "#fcfcfa",
    brightBlack: "#727072",
    brightRed: "#ff6188",
    brightGreen: "#a9dc76",
    brightYellow: "#ffd866",
    brightBlue: "#78dce8",
    brightMagenta: "#ab9df2",
    brightCyan: "#78dce8",
    brightWhite: "#ffffff",
  },
  onedark: {
    name: "One Dark",
    background: "#1e1e2e",
    foreground: "#abb2bf",
    cursor: "#528bff",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#be5046",
    brightGreen: "#98c379",
    brightYellow: "#d19a66",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  gruvbox: {
    name: "Gruvbox Dark",
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#fe8019",
    cursorAccent: "#282828",
    selectionBackground: "#3c3836",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  synthwave: {
    name: "Synthwave '84",
    background: "#262335",
    foreground: "#f92aad",
    cursor: "#fede5d",
    cursorAccent: "#262335",
    selectionBackground: "#34294f",
    black: "#1a1926",
    red: "#fe4450",
    green: "#72f1b8",
    yellow: "#fede5d",
    blue: "#03edf9",
    magenta: "#ff7edb",
    cyan: "#03edf9",
    white: "#ffffff",
    brightBlack: "#614d85",
    brightRed: "#fe4450",
    brightGreen: "#72f1b8",
    brightYellow: "#fede5d",
    brightBlue: "#03edf9",
    brightMagenta: "#ff7edb",
    brightCyan: "#03edf9",
    brightWhite: "#ffffff",
  },
  high_contrast: {
    name: "High Contrast (高对比)",
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#00ff66",
    cursorAccent: "#000000",
    selectionBackground: "#224488",
    black: "#000000",
    red: "#ff3333",
    green: "#33ff33",
    yellow: "#ffff33",
    blue: "#3399ff",
    magenta: "#ff33ff",
    cyan: "#33ffff",
    white: "#ffffff",
    brightBlack: "#555555",
    brightRed: "#ff6666",
    brightGreen: "#66ff66",
    brightYellow: "#ffff66",
    brightBlue: "#66b2ff",
    brightMagenta: "#ff66ff",
    brightCyan: "#66ffff",
    brightWhite: "#ffffff",
  },
  clean_light: {
    name: "Clean Light (明亮极简)",
    background: "#f6f8fa",
    foreground: "#24292f",
    cursor: "#0969da",
    cursorAccent: "#ffffff",
    selectionBackground: "#0969da20",
    black: "#24292f",
    red: "#cf222e",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#116329",
    brightYellow: "#4d2d00",
    brightBlue: "#0550ae",
    brightMagenta: "#6639ba",
    brightCyan: "#124f54",
    brightWhite: "#24292f",
  },
};

interface SettingsState {
  theme: TerminalTheme;
  customThemes: Record<string, TerminalThemeConfig>;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  logSessionOutput: boolean;
  settingsModalOpen: boolean;

  /** 终端背景：空字符串表示不启用，内置壁纸使用 preset id，"custom" 表示自定义图片 */
  backgroundId: string;
  /** 自定义背景图片（data URL），仅当 backgroundId === "custom" 时生效 */
  backgroundCustom: string | null;
  /** 壁纸不透明度 0-100 */
  backgroundOpacity: number;
  /** 壁纸高斯模糊 0-24 px */
  backgroundBlur: number;

  loadSettings: () => Promise<void>;
  setTheme: (theme: TerminalTheme) => Promise<void>;
  setFontSize: (fontSize: number) => Promise<void>;
  setFontFamily: (fontFamily: string) => Promise<void>;
  setCursorBlink: (cursorBlink: boolean) => Promise<void>;
  setLogSessionOutput: (logSessionOutput: boolean) => Promise<void>;
  setSettingsModalOpen: (open: boolean) => void;
  saveCustomTheme: (id: string, config: TerminalThemeConfig) => Promise<void>;

  setBackgroundId: (id: string) => Promise<void>;
  setBackgroundCustom: (dataUrl: string | null) => Promise<void>;
  setBackgroundOpacity: (opacity: number) => Promise<void>;
  setBackgroundBlur: (blur: number) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "clean_light",
  customThemes: {},
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", Consolas, monospace',
  cursorBlink: true,
  logSessionOutput: false,
  settingsModalOpen: false,
  backgroundId: "",
  backgroundCustom: null,
  backgroundOpacity: 45,
  backgroundBlur: 6,

  loadSettings: async () => {
    try {
      const themeRec = await settingsGet("user", "terminal.theme");
      const fontRec = await settingsGet("user", "terminal.font_size");
      const logRec = await settingsGet("user", "terminal.log_session");
      const bgIdRec = await settingsGet("user", "terminal.background_id");
      const bgOpacityRec = await settingsGet("user", "terminal.background_opacity");
      const bgBlurRec = await settingsGet("user", "terminal.background_blur");
      const bgCustomRec = await settingsGet("user", "terminal.background_custom");

      set({
        theme: (themeRec?.value_json as TerminalTheme) || "dark",
        fontSize: (fontRec?.value_json as number) || 13,
        logSessionOutput: (logRec?.value_json as boolean) || false,
        backgroundId: (bgIdRec?.value_json as string) || "",
        backgroundOpacity:
          typeof bgOpacityRec?.value_json === "number" ? (bgOpacityRec.value_json as number) : 45,
        backgroundBlur:
          typeof bgBlurRec?.value_json === "number" ? (bgBlurRec.value_json as number) : 6,
        backgroundCustom: (bgCustomRec?.value_json as string) || null,
      });
    } catch (e) {
      console.warn("load settings error", e);
    }
  },

  setTheme: async (theme: TerminalTheme) => {
    set({ theme });
    try {
      await settingsSet("user", "terminal.theme", theme);
    } catch {}
  },

  setFontSize: async (fontSize: number) => {
    set({ fontSize });
    try {
      await settingsSet("user", "terminal.font_size", fontSize);
    } catch {}
  },

  setFontFamily: async (fontFamily: string) => {
    set({ fontFamily });
    try {
      await settingsSet("user", "terminal.font_family", fontFamily);
    } catch {}
  },

  setCursorBlink: async (cursorBlink: boolean) => {
    set({ cursorBlink });
  },

  setLogSessionOutput: async (logSessionOutput: boolean) => {
    set({ logSessionOutput });
    try {
      await settingsSet("user", "terminal.log_session", logSessionOutput);
    } catch {}
  },

  setSettingsModalOpen: (settingsModalOpen: boolean) => set({ settingsModalOpen }),

  saveCustomTheme: async (id: string, config: TerminalThemeConfig) => {
    const updated = { ...get().customThemes, [id]: config };
    set({ customThemes: updated });
    try {
      await settingsSet("user", "terminal.custom_themes", updated);
    } catch {}
  },

  setBackgroundId: async (backgroundId: string) => {
    set({ backgroundId });
    try {
      await settingsSet("user", "terminal.background_id", backgroundId);
    } catch {}
  },

  setBackgroundCustom: async (backgroundCustom: string | null) => {
    set({ backgroundCustom });
    try {
      await settingsSet("user", "terminal.background_custom", backgroundCustom);
    } catch {}
  },

  setBackgroundOpacity: async (backgroundOpacity: number) => {
    set({ backgroundOpacity });
    try {
      await settingsSet("user", "terminal.background_opacity", backgroundOpacity);
    } catch {}
  },

  setBackgroundBlur: async (backgroundBlur: number) => {
    set({ backgroundBlur });
    try {
      await settingsSet("user", "terminal.background_blur", backgroundBlur);
    } catch {}
  },
}));
