import * as fs from "node:fs";
import * as path from "node:path";

// Embedded last-resort tray icon: the approved 16x16 tray-stopped PNG
// (hollow gray hexagon #8A8A8A with #0A0E0B keyline per build/assets/ICONS.md),
// produced byte-identically by build/assets/tools/rasterize-icons.mjs and
// embedded here so the tray never shows an empty image when asset files are
// missing or unreadable. It is a PNG (not SVG) on purpose: Electron 31's
// nativeImage does NOT rasterize SVG at all (createFromDataURL/createFromBuffer
// of SVG bytes both yield an empty image), so an SVG fallback would be dead code.
export const FALLBACK_TRAY_ICON_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAyElEQVR42mNgwANkFGRDQJiBVCAiIWri7etzuK6u7j8Ig9ggMYIaufi4JaxsrecXFBb87+rq+l9RWQHGIDZIDCQHUoNNI4uOvm5FSmrKe5Dipqam/0EhwZeFRIVcQBjEBomB5EBqQGpBeuAGGBgZtLe1tf3v6Oj4Hxsf915DWyMDWQGIDRIDyYHUgNSC9MANsHWwmw8yPSg46DgXH7cAHi8KgNSA1IL0YBgQHhE+n1A4gdQMZwPIDkSKo5HihERxUqZaZiInOwMAaPrNFWphA7EAAAAASUVORK5CYII=";
export const FALLBACK_TRAY_ICON_DATA_URL = `data:image/png;base64,${FALLBACK_TRAY_ICON_PNG_BASE64}`;

// Minimal structural view of Electron's nativeImage API so the cache can be
// unit-tested without loading Electron. isEmpty() is mandatory: on Electron 31
// every creation path may return an empty image WITHOUT throwing (SVG input
// always; corrupt PNG input via createFromPath), and empty images must fall
// through to the next tier.
export interface TrayNativeImage {
  isEmpty(): boolean;
  addRepresentation(options: { scaleFactor: number; buffer: Buffer }): void;
}

export interface TrayNativeImageFactory {
  createFromPath(filePath: string): TrayNativeImage;
  createFromDataURL(dataURL: string): TrayNativeImage;
}

const TRAY_ICON_BASE_NAMES: Record<string, string> = {
  running: "tray-running",
  starting: "tray-starting",
  stopped: "tray-stopped",
  error: "tray-error"
};

// Maps a gateway lifecycle state (GatewayStatus.state) to its tray asset base
// name per build/assets/ICONS.md. Unknown/undefined states resolve to the
// neutral "stopped" icon.
export function trayIconForState(state: string | null | undefined): string {
  return (state && TRAY_ICON_BASE_NAMES[state]) || TRAY_ICON_BASE_NAMES.stopped;
}

export interface TrayIconCacheOptions {
  // Resolves the directory holding tray-*.svg / tray-*-16.png / tray-*-32.png.
  // Called lazily per load so packaged/dev resolution happens at first use.
  resolveAssetsDir: () => string;
  nativeImage: TrayNativeImageFactory;
  readFile?: (filePath: string) => Buffer;
  fileExists?: (filePath: string) => boolean;
}

// Creates a lazy per-state nativeImage cache. Tier order per state:
//   1. PNG rasters (authoritative on Electron 31): tray-<state>-16.png via
//      createFromPath plus tray-<state>-32.png as a 2x addRepresentation.
//   2. SVG dataURL (dead on Electron 31 — kept guarded for forward-compat with
//      nativeImage builds that do rasterize SVG).
//   3. Embedded FALLBACK_TRAY_ICON PNG constant.
// Every creation result is isEmpty()-guarded; empties fall through silently
// instead of rendering a blank tray slot.
export function createTrayIconCache(options: TrayIconCacheOptions): (state?: string | null) => TrayNativeImage {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath));
  const fileExists = options.fileExists ?? ((filePath: string) => fs.existsSync(filePath));
  const cache = new Map<string, TrayNativeImage>();

  return function trayIcon(state?: string | null): TrayNativeImage {
    const base = trayIconForState(state);
    const cached = cache.get(base);
    if (cached) return cached;
    const image = loadStateIcon(base);
    cache.set(base, image);
    return image;
  };

  function loadStateIcon(base: string): TrayNativeImage {
    const dir = options.resolveAssetsDir();
    return tryPngIcon(dir, base) ?? trySvgIcon(dir, base) ?? fallbackIcon();
  }

  function tryPngIcon(dir: string, base: string): TrayNativeImage | null {
    try {
      const png16 = path.join(dir, `${base}-16.png`);
      const png32 = path.join(dir, `${base}-32.png`);
      if (!fileExists(png16)) return null;
      const image = options.nativeImage.createFromPath(png16);
      if (image.isEmpty()) return null; // D2: corrupt PNG decodes empty without throwing
      if (fileExists(png32)) {
        try {
          image.addRepresentation({ scaleFactor: 2, buffer: readFile(png32) });
        } catch {
          // Corrupt HiDPI raster: the 16px base image remains usable.
        }
        if (image.isEmpty()) return null; // base image must still be usable after addRepresentation
      }
      return image;
    } catch {
      return null;
    }
  }

  function trySvgIcon(dir: string, base: string): TrayNativeImage | null {
    try {
      const svgPath = path.join(dir, `${base}.svg`);
      if (!fileExists(svgPath)) return null;
      const svg = readFile(svgPath);
      const image = options.nativeImage.createFromDataURL(`data:image/svg+xml;base64,${svg.toString("base64")}`);
      if (image.isEmpty()) return null; // D1: Electron 31 never rasterizes SVG
      return image;
    } catch {
      return null;
    }
  }

  function fallbackIcon(): TrayNativeImage {
    return options.nativeImage.createFromDataURL(FALLBACK_TRAY_ICON_DATA_URL);
  }
}
