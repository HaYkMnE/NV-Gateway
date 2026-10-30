import os from 'node:os';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const built = (name) => pathToFileURL(path.join(root, 'build', 'src', 'main', name)).href;
const sandboxRoot = os.tmpdir();
const temporaryDirectories = new Set();
const STATES = ['running', 'starting', 'stopped', 'error'];

test.after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(sandboxRoot, prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function fakeImage(empty, extra = {}) {
  return {
    empty,
    representations: [],
    isEmpty() { return this.empty; },
    addRepresentation(rep) { this.representations.push(rep); },
    ...extra
  };
}

// Simulates a nativeImage implementation; flags reproduce Electron 31 behavior:
// emptyFromPath    -> createFromPath decodes corrupt PNGs to an empty image (D2)
// emptySvgDataURL  -> SVG dataURLs never rasterize, always empty (D1)
function fakeNativeImage(calls, { emptyFromPath = false, emptySvgDataURL = false, emptyPngDataURL = false } = {}) {
  const created = { paths: [], dataUrls: [] };
  return {
    created,
    createFromPath: (filePath) => {
      calls.push({ kind: 'createFromPath', filePath });
      const image = fakeImage(emptyFromPath);
      created.paths.push(image);
      return image;
    },
    createFromDataURL: (dataURL) => {
      calls.push({ kind: 'createFromDataURL', dataURL });
      const isPng = dataURL.startsWith('data:image/png');
      const image = fakeImage(isPng ? emptyPngDataURL : emptySvgDataURL, { dataURL });
      created.dataUrls.push(image);
      return image;
    }
  };
}

function fixtureAssets(directory, base, { png = true, png32 = true, svg = true } = {}) {
  if (png) fs.writeFileSync(path.join(directory, `${base}-16.png`), `png16:${base}`);
  if (png && png32) fs.writeFileSync(path.join(directory, `${base}-32.png`), `png32:${base}`);
  if (svg) fs.writeFileSync(path.join(directory, `${base}.svg`), `<svg data-state="${base}"/>`);
}

test('trayIconForState maps each gateway lifecycle state to its tray asset per ICONS.md', async () => {
  const { trayIconForState } = await import(built('tray-icons.js'));
  assert.equal(trayIconForState('running'), 'tray-running');
  assert.equal(trayIconForState('starting'), 'tray-starting');
  assert.equal(trayIconForState('stopped'), 'tray-stopped');
  assert.equal(trayIconForState('error'), 'tray-error');
  assert.equal(trayIconForState('bogus'), 'tray-stopped', 'unknown states resolve to the neutral stopped icon');
  assert.equal(trayIconForState(undefined), 'tray-stopped');
  assert.equal(trayIconForState(null), 'tray-stopped');
  assert.equal(trayIconForState(''), 'tray-stopped');
});

test('tray icon cache prefers PNG representations with a 2x HiDPI buffer and caches per state', async () => {
  const { createTrayIconCache } = await import(built('tray-icons.js'));
  const directory = temporaryDirectory('nvgw-tray-icons-png-');
  for (const state of STATES) fixtureAssets(directory, `tray-${state}`);
  const calls = [];
  const loadCounts = new Map();
  const trayIcon = createTrayIconCache({
    resolveAssetsDir: () => directory,
    nativeImage: fakeNativeImage(calls),
    readFile: (filePath) => {
      loadCounts.set(filePath, (loadCounts.get(filePath) ?? 0) + 1);
      return fs.readFileSync(filePath);
    }
  });

  const running = trayIcon('running');
  assert.equal(calls.length, 1, 'one factory call per cold state');
  assert.equal(calls[0].kind, 'createFromPath');
  assert.equal(path.normalize(calls[0].filePath), path.join(directory, 'tray-running-16.png'));
  assert.equal(running.representations.length, 1, 'addRepresentation called once for the 32px HiDPI raster');
  assert.equal(running.representations[0].scaleFactor, 2);
  assert.equal(running.representations[0].buffer.toString(), 'png32:tray-running');

  assert.equal(trayIcon('running'), running, 'repeated access returns the cached nativeImage without re-reading files');
  const readsAfterWarm = new Map(loadCounts);
  trayIcon('running');
  assert.deepEqual(readsAfterWarm, loadCounts, 'cache hit performs zero file IO');

  const error = trayIcon('error');
  assert.notEqual(error, running, 'states are cached independently');
  assert.equal(calls.length, 2, 'a second cold state decodes exactly once');
  assert.equal(path.normalize(calls[1].filePath), path.join(directory, 'tray-error-16.png'));
  assert.equal(calls.filter(({ kind }) => kind === 'createFromDataURL').length, 0, 'SVG dataURL not used when PNG rasters exist');
});

test('tray icon cache lazily falls back from missing PNG to SVG dataURL, then to the embedded PNG constant', async () => {
  const { createTrayIconCache, FALLBACK_TRAY_ICON_DATA_URL } = await import(built('tray-icons.js'));
  const svgOnly = temporaryDirectory('nvgw-tray-icons-svg-');
  fixtureAssets(svgOnly, 'tray-stopped', { png: false, svg: true });
  fixtureAssets(svgOnly, 'tray-starting', { png: false, svg: true });
  const calls = [];
  const trayIcon = createTrayIconCache({ resolveAssetsDir: () => svgOnly, nativeImage: fakeNativeImage(calls) });

  const stopped = trayIcon('stopped');
  assert.equal(stopped.dataURL, `data:image/svg+xml;base64,${Buffer.from('<svg data-state="tray-stopped"/>').toString('base64')}`);

  const starting = trayIcon('starting');
  assert.equal(starting.dataURL.includes(Buffer.from('<svg data-state="tray-starting"/>').toString('base64')), true);
  assert.equal(calls.filter(({ kind }) => kind === 'createFromPath').length, 0, 'createFromPath not attempted when the 16px raster is absent');

  const missingDirectory = temporaryDirectory('nvgw-tray-icons-missing-');
  const fallbackCalls = [];
  const fallbackFake = fakeNativeImage(fallbackCalls);
  const missingTrayIcon = createTrayIconCache({ resolveAssetsDir: () => missingDirectory, nativeImage: fallbackFake });
  const fallback = missingTrayIcon('running');
  assert.equal(fallback.dataURL, FALLBACK_TRAY_ICON_DATA_URL, 'missing asset files resolve to the embedded PNG constant');
  assert.equal(fallback, fallbackFake.created.dataUrls.at(-1), 'the returned image IS the last-resort constant image');
  const errorFallback = missingTrayIcon('error');
  assert.equal(errorFallback.dataURL, FALLBACK_TRAY_ICON_DATA_URL, 'every file-missing state renders the same fallback artwork');
  assert.equal(missingTrayIcon('error'), errorFallback, 'fallback images are cached per state base name as well');
});

test('Electron 31 empty-image behavior falls through every tier to the embedded PNG constant', async () => {
  const { createTrayIconCache, FALLBACK_TRAY_ICON_DATA_URL } = await import(built('tray-icons.js'));
  const directory = temporaryDirectory('nvgw-tray-icons-empty-');
  fixtureAssets(directory, 'tray-running'); // files exist on disk; their decoded images are empty

  const calls = [];
  const fake = fakeNativeImage(calls, { emptyFromPath: true, emptySvgDataURL: true });
  const trayIcon = createTrayIconCache({ resolveAssetsDir: () => directory, nativeImage: fake });
  const image = trayIcon('running');

  assert.deepEqual(calls.map(({ kind }) => kind), ['createFromPath', 'createFromDataURL', 'createFromDataURL'],
    'empty PNG tier -> empty SVG tier -> embedded constant');
  assert.equal(calls[1].dataURL.startsWith('data:image/svg+xml;base64,'), true, 'guarded SVG tier still attempted for forward-compat');
  assert.equal(calls[2].dataURL, FALLBACK_TRAY_ICON_DATA_URL);
  assert.equal(image.empty, false, 'final tray image is never the empty one');
  assert.equal(image, fake.created.dataUrls.at(-1), 'returned image is the constant instance');
  assert.equal(trayIcon('running'), image, 'the fall-through result is cached like any other state');
});

test('a corrupt PNG from createFromPath is rejected and falls through; a corrupt 32px raster keeps the 16px base', async () => {
  const { createTrayIconCache, FALLBACK_TRAY_ICON_DATA_URL } = await import(built('tray-icons.js'));

  const corruptAll = temporaryDirectory('nvgw-tray-icons-corrupt-');
  fixtureAssets(corruptAll, 'tray-error', { png: true, svg: false });
  const corruptCalls = [];
  const corruptTrayIcon = createTrayIconCache({ resolveAssetsDir: () => corruptAll, nativeImage: fakeNativeImage(corruptCalls, { emptyFromPath: true }) });
  const recovered = corruptTrayIcon('error');
  assert.equal(recovered.dataURL, FALLBACK_TRAY_ICON_DATA_URL, 'corrupt 16px PNG with no SVG lands on the embedded constant');
  assert.deepEqual(corruptCalls.map(({ kind }) => kind), ['createFromPath', 'createFromDataURL'], 'empty createFromPath result skips the SVG tier when no SVG exists');

  const corruptHighDpi = temporaryDirectory('nvgw-tray-icons-hidpi-');
  fixtureAssets(corruptHighDpi, 'tray-starting');
  const hiDpiCalls = [];
  const hiDpiTrayIcon = createTrayIconCache({
    resolveAssetsDir: () => corruptHighDpi,
    nativeImage: fakeNativeImage(hiDpiCalls),
    readFile: (filePath) => {
      if (filePath.endsWith('-32.png')) throw new Error('EIO');
      return fs.readFileSync(filePath);
    }
  });
  const base = hiDpiTrayIcon('starting');
  assert.equal(base.empty, false, 'a valid 16px decode survives a corrupt 32px representation');
  assert.equal(base.representations.length, 0, 'corrupt HiDPI buffer is not applied');
  assert.equal(hiDpiCalls.filter(({ kind }) => kind === 'createFromDataURL').length, 0, 'no tier change needed when the base image stays usable');
});

test('embedded fallback constant is a valid non-trivial 16x16 RGBA PNG matching the rasterizer output', async () => {
  const { FALLBACK_TRAY_ICON_PNG_BASE64, FALLBACK_TRAY_ICON_DATA_URL } = await import(built('tray-icons.js'));
  assert.equal(FALLBACK_TRAY_ICON_DATA_URL, `data:image/png;base64,${FALLBACK_TRAY_ICON_PNG_BASE64}`);
  const bytes = Buffer.from(FALLBACK_TRAY_ICON_PNG_BASE64, 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(bytes.readUInt32BE(8), 13, 'IHDR chunk length');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 16, 'width 16');
  assert.equal(bytes.readUInt32BE(20), 16, 'height 16');
  assert.equal(bytes[24], 8, '8-bit channels');
  assert.equal(bytes[25], 6, 'RGBA color type');
  assert.equal(bytes.length >= 200 && bytes.length <= 2048, true, `embedded size ${bytes.length} bytes stays small but non-trivial`);
  const canonical = fs.readFileSync(path.join(root, 'build', 'assets', 'tray-stopped-16.png'));
  assert.deepEqual(bytes, canonical, 'embedded fallback is the approved zero-dep rasterizer output (regenerate + re-embed together)');
});

test('dev tray asset copies stay byte-identical to the canonical build/assets versions', () => {
  const canonical = path.join(root, 'build', 'assets');
  const devCopies = path.join(root, 'src', 'renderer', 'assets');
  for (const state of STATES) {
    for (const name of [`tray-${state}.svg`, `tray-${state}-16.png`, `tray-${state}-32.png`]) {
      const source = fs.readFileSync(path.join(canonical, name));
      const copy = fs.readFileSync(path.join(devCopies, name));
      assert.deepEqual(copy, source, `dev copy drifted for ${name}`);
    }
  }
});

test('electron-builder wiring ships the full tray icon family and the app icon', () => {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(builder, /^win:\r?\n  icon: build\/assets\/icon\.png$/m, 'win.icon points at the real 1024x1024 PNG');
  assert.match(builder, /- from: build\/assets\r?\n    to: assets/, 'extraResources ships the icon asset directory');
  for (const pattern of ['icon.png', 'tray-\\*\\.svg', 'tray-\\*-16\\.png', 'tray-\\*-32\\.png']) {
    assert.match(builder, new RegExp(`^\\s+- ${pattern}$`, 'm'), `extraResources filter includes ${pattern}`);
  }
  for (const state of STATES) {
    for (const name of [`tray-${state}.svg`, `tray-${state}-16.png`, `tray-${state}-32.png`]) {
      assert.equal(fs.existsSync(path.join(root, 'build', 'assets', name)), true, `packaged tray payload includes ${name}`);
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'build', 'assets', 'icon.png')), true, 'app icon is present for electron-builder');
});
