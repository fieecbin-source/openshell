/**
 * 内置终端 / 界面壁纸。
 *
 * 全部使用本地 CSS 绘制（渐变、纹理或纯色），不依赖网络、不占安装体积，也不会因为
 * 分辨率不同而模糊。配色刻意控制在低对比度区间，叠加半透明遮罩后不会影响阅读。
 *
 * 预设分为两类（`kind`）：
 * - `wallpaper`：多层渐变 / 纹理壁纸，观感更丰富；
 * - `solid`：单一纯色，最省 GPU、最干净，适合追求极致简洁。
 */

export type WallpaperKind = "wallpaper" | "solid";

export interface WallpaperPreset {
  id: string;
  name: string;
  /** 预设类型，设置面板据此分组展示 */
  kind: WallpaperKind;
  /** 直接用于 style.backgroundImage；纯色预设为 "none" */
  image: string;
  /** 纯色预设的背景色；渐变预设留空 */
  color?: string;
}

export interface WallpaperStyle {
  backgroundImage: string;
  backgroundColor?: string;
  backgroundSize?: string;
}

export const WALLPAPERS: WallpaperPreset[] = [
  // ---- 渐变 / 纹理壁纸 ----
  {
    id: "aurora",
    name: "极光",
    kind: "wallpaper",
    image:
      "radial-gradient(120% 90% at 12% 8%, rgba(16,185,129,0.45) 0%, rgba(16,185,129,0) 55%)," +
      "radial-gradient(110% 80% at 88% 12%, rgba(59,130,246,0.42) 0%, rgba(59,130,246,0) 60%)," +
      "radial-gradient(140% 120% at 50% 110%, rgba(139,92,246,0.35) 0%, rgba(139,92,246,0) 65%)," +
      "linear-gradient(160deg, #0b1220 0%, #0d1117 55%, #090c12 100%)",
  },
  {
    id: "deep_ocean",
    name: "深海",
    kind: "wallpaper",
    image:
      "radial-gradient(100% 80% at 20% 100%, rgba(6,182,212,0.35) 0%, rgba(6,182,212,0) 60%)," +
      "radial-gradient(90% 70% at 85% 20%, rgba(37,99,235,0.30) 0%, rgba(37,99,235,0) 62%)," +
      "linear-gradient(180deg, #06121c 0%, #04101a 60%, #02080f 100%)",
  },
  {
    id: "neon_night",
    name: "霓虹夜",
    kind: "wallpaper",
    image:
      "radial-gradient(100% 80% at 15% 0%, rgba(217,70,239,0.28) 0%, rgba(217,70,239,0) 58%)," +
      "radial-gradient(90% 70% at 85% 25%, rgba(34,211,238,0.22) 0%, rgba(34,211,238,0) 60%)," +
      "linear-gradient(165deg, #120b20 0%, #0a0714 60%, #06040c 100%)",
  },
  {
    id: "graphite",
    name: "石墨网格",
    kind: "wallpaper",
    image:
      "linear-gradient(rgba(148,163,184,0.055) 1px, transparent 1px)," +
      "linear-gradient(90deg, rgba(148,163,184,0.055) 1px, transparent 1px)," +
      "radial-gradient(120% 90% at 50% 0%, rgba(148,163,184,0.12) 0%, rgba(148,163,184,0) 60%)," +
      "linear-gradient(180deg, #111318 0%, #0c0e12 100%)",
    // 网格尺寸由 WALLPAPER_SIZES 决定
  },
  {
    id: "dot_grid",
    name: "点阵",
    kind: "wallpaper",
    image:
      "radial-gradient(rgba(148,163,184,0.16) 1px, transparent 1.5px)," +
      "radial-gradient(120% 90% at 50% 0%, rgba(99,102,241,0.14) 0%, rgba(99,102,241,0) 62%)," +
      "linear-gradient(180deg, #10141b 0%, #0a0d13 100%)",
  },
  {
    id: "mountain_dusk",
    name: "暮色群山",
    kind: "wallpaper",
    image:
      "linear-gradient(180deg, rgba(251,146,60,0.22) 0%, rgba(244,63,94,0.10) 28%, rgba(30,41,59,0) 55%)," +
      "linear-gradient(180deg, rgba(15,23,42,0) 45%, rgba(2,6,23,0.75) 100%)," +
      "linear-gradient(160deg, #1b2233 0%, #131a28 50%, #0a0f18 100%)",
  },
  {
    id: "forest",
    name: "森林雾霭",
    kind: "wallpaper",
    image:
      "radial-gradient(110% 85% at 25% 20%, rgba(34,197,94,0.24) 0%, rgba(34,197,94,0) 58%)," +
      "radial-gradient(100% 90% at 80% 75%, rgba(20,184,166,0.20) 0%, rgba(20,184,166,0) 62%)," +
      "linear-gradient(170deg, #0e1a14 0%, #0b1410 55%, #070d0a 100%)",
  },
  {
    id: "moss",
    name: "苔原",
    kind: "wallpaper",
    image:
      "radial-gradient(110% 85% at 20% 90%, rgba(101,163,13,0.16) 0%, rgba(101,163,13,0) 58%)," +
      "radial-gradient(90% 80% at 80% 10%, rgba(20,83,45,0.30) 0%, rgba(20,83,45,0) 62%)," +
      "linear-gradient(170deg, #101a12 0%, #0b1410 55%, #070d09 100%)",
  },
  {
    id: "midnight_city",
    name: "午夜城景",
    kind: "wallpaper",
    image:
      "repeating-linear-gradient(90deg, rgba(96,165,250,0.06) 0px, rgba(96,165,250,0.06) 2px, transparent 2px, transparent 18px)," +
      "repeating-linear-gradient(0deg, rgba(96,165,250,0.035) 0px, rgba(96,165,250,0.035) 2px, transparent 2px, transparent 26px)," +
      "radial-gradient(90% 70% at 70% 10%, rgba(129,140,248,0.22) 0%, rgba(129,140,248,0) 62%)," +
      "linear-gradient(180deg, #0b1020 0%, #070a14 100%)",
  },
  {
    id: "sakura",
    name: "夜樱",
    kind: "wallpaper",
    image:
      "radial-gradient(85% 70% at 18% 12%, rgba(244,114,182,0.22) 0%, rgba(244,114,182,0) 58%)," +
      "radial-gradient(90% 75% at 82% 30%, rgba(167,139,250,0.20) 0%, rgba(167,139,250,0) 60%)," +
      "linear-gradient(170deg, #191325 0%, #120e1c 55%, #0a0812 100%)",
  },
  {
    id: "sand_dune",
    name: "沙丘",
    kind: "wallpaper",
    image:
      "radial-gradient(120% 95% at 15% 100%, rgba(234,179,8,0.14) 0%, rgba(234,179,8,0) 58%)," +
      "radial-gradient(110% 90% at 85% 0%, rgba(217,119,6,0.12) 0%, rgba(217,119,6,0) 60%)," +
      "linear-gradient(175deg, #1a1712 0%, #14110d 55%, #0c0a08 100%)",
  },
  {
    id: "carbon",
    name: "碳纤维",
    kind: "wallpaper",
    image:
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.028) 0px, rgba(255,255,255,0.028) 2px, transparent 2px, transparent 6px)," +
      "repeating-linear-gradient(-45deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 2px, transparent 2px, transparent 6px)," +
      "radial-gradient(100% 80% at 50% 0%, rgba(148,163,184,0.10) 0%, rgba(148,163,184,0) 60%)," +
      "linear-gradient(180deg, #14161a 0%, #0b0c0f 100%)",
  },
  {
    id: "dawn_mist",
    name: "晨雾",
    kind: "wallpaper",
    image:
      "radial-gradient(100% 80% at 12% 8%, rgba(147,197,253,0.55) 0%, rgba(147,197,253,0) 62%)," +
      "radial-gradient(90% 70% at 88% 20%, rgba(199,210,254,0.50) 0%, rgba(199,210,254,0) 60%)," +
      "linear-gradient(160deg, #ffffff 0%, #f1f5fb 55%, #e6edf7 100%)",
  },
  {
    id: "linen",
    name: "亚麻",
    kind: "wallpaper",
    image:
      "repeating-linear-gradient(45deg, rgba(180,160,130,0.05) 0px, rgba(180,160,130,0.05) 1px, transparent 1px, transparent 4px)," +
      "radial-gradient(100% 80% at 20% 0%, rgba(251,191,36,0.10) 0%, rgba(251,191,36,0) 60%)," +
      "linear-gradient(170deg, #faf7f0 0%, #f3eee4 60%, #ece5d8 100%)",
  },

  // ---- 纯色背景（不叠加任何纹理，最省 GPU、最干净）----
  { id: "solid_slate", name: "石青", kind: "solid", image: "none", color: "#1f2937" },
  { id: "solid_navy", name: "藏青", kind: "solid", image: "none", color: "#111a2e" },
  { id: "solid_obsidian", name: "曜石", kind: "solid", image: "none", color: "#0b0d11" },
  { id: "solid_gunmetal", name: "枪灰", kind: "solid", image: "none", color: "#232a33" },
  { id: "solid_forest", name: "墨绿", kind: "solid", image: "none", color: "#11241b" },
  { id: "solid_plum", name: "梅紫", kind: "solid", image: "none", color: "#241a2b" },
  { id: "solid_mist", name: "雾灰", kind: "solid", image: "none", color: "#eceef1" },
  { id: "solid_cloud", name: "云白", kind: "solid", image: "none", color: "#f7f7f5" },
  { id: "solid_ivory", name: "米白", kind: "solid", image: "none", color: "#f6f4ee" },
  { id: "solid_mint", name: "薄荷", kind: "solid", image: "none", color: "#e6f2ec" },
  { id: "solid_azure", name: "雾蓝", kind: "solid", image: "none", color: "#e8eef6" },
  { id: "solid_apricot", name: "暖杏", kind: "solid", image: "none", color: "#f5efe6" },
  { id: "solid_rose", name: "浅樱", kind: "solid", image: "none", color: "#f6ecec" },
];

