#!/usr/bin/env node
// build/assets/tools/rasterize-icons.mjs — zero-dependency icon rasterizer.
//
// Renders the tray icon SVGs (and the app icon) to PNG with no npm packages:
// Node built-ins only (node:zlib for DEFLATE; CRC32 implemented below).
//
// Rendering model (this is the byte-exact contract of the checked-in PNGs):
//   * 8x8 ordered point supersampling per output pixel (64 samples), sample
//     centers at (px + (i + 0.5) / 8) in output-pixel space.
//   * Geometry is evaluated in SVG user units scaled by (size / viewBox).
//   * Painter's algorithm: elements paint in document order; within an
//     element, fill paints first and stroke (centered on the outline) paints
//     over it. The topmost covering op wins per subpixel sample.
//   * Subpixel colors accumulate as straight-color averages; the output pixel
//     is (round(avgR), round(avgG), round(avgB), round(255 * n / 64)).
//   * PNG encoding: RGBA (color type 6, 8-bit), one filter-0 row per scanline,
//     a single IDAT, zlib DEFLATE level 9. No ancillary chunks.
//
// Because Node's zlib is the only compressor involved, re-running this script
// on the same SVGs reproduces the checked-in PNGs byte-for-byte (--check
// verifies exactly that). When an icon design intentionally changes:
//   1. edit the SVG (build/assets/icon.svg or src/renderer/assets/tray-*.svg),
//   2. run this script (no flags) to rewrite the tray PNGs and --icon for the
//      app icon,
//   3. re-copy the tray set to src/renderer/assets/ (dev mirror, kept
//      byte-identical by tests/tray-icons.test.mjs),
//   4. re-embed tray-stopped-16.png as FALLBACK_TRAY_ICON_PNG_BASE64 in
//      src/main/tray-icons.ts (the same test enforces that pairing).
//
// SVG subset supported (everything the checked-in sources use):
//   <path d="M x y L x y ... Z [M ... Z]" fill stroke stroke-width
//         stroke-linejoin fill-rule="evenodd">
//   <rect x y width height rx fill [stroke stroke-width]>
//   <circle cx cy r fill [stroke stroke-width]>
// Round line-joins fall out of the point-to-segment distance test.
//
// Usage:
//   node build/assets/tools/rasterize-icons.mjs            # write tray-*-{16,32}.png
//   node build/assets/tools/rasterize-icons.mjs --icon     # write icon.png (1024x1024)
//   node build/assets/tools/rasterize-icons.mjs --check    # byte-verify checked-in tray PNGs and icon.png (no writes)
//   node build/assets/tools/rasterize-icons.mjs --outdir <dir>   # render trays elsewhere (scratch)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SS = 8;                 // subpixels per axis
const SAMPLES = SS * SS;      // 64
const DEFLATE_LEVEL = 9;

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRAY_STATES = ['stopped', 'starting', 'running', 'error'];
const TRAY_SIZES = [16, 32];
const ICON_SOURCE = path.join(ASSETS_DIR, 'icon.svg');
const ICON_OUTPUT = path.join(ASSETS_DIR, 'icon.png');
const ICON_SIZE = 1024;

// ---------------------------------------------------------------------------
// Minimal SVG subset parser
// ---------------------------------------------------------------------------

function parseAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function parseColor(value) {
  if (value === undefined || value === 'none') return null;
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (!hex) throw new Error(`unsupported color: ${value}`);
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Supports absolute M / L / Z only (with any number of subpaths).
function parsePathData(d) {
  const tokens = d.match(/[MLZmlz]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const subpaths = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      subpaths.push({ points: [[parseFloat(tokens[i++]), parseFloat(tokens[i++])]], closed: false });
    } else if (cmd === 'L') {
      subpaths[subpaths.length - 1].points.push([parseFloat(tokens[i++]), parseFloat(tokens[i++])]);
    } else if (cmd === 'Z' || cmd === 'z') {
      subpaths[subpaths.length - 1].closed = true;
    } else {
      throw new Error(`unsupported path command: ${cmd}`);
    }
  }
  return subpaths;
}

