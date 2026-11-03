import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheScenicWallpaper, getCachedScenicWallpaper, SCENIC_WALLPAPERS } from "./wallpapers";

const cache = {
  match: vi.fn(),
  put: vi.fn(),
};

describe("scenic wallpaper cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.match.mockResolvedValue(null);
    cache.put.mockResolvedValue(undefined);
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("loads a previously cached image as a local object URL", async () => {
    const wallpaper = SCENIC_WALLPAPERS.find((item) => item.id === "scenic_aurora")!;
    cache.match.mockResolvedValue(new Response("image"));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn().mockReturnValue("blob:cached-wallpaper"),
    });

    await expect(getCachedScenicWallpaper(wallpaper.id)).resolves.toBe("blob:cached-wallpaper");
    expect(cache.match).toHaveBeenCalledWith(wallpaper.image);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("downloads a selected image into persistent cache", async () => {
    const wallpaper = SCENIC_WALLPAPERS.find((item) => item.id === "scenic_yosemite")!;

    cacheScenicWallpaper(wallpaper.id);
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledWith(wallpaper.image, { ok: true }));
    expect(fetch).toHaveBeenCalledWith(wallpaper.image);
  });
});