/** 网格 / 点阵类壁纸需要显式 tile 尺寸，其余铺满 */
export const WALLPAPER_SIZES: Record<string, string> = {
  graphite: "32px 32px, 32px 32px, cover, cover",
  carbon: "8px 8px, 8px 8px, cover, cover",
  dot_grid: "18px 18px, cover, cover",
  midnight_city: "18px 18px, 26px 26px, cover, cover",
  linen: "6px 6px, cover, cover",
};

/** 按类型分好组的预设，设置面板直接消费，避免每处重复过滤 */
export const WALLPAPER_PRESETS: WallpaperPreset[] = WALLPAPERS.filter((w) => w.kind === "wallpaper");
export const SOLID_PRESETS: WallpaperPreset[] = WALLPAPERS.filter((w) => w.kind === "solid");

export function getWallpaper(id: string): WallpaperPreset | undefined {
  return WALLPAPERS.find((w) => w.id === id);
}

/** 当前背景的展示名，用于设置面板「当前：xxx」文案 */
export function getBackgroundLabel(id: string): string {
  if (!id) return "无背景";
  if (id === "custom") return "自定义图片";
  return getWallpaper(id)?.name ?? "未知背景";
}

/**
 * 判断颜色是否偏亮，用于在色块上挑选可读的前景色。
 * 采用 BT.601 亮度加权，浅色返回 true。
 */
export function isLightColor(color?: string): boolean {
  const hex = (color || "").replace("#", "");
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return false;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}

/**
 * 把设置里的 backgroundId / 自定义图片统一解析成可直接铺到 DOM 的样式。
 * 返回 null 表示「不启用背景」。
 */
export function getWallpaperStyle(
  id: string,
  customDataUrl?: string | null
): WallpaperStyle | null {
  if (!id) return null;
  if (id === "custom") {
    return customDataUrl
      ? { backgroundImage: `url(${customDataUrl})`, backgroundSize: "cover" }
      : null;
  }
  const preset = getWallpaper(id);
  if (!preset) return null;
  if (preset.image === "none") {
    return { backgroundImage: "none", backgroundColor: preset.color };
  }
  return {
    backgroundImage: preset.image,
    backgroundSize: WALLPAPER_SIZES[preset.id] || "cover",
  };
}