function parseSvg(source) {
  const svgTag = source.match(/<svg\b[^>]*>/);
  if (!svgTag) throw new Error('missing <svg> root');
  const viewBox = parseAttributes(svgTag[0]).viewBox;
  const vb = viewBox ? viewBox.trim().split(/[\s,]+/).map(Number) : null;
  const elements = [];
  for (const match of source.matchAll(/<(path|rect|circle)\b[^>]*\/?>/g)) {
    const tag = match[0];
    const kind = match[1];
    const attrs = parseAttributes(tag);
    const stroke = parseColor(attrs.stroke);
    const strokeWidth = attrs['stroke-width'] !== undefined ? parseFloat(attrs['stroke-width']) : (stroke ? 1 : 0);
    if (kind === 'path') {
      elements.push({
        kind,
        subpaths: parsePathData(attrs.d),
        fill: attrs.fill === undefined ? [0, 0, 0] : parseColor(attrs.fill),
        fillRule: attrs['fill-rule'] ?? 'nonzero',
        stroke,
        strokeWidth: stroke ? strokeWidth : 0
      });
    } else if (kind === 'rect') {
      elements.push({
        kind,
        x: parseFloat(attrs.x ?? 0), y: parseFloat(attrs.y ?? 0),
        width: parseFloat(attrs.width), height: parseFloat(attrs.height),
        rx: parseFloat(attrs.rx ?? 0),
        fill: attrs.fill === undefined ? [0, 0, 0] : parseColor(attrs.fill),
        stroke, strokeWidth: stroke ? strokeWidth : 0
      });
    } else {
      elements.push({
        kind,
        cx: parseFloat(attrs.cx), cy: parseFloat(attrs.cy), r: parseFloat(attrs.r),
        fill: attrs.fill === undefined ? [0, 0, 0] : parseColor(attrs.fill),
        stroke, strokeWidth: stroke ? strokeWidth : 0
      });
    }
  }
  if (elements.length === 0) throw new Error('no drawable elements found');
  return { viewBox: vb ?? [0, 0, 24, 24], elements };
}

// ---------------------------------------------------------------------------
// Geometry tests (all in SVG user units)
// ---------------------------------------------------------------------------

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Even-odd ray cast; icon polygons are always closed for fill purposes.
function insidePolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > py) !== (yj > py) && px < xi + ((py - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

function pathFillCovers(el, px, py) {
  let hits = 0;
  for (const sub of el.subpaths) {
    if (insidePolygon(px, py, sub.points)) hits += 1;
  }
  if (hits === 0) return false;
  return el.fillRule === 'evenodd' ? hits % 2 === 1 : true;
}

function pathStrokeDistance(el, px, py) {
  let best = Infinity;
  for (const sub of el.subpaths) {
    const pts = sub.points;
    const n = pts.length;
    const segs = sub.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % n];
      const d = distanceToSegment(px, py, ax, ay, bx, by);
      if (d < best) best = d;
    }
  }
  return best;
}

