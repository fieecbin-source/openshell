/**
 * 内置终端壁纸。
 *
 * 全部使用本地纯 CSS 渐变绘制，不依赖网络、不占安装体积，也不会因为
 * 分辨率不同而模糊。配色刻意控制在低对比度暗色区间，叠加终端背景遮罩后
 * 不会影响代码阅读。
 */

export interface WallpaperPreset {
  id: string;
  name: string;
  /** 直接用于 style.backgroundImage */
  image: string;
}

export const WALLPAPERS: WallpaperPreset[] = [
  {
    id: "aurora",
    name: "极光",
    image:
      "radial-gradient(120% 90% at 12% 8%, rgba(16,185,129,0.45) 0%, rgba(16,185,129,0) 55%)," +
      "radial-gradient(110% 80% at 88% 12%, rgba(59,130,246,0.42) 0%, rgba(59,130,246,0) 60%)," +
      "radial-gradient(140% 120% at 50% 110%, rgba(139,92,246,0.35) 0%, rgba(139,92,246,0) 65%)," +
      "linear-gradient(160deg, #0b1220 0%, #0d1117 55%, #090c12 100%)",
  },
  {
    id: "deep_ocean",
    name: "深海",
    image:
      "radial-gradient(100% 80% at 20% 100%, rgba(6,182,212,0.35) 0%, rgba(6,182,212,0) 60%)," +
      "radial-gradient(90% 70% at 85% 20%, rgba(37,99,235,0.30) 0%, rgba(37,99,235,0) 62%)," +
      "linear-gradient(180deg, #06121c 0%, #04101a 60%, #02080f 100%)",
  },
  {
    id: "graphite",
    name: "石墨网格",
    image:
      "linear-gradient(rgba(148,163,184,0.055) 1px, transparent 1px)," +
      "linear-gradient(90deg, rgba(148,163,184,0.055) 1px, transparent 1px)," +
      "radial-gradient(120% 90% at 50% 0%, rgba(148,163,184,0.12) 0%, rgba(148,163,184,0) 60%)," +
      "linear-gradient(180deg, #111318 0%, #0c0e12 100%)",
    // 网格尺寸由 XtermView 的 backgroundSize 决定
  },
  {
    id: "mountain_dusk",
    name: "暮色群山",
    image:
      "linear-gradient(180deg, rgba(251,146,60,0.22) 0%, rgba(244,63,94,0.10) 28%, rgba(30,41,59,0) 55%)," +
      "linear-gradient(180deg, rgba(15,23,42,0) 45%, rgba(2,6,23,0.75) 100%)," +
      "linear-gradient(160deg, #1b2233 0%, #131a28 50%, #0a0f18 100%)",
  },
  {
    id: "forest",
    name: "森林雾霭",
    image:
      "radial-gradient(110% 85% at 25% 20%, rgba(34,197,94,0.24) 0%, rgba(34,197,94,0) 58%)," +
      "radial-gradient(100% 90% at 80% 75%, rgba(20,184,166,0.20) 0%, rgba(20,184,166,0) 62%)," +
      "linear-gradient(170deg, #0e1a14 0%, #0b1410 55%, #070d0a 100%)",
  },
  {
    id: "midnight_city",
    name: "午夜城景",
    image:
      "repeating-linear-gradient(90deg, rgba(96,165,250,0.06) 0px, rgba(96,165,250,0.06) 2px, transparent 2px, transparent 18px)," +
      "repeating-linear-gradient(0deg, rgba(96,165,250,0.035) 0px, rgba(96,165,250,0.035) 2px, transparent 2px, transparent 26px)," +
      "radial-gradient(90% 70% at 70% 10%, rgba(129,140,248,0.22) 0%, rgba(129,140,248,0) 62%)," +
      "linear-gradient(180deg, #0b1020 0%, #070a14 100%)",
  },
  {
    id: "sakura",
    name: "夜樱",
    image:
      "radial-gradient(85% 70% at 18% 12%, rgba(244,114,182,0.22) 0%, rgba(244,114,182,0) 58%)," +
      "radial-gradient(90% 75% at 82% 30%, rgba(167,139,250,0.20) 0%, rgba(167,139,250,0) 60%)," +
      "linear-gradient(170deg, #191325 0%, #120e1c 55%, #0a0812 100%)",
  },
  {
    id: "sand_dune",
    name: "沙丘",
    image:
      "radial-gradient(120% 95% at 15% 100%, rgba(234,179,8,0.14) 0%, rgba(234,179,8,0) 58%)," +
      "radial-gradient(110% 90% at 85% 0%, rgba(217,119,6,0.12) 0%, rgba(217,119,6,0) 60%)," +
      "linear-gradient(175deg, #1a1712 0%, #14110d 55%, #0c0a08 100%)",
  },
  {
    id: "carbon",
    name: "碳纤维",
    image:
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.028) 0px, rgba(255,255,255,0.028) 2px, transparent 2px, transparent 6px)," +
      "repeating-linear-gradient(-45deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 2px, transparent 2px, transparent 6px)," +
      "radial-gradient(100% 80% at 50% 0%, rgba(148,163,184,0.10) 0%, rgba(148,163,184,0) 60%)," +
      "linear-gradient(180deg, #14161a 0%, #0b0c0f 100%)",
  },
];

/** 网格类壁纸需要显式 tile 尺寸，其余铺满 */
export const WALLPAPER_SIZES: Record<string, string> = {
  graphite: "32px 32px, 32px 32px, cover, cover",
  carbon: "8px 8px, 8px 8px, cover, cover",
};

export function getWallpaper(id: string): WallpaperPreset | undefined {
  return WALLPAPERS.find((w) => w.id === id);
}
