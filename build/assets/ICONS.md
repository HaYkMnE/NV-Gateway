# Icon Assets (canonical)

`build/assets/` is the **canonical, committed source of truth** for all raster/SVG
icon payloads. It is shipped as-is via `extraResources` (see `electron-builder.yml`)
and `win.icon` points at `icon.png`.

A byte-identical dev mirror lives at `src/renderer/assets/` (used by the Vite dev
server). `tests/tray-icons.test.mjs` enforces the mirror never drifts from this
canonical copy — always change BOTH via the workflow below.

## Naming

Tray icons: one SVG source + two PNG rasters per gateway lifecycle state:

| state     | svg                | png rasters                          |
| --------- | ------------------ | ------------------------------------ |
| stopped   | `tray-stopped.svg` | `tray-stopped-16.png`, `tray-stopped-32.png` |
| starting  | `tray-starting.svg`| `tray-starting-16.png`, `tray-starting-32.png` |
| running   | `tray-running.svg` | `tray-running-16.png`, `tray-running-32.png` |
| error     | `tray-error.svg`   | `tray-error-16.png`, `tray-error-32.png` |

`-16.png` is the 16x16 base raster (`nativeImage.createFromPath`), `-32.png` the
2x HiDPI representation. The SVGs are kept for the guarded forward-compat dataURL
tier and as the render source.

App icon: `icon.png` (1024x1024 RGBA PNG), generated from `icon.svg`.

## Design

Geometry: pointy-top hexagon `M12 2.5 L20.23 7.25 L20.23 16.75 L12 21.5 L3.77 16.75 L3.77 7.25 Z`
on a 24x24 viewBox.

| state    | artwork |
| -------- | ------- |
| stopped  | hollow hexagon outline: `#8A8A8A` stroke (2.4) over a wider `#0A0E0B` keyline (3.4) so the silhouette survives light taskbars |
| starting | same outline in amber `#FFB020` plus solid amber core hexagon (`M12 8 ...` ring-filling) |
| running  | solid NVIDIA-green `#76B900` hexagon donut (even-odd hole), thin `#0A0E0B` keyline (1.2) |
| error    | solid `#E5484D` hexagon with bold `#0A0E0B` "!" glyph, thin `#0A0E0B` keyline (1.2) |

Shared keyline color: `#0A0E0B`. App icon: dark chassis square (`#0D110E`, rounded
r=96, `#1A221C` frame) with a hollow `#76B900` hexagon ring (keyline 85 / ring 60)
and solid `#76B900` core — the alive variant of the tray mark.

## Regeneration

Zero external dependencies: `tools/rasterize-icons.mjs` (this directory) rasterizes
with Node built-ins only — 8x8 ordered point supersampling, painter's-algorithm
compositing, PNG encoding via `node:zlib` DEFLATE level 9, filter-0 scanlines,
single IDAT, RGBA color type 6.

```bash
node build/assets/tools/rasterize-icons.mjs          # rewrite tray-*-{16,32}.png from the SVGs
node build/assets/tools/rasterize-icons.mjs --icon   # rewrite icon.png from icon.svg (1024x1024)
node build/assets/tools/rasterize-icons.mjs --check  # byte-verify checked-in tray PNGs (exit 1 on drift)
```

Re-running the rasterizer on the committed SVGs reproduces the committed tray PNGs
**byte-for-byte** (`--check` proves it; PNG bytes are stable for a given Node/zlib
version).

When artwork intentionally changes, do ALL of these in one commit:

1. regenerate the PNGs with the commands above,
2. copy the tray set to `src/renderer/assets/` (dev mirror; the drift test fails
   on any byte difference),
3. re-embed `tray-stopped-16.png` as `FALLBACK_TRAY_ICON_PNG_BASE64` in
   `src/main/tray-icons.ts` (the embedded last-resort tray icon must equal the
   canonical `tray-stopped-16.png`; the test enforces "regenerate + re-embed
   together").
