/**
 * 终端壁纸与风景背景库
 *
 * 包含：
 * 1. 精选 4K/高清电脑桌面风景壁纸（雪山、极光、暮色、迷雾森林、星河、湖泊、日落等）；
 * 2. 质感艺术纹理/渐变备用壁纸；
 * 3. 用户自定壁纸库管理（支持网络图片 URL 与本地图片上传，数据持久化存储）。
 */

export interface ScenicWallpaper {
  id: string;
  name: string;
  category: "山川湖泊" | "极光星空" | "森林秘境" | "日落霞光" | "城市天际" | "旷野大地";
  /** 高清原图 URL (1920x1080 优化) */
  image: string;
  /** 轻量预览缩略图 URL (480px 宽) */
  thumbnail: string;
}

export interface CustomWallpaperItem {
  id: string;
  name: string;
  url: string;
  addedAt: number;
}

export interface WallpaperPreset {
  id: string;
  name: string;
  kind: "scenic" | "wallpaper" | "solid";
  image: string;
  color?: string;
  thumbnail?: string;
}

export interface WallpaperStyle {
  backgroundImage: string;
  backgroundColor?: string;
  backgroundSize?: string;
}

/** 16 套精选高清电脑自然风光壁纸 */
export const SCENIC_WALLPAPERS: ScenicWallpaper[] = [
  {
    id: "scenic_yosemite",
    name: "优胜美地幽谷",
    category: "山川湖泊",
    image: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_aurora",
    name: "北欧翡翠极光",
    category: "极光星空",
    image: "https://images.unsplash.com/photo-1517411032315-54ef2cb783bb?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1517411032315-54ef2cb783bb?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_twilight_alps",
    name: "暮色晚霞群山",
    category: "日落霞光",
    image: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_misty_forest",
    name: "晨曦迷雾杉林",
    category: "森林秘境",
    image: "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_milky_way",
    name: "深邃星河银河",
    category: "极光星空",
    image: "https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_norway_fjord",
    name: "挪威峡湾静湖",
    category: "山川湖泊",
    image: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_fuji_sakura",
    name: "富士夕照夜樱",
    category: "日落霞光",
    image: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_sahara_dunes",
    name: "撒哈拉金色沙丘",
    category: "旷野大地",
    image: "https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_tokyo_cyberpunk",
    name: "赛博霓虹夜都",
    category: "城市天际",
    image: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_ocean_waves",
    name: "碧蓝微风海岸",
    category: "山川湖泊",
    image: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_swiss_glacier",
    name: "瑞士雪岭险峰",
    category: "山川湖泊",
    image: "https://images.unsplash.com/photo-1486870591958-9b9d0d1dda99?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1486870591958-9b9d0d1dda99?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_autumn_lake",
    name: "湖畔秋色枫影",
    category: "森林秘境",
    image: "https://images.unsplash.com/photo-1507725914440-e1e434774828?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1507725914440-e1e434774828?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_shinjuku_neon",
    name: "新宿午夜流光",
    category: "城市天际",
    image: "https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_alpine_lake",
    name: "阿尔卑斯倒影静湖",
    category: "山川湖泊",
    image: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_sunrise_cloud",
    name: "雪山之巅晨光云海",
    category: "日落霞光",
    image: "https://images.unsplash.com/photo-1454496522488-7a8e488e8606?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1454496522488-7a8e488e8606?auto=format&fit=crop&w=480&q=70",
  },
  {
    id: "scenic_wilderness_stars",
    name: "荒野星河夜话",
    category: "极光星空",
    image: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1920&q=80",
    thumbnail: "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=480&q=70",
  },
];

/** 质感艺术纹理备用预设 */
export const ARTISTIC_WALLPAPERS: WallpaperPreset[] = [
  {
    id: "aurora_gradient",
    name: "幻境极光",
    kind: "wallpaper",
    image:
      "radial-gradient(120% 90% at 12% 8%, rgba(16,185,129,0.45) 0%, rgba(16,185,129,0) 55%)," +
      "radial-gradient(110% 80% at 88% 12%, rgba(59,130,246,0.42) 0%, rgba(59,130,246,0) 60%)," +
      "radial-gradient(140% 120% at 50% 110%, rgba(139,92,246,0.35) 0%, rgba(139,92,246,0) 65%)," +
      "linear-gradient(160deg, #0b1220 0%, #0d1117 55%, #090c12 100%)",
  },
  {
    id: "deep_ocean_gradient",
    name: "深海幽光",
    kind: "wallpaper",
    image:
      "radial-gradient(100% 80% at 20% 100%, rgba(6,182,212,0.35) 0%, rgba(6,182,212,0) 60%)," +
      "radial-gradient(90% 70% at 85% 20%, rgba(37,99,235,0.30) 0%, rgba(37,99,235,0) 62%)," +
      "linear-gradient(180deg, #06121c 0%, #04101a 60%, #02080f 100%)",
  },
  {
    id: "carbon_grid",
    name: "石墨暗夜",
    kind: "wallpaper",
    image:
      "repeating-linear-gradient(45deg, rgba(255,255,255,0.028) 0px, rgba(255,255,255,0.028) 2px, transparent 2px, transparent 6px)," +
      "radial-gradient(100% 80% at 50% 0%, rgba(148,163,184,0.10) 0%, rgba(148,163,184,0) 60%)," +
      "linear-gradient(180deg, #14161a 0%, #0b0c0f 100%)",
  },
  {
    id: "sakura_gradient",
    name: "暮春夜樱",
    kind: "wallpaper",
    image:
      "radial-gradient(85% 70% at 18% 12%, rgba(244,114,182,0.22) 0%, rgba(244,114,182,0) 58%)," +
      "radial-gradient(90% 75% at 82% 30%, rgba(167,139,250,0.20) 0%, rgba(167,139,250,0) 60%)," +
      "linear-gradient(170deg, #191325 0%, #120e1c 55%, #0a0812 100%)",
  },
];