// Signed distance to a rounded rect (negative inside).
function roundedRectSdf(el, px, py) {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const r = Math.min(el.rx, el.width / 2, el.height / 2);
  const qx = Math.abs(px - cx) - (el.width / 2 - r);
  const qy = Math.abs(py - cy) - (el.height / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function elementBounds(el) {
  const half = el.strokeWidth / 2;
  if (el.kind === 'path') {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const sub of el.subpaths) {
      for (const [x, y] of sub.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return [minX - half, minY - half, maxX + half, maxY + half];
  }
  if (el.kind === 'rect') return [el.x - half, el.y - half, el.x + el.width + half, el.y + el.height + half];
  return [el.cx - el.r - half, el.cy - el.r - half, el.cx + el.r + half, el.cy + el.r + half];
}

function topColorAt(elements, bounds, px, py) {
  let out = null;
  for (let e = 0; e < elements.length; e++) {
    const el = elements[e];
    const b = bounds[e];
    if (px < b[0] || py < b[1] || px > b[2] || py > b[3]) continue;
    if (el.kind === 'path') {
      if (el.fill && pathFillCovers(el, px, py)) out = el.fill;
      if (el.stroke && pathStrokeDistance(el, px, py) <= el.strokeWidth / 2) out = el.stroke;
    } else if (el.kind === 'rect') {
      const d = roundedRectSdf(el, px, py);
      if (el.fill && d <= 0) out = el.fill;
      if (el.stroke && Math.abs(d) <= el.strokeWidth / 2) out = el.stroke;
    } else {
      const d = Math.hypot(px - el.cx, py - el.cy) - el.r;
      if (el.fill && d <= 0) out = el.fill;
      if (el.stroke && Math.abs(d) <= el.strokeWidth / 2) out = el.stroke;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rasterizer + PNG encoder
// ---------------------------------------------------------------------------

function rasterize(svgSource, size) {
  const { viewBox, elements } = parseSvg(svgSource);
  const [, , vbWidth] = viewBox;
  const scale = size / vbWidth;
  const pxElements = elements.map((el) => {
    if (el.kind === 'path') {
      return {
        ...el,
        strokeWidth: el.strokeWidth * scale,
        subpaths: el.subpaths.map((sub) => ({
          closed: sub.closed,
          points: sub.points.map(([x, y]) => [x * scale, y * scale])
        }))
      };
    }
    if (el.kind === 'rect') {
      return { ...el, x: el.x * scale, y: el.y * scale, width: el.width * scale, height: el.height * scale, rx: el.rx * scale, strokeWidth: el.strokeWidth * scale };
    }
    return { ...el, cx: el.cx * scale, cy: el.cy * scale, r: el.r * scale, strokeWidth: el.strokeWidth * scale };
  });
  // pxBounds is derived from the already-scaled px-space elements so the
  // bounds and the rendered geometry stay consistent.
  const pxBounds = pxElements.map(elementBounds);

  const rgba = Buffer.alloc(size * size * 4);
  const norm = (SAMPLES === 0) ? 0 : 255 / SAMPLES;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        const py = y + (sy + 0.5) / SS;
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const c = topColorAt(pxElements, pxBounds, px, py);
          if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
        }
      }
      const o = (y * size + x) * 4;
      if (n > 0) {
        rgba[o] = Math.round(r / n);
        rgba[o + 1] = Math.round(g / n);
        rgba[o + 2] = Math.round(b / n);
        rgba[o + 3] = Math.round(norm * n);
      }
    }
  }
  return encodePng(rgba, size, size);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    // filter byte is already 0 (buffer zero-initialized)
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: DEFLATE_LEVEL });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function renderTrays() {
  const out = new Map();
  for (const state of TRAY_STATES) {
    const svgPath = path.join(ASSETS_DIR, `tray-${state}.svg`);
    const svg = fs.readFileSync(svgPath, 'utf8');
    for (const size of TRAY_SIZES) {
      out.set(`tray-${state}-${size}.png`, rasterize(svg, size));
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const rendered = renderTrays();
    let failures = 0;
    for (const [name, bytes] of rendered) {
      const file = path.join(ASSETS_DIR, name);
      const onDisk = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const identical = onDisk !== null && onDisk.equals(bytes);
      if (!identical) failures += 1;
      console.log(`${identical ? 'IDENTICAL' : 'DIFFERS  '} ${name}`);
    }
    // Beyond the tray set, also byte-verify the application icon against its
    // SVG source (same renderer, ICON_SIZE = 1024 output).
    const iconRendered = rasterize(fs.readFileSync(ICON_SOURCE, 'utf8'), ICON_SIZE);
    const iconOnDisk = fs.existsSync(ICON_OUTPUT) ? fs.readFileSync(ICON_OUTPUT) : null;
    const iconIdentical = iconOnDisk !== null && iconOnDisk.equals(iconRendered);
    if (!iconIdentical) failures += 1;
    console.log(`${iconIdentical ? 'IDENTICAL' : 'DIFFERS  '} ${path.basename(ICON_OUTPUT)}`);
    if (failures > 0) {
      console.error(`--check failed: ${failures} file(s) differ. Regenerate all sizes, refresh src/renderer/assets mirrors, and re-embed FALLBACK_TRAY_ICON_PNG_BASE64 together.`);
      process.exitCode = 1;
    } else {
      console.log('all checked-in tray PNGs match this rasterizer byte-for-byte');
      console.log('icon.png matches icon.svg byte-for-byte');
    }
    return;
  }
  const outdirIndex = args.indexOf('--outdir');
  if (outdirIndex !== -1) {
    const outdir = args[outdirIndex + 1];
    for (const [name, bytes] of renderTrays()) fs.writeFileSync(path.join(outdir, name), bytes);
    console.log(`rendered tray set to ${outdir}`);
    return;
  }
  if (args.includes('--icon')) {
    const started = Date.now();
    const png = rasterize(fs.readFileSync(ICON_SOURCE, 'utf8'), ICON_SIZE);
    fs.writeFileSync(ICON_OUTPUT, png);
    console.log(`wrote ${ICON_OUTPUT} (${png.length} bytes, ${ICON_SIZE}x${ICON_SIZE}) in ${Date.now() - started}ms`);
    return;
  }
  for (const [name, bytes] of renderTrays()) {
    const file = path.join(ASSETS_DIR, name);
    fs.writeFileSync(file, bytes);
    console.log(`wrote ${file} (${bytes.length} bytes)`);
  }
}

main();