const CUSTOM_WALLPAPERS_STORAGE_KEY = "openshell_custom_wallpapers_v1";

/** 读取用户自定义壁纸列表 */
export function getStoredCustomWallpapers(): CustomWallpaperItem[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = localStorage.getItem(CUSTOM_WALLPAPERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 保存用户添加的自定义壁纸 */
export function addStoredCustomWallpaper(name: string, url: string): CustomWallpaperItem {
  const list = getStoredCustomWallpapers();
  const newItem: CustomWallpaperItem = {
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || `自定壁纸 ${list.length + 1}`,
    url,
    addedAt: Date.now(),
  };
  const updated = [newItem, ...list.slice(0, 49)];
  try {
    localStorage.setItem(CUSTOM_WALLPAPERS_STORAGE_KEY, JSON.stringify(updated));
  } catch (err) {
    console.warn("failed to save custom wallpaper to localStorage", err);
  }
  return newItem;
}

/** 删除某条用户自定壁纸 */
export function removeStoredCustomWallpaper(id: string): void {
  const list = getStoredCustomWallpapers();
  const filtered = list.filter((item) => item.id !== id);
  try {
    localStorage.setItem(CUSTOM_WALLPAPERS_STORAGE_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.warn("failed to remove custom wallpaper from localStorage", err);
  }
}

/** 兼容旧版 WALLPAPERS 导出，避免其它可能未改动的文件报类型错误 */
export const WALLPAPERS: WallpaperPreset[] = [
  ...SCENIC_WALLPAPERS.map((s) => ({
    id: s.id,
    name: s.name,
    kind: "scenic" as const,
    image: `url("${s.image}")`,
    thumbnail: s.thumbnail,
  })),
  ...ARTISTIC_WALLPAPERS,
];

export const WALLPAPER_PRESETS = WALLPAPERS;
export const SOLID_PRESETS: WallpaperPreset[] = [];
export const WALLPAPER_SIZES: Record<string, string> = {};

export function getWallpaper(id: string): WallpaperPreset | undefined {
  return WALLPAPERS.find((w) => w.id === id);
}

/** 获取背景壁纸显示名称 */
export function getBackgroundLabel(id: string): string {
  if (!id) return "默认主题底色";
  if (id === "custom") return "自定本地图片";
  if (id.startsWith("http://") || id.startsWith("https://")) return "自定网络图片";

  const scenic = SCENIC_WALLPAPERS.find((s) => s.id === id);
  if (scenic) return scenic.name;

  const custom = getStoredCustomWallpapers().find((c) => c.id === id);
  if (custom) return custom.name;

  const art = ARTISTIC_WALLPAPERS.find((a) => a.id === id);
  if (art) return art.name;

  return "已设壁纸";
}

/**
 * 将 backgroundId 或自定义图片解析为终端画布背景样式
 */
export function getWallpaperStyle(
  id: string,
  customDataUrl?: string | null
): WallpaperStyle | null {
  if (!id) return null;

  // 1. 直接是 HTTP/HTTPS 图片链接
  if (id.startsWith("http://") || id.startsWith("https://")) {
    return {
      backgroundImage: `url("${id}")`,
      backgroundSize: "cover",
    };
  }

  // 2. 自定义本地图片
  if (id === "custom") {
    return customDataUrl
      ? { backgroundImage: `url("${customDataUrl}")`, backgroundSize: "cover" }
      : null;
  }

  // 3. 自然风景预设
  const scenic = SCENIC_WALLPAPERS.find((s) => s.id === id);
  if (scenic) {
    return {
      backgroundImage: `url("${scenic.image}")`,
      backgroundSize: "cover",
    };
  }

  // 4. 用户自定壁纸库
  const customItem = getStoredCustomWallpapers().find((c) => c.id === id);
  if (customItem) {
    return {
      backgroundImage: `url("${customItem.url}")`,
      backgroundSize: "cover",
    };
  }

  // 5. 艺术纹理渐变预设
  const art = ARTISTIC_WALLPAPERS.find((a) => a.id === id);
  if (art) {
    return {
      backgroundImage: art.image,
      backgroundSize: "cover",
    };
  }

  return null;
}
