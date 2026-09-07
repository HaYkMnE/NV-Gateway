import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const configFile = path.join(root, 'vite.config.ts');

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: `npm run dev` renders a COMPLETELY UNSTYLED app — zero Tailwind, zero
// pet-widget CSS — while packaged builds look correct.
//
// MEASURED SYMPTOM (live dev window, and reproduced by this test at the module
// layer): the console carries, once per imported stylesheet,
//   Refused to apply inline style because it violates the following
//   Content-Security-Policy directive: "style-src 'self'". Either the
//   'unsafe-inline' keyword, a hash, or a nonce is required to enable inline
//   execution.
// and document.styleSheets stays empty.
//
// ROOT CAUSE. In dev, Vite serves every JS-imported stylesheet as a JS module
// that ends in `__vite__updateStyle(__vite__id, __vite__css)`. That helper
// (node_modules/vite/dist/client/client.mjs:786-795) does
// `document.createElement("style")` + `style.textContent = content` — an INLINE
// style. Two independent CSPs govern the dev document and both must allow it:
//   1. the <meta http-equiv="Content-Security-Policy"> in src/renderer/index.html
//   2. PRODUCTION_CSP (src/main/electron-security.ts:1), attached as a response
//      header to every session response by installSecurityHeaders()
//      (src/main/index.ts:553) — including the http://localhost:5173 document
// Both say `style-src 'self'`, so Chromium refuses the <style>. Vite's own
// escape hatch (client.mjs:784: `document.querySelector("meta[property=csp-nonce]")`)
// is inert here because no such meta tag exists. Packaged users are unaffected:
// `vite build` emits a real external <link rel="stylesheet">, which
// `style-src 'self'` allows — that is why only dev is blacked out.
//
// REQUIRED BEHAVIOUR. Dev must render styled WITHOUT relaxing either CSP: no
// 'unsafe-inline', no hash, and not even a nonce (a nonce would have to be
// injected into the shared meta CSP *and* into the header CSP produced by the
// production security module, i.e. it would edit the production policy path).
// The fix is not to permit inline style; it is to STOP EMITTING one. An external
// same-origin stylesheet is already allowed by `style-src 'self'` under both
// policies — that is exactly how the packaged app applies CSS — so in dev the
// stylesheet must be applied through a <link rel="stylesheet"> pointing at the
// dev server's own CSS URL instead of an inline <style>. Same shape as the
// script-src precedent in tests/dev-server-csp-preamble.test.mjs.
// ───────────────────────────────────────────────────────────────────────────

/** The one CSP text this app is allowed to have. Dev must not get a looser one. */
const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
  + "form-action 'none'";

function metaCsp(html) {
  const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  return match ? match[1] : null;
}

/** Every source file under src/renderer, so CSS discovery cannot go stale. */
function rendererSources(directory = path.join(root, 'src/renderer')) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return rendererSources(entryPath);
    return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

/**
 * Dev-server URLs of every stylesheet the renderer imports from JS, derived from
 * the source rather than hardcoded: a stylesheet added later is covered too.
 * Vite's root is src/renderer, so /index.css is src/renderer/index.css.
 */
function importedStylesheetUrls() {
  const viteRoot = path.join(root, 'src/renderer');
  const urls = new Set();
  for (const file of rendererSources()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s+['"](\.[^'"]+\.css)['"]/g)) {
      const resolved = path.resolve(path.dirname(file), match[1]);
      urls.add(`/${path.relative(viteRoot, resolved).split(path.sep).join('/')}`);
    }
  }
  return [...urls].sort();
}

/** The import specifier a module pulls `updateStyle` from, if any. */
function updateStyleSource(code) {
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (/\bupdateStyle\b/.test(match[1])) return match[2];
  }
  return null;
}

test('the renderer CSP and the production CSP stay byte-identical, with no inline-style escape hatch', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const security = fs.readFileSync(path.join(root, 'src/main/electron-security.ts'), 'utf8');
  const productionCsp = /PRODUCTION_CSP\s*=\s*"([^"]+)"/.exec(security)?.[1] ?? null;

  assert.equal(metaCsp(html), EXPECTED_CSP, 'the renderer meta CSP must stay exactly as strict');
  assert.equal(productionCsp, EXPECTED_CSP, 'PRODUCTION_CSP must stay byte-identical to the renderer CSP');
  for (const [label, csp] of [['meta', metaCsp(html)], ['PRODUCTION_CSP', productionCsp]]) {
    assert.equal(/unsafe-inline/.test(csp), false, `${label} must never gain 'unsafe-inline'`);
    assert.equal(/unsafe-hashes/.test(csp), false, `${label} must never gain 'unsafe-hashes'`);
    assert.equal(/nonce-/.test(csp), false, `${label} must not be bought with a nonce`);
    assert.equal(/sha256-/.test(csp), false, `${label} must not be bought with a style hash`);
  }
});

test('every stylesheet the renderer imports is applied in dev as an external same-origin <link>', async () => {
  const { createServer } = require('vite');
  const server = await createServer({
    configFile,
    // Own port/host so a developer's running dev server is untouched; the URL is
    // read back from Vite rather than assumed.
    server: { port: 5197, strictPort: false, host: '127.0.0.1' },
    logLevel: 'silent'
  });
  try {
    await server.listen();
    const base = server.resolvedUrls.local[0].replace(/\/$/, '');

    const stylesheets = importedStylesheetUrls();
    assert.ok(stylesheets.length >= 1, 'the renderer must import at least one stylesheet for this to mean anything');

    for (const url of stylesheets) {
      const moduleResponse = await fetch(base + url);
      assert.equal(moduleResponse.status, 200, `${url} must be served by the dev server`);
      const moduleCode = await moduleResponse.text();

      // The blocked path, verbatim: Vite's client updateStyle() creates a <style>
      // element and assigns textContent, which `style-src 'self'` refuses.
      const applierUrl = updateStyleSource(moduleCode);
      assert.ok(applierUrl, `${url} must still route its CSS through an updateStyle applier`);
      assert.notEqual(applierUrl, '/@vite/client',
        `${url} must not apply its CSS through Vite's client updateStyle(): that helper does `
        + 'document.createElement("style") + textContent, which Chromium refuses under '
        + "style-src 'self' — the whole dev window ends up unstyled. It must be applied as an "
        + 'external same-origin <link rel="stylesheet"> instead, exactly as the packaged build does.');

      // Follow the one hop to whatever applier the dev graph substituted, and
      // require that it really is a stylesheet <link>, not a <style> in disguise.
      const applierResponse = await fetch(base + applierUrl);
      assert.equal(applierResponse.status, 200, `${applierUrl} must be served by the dev server`);
      const applierCode = await applierResponse.text();
      assert.match(applierCode, /createElement\(\s*["']link["']\s*\)/,
        'the dev CSS applier must create a <link> element');
      assert.match(applierCode, /rel\b[\s\S]{0,40}stylesheet/,
        'the dev CSS applier must mark its <link> as rel="stylesheet"');
      assert.doesNotMatch(applierCode, /createElement\(\s*["']style["']\s*\)/,
        'the dev CSS applier must not fall back to creating a <style> element');

      // ...and the URL that <link> points at must serve real CSS, or the page is
      // still unstyled while looking fixed.
      const cssResponse = await fetch(`${base}${url}?direct`);
      assert.equal(cssResponse.status, 200, `${url}?direct must serve the compiled stylesheet`);
      assert.match(cssResponse.headers.get('content-type') ?? '', /text\/css/,
        `${url}?direct must be served as text/css so a <link rel="stylesheet"> applies it`);
      const css = await cssResponse.text();
      assert.doesNotMatch(css, /^\s*</, `${url}?direct must return CSS, not an HTML fallback`);
      assert.ok(css.includes('{') && css.includes('}'), `${url}?direct must contain real declarations`);
    }

    // Tailwind specifically: the reported symptom was "zero Tailwind".
    const tailwind = await (await fetch(`${base}/index.css?direct`)).text();
    assert.ok(tailwind.includes('--tw-border-spacing-x'),
      'the dev stylesheet must carry compiled Tailwind');
    // The bg palette token (#060706) compiles to an rgb() triple with an opacity
    // variable, which is the form that actually reaches the browser.
    assert.ok(/background-color:\s*rgb\(6 7 6/.test(tailwind),
      'the dev stylesheet must carry the compiled bg palette token');

    // And none of it may have been bought with a weaker policy or a nonce.
    const html = await (await fetch(`${base}/index.html`)).text();
    assert.equal(metaCsp(html), EXPECTED_CSP,
      'the dev document must be served under the same strict CSP as production');
    assert.doesNotMatch(html, /csp-nonce/i,
      'dev styling must not depend on a nonce: the same policy text ships to users');
  } finally {
    await server.close();
  }
});

test('the dev CSS plumbing provably cannot reach a production build', async () => {
  const { resolveConfig } = require('vite');
  const buildConfig = await resolveConfig({ configFile }, 'build');
  const serveConfig = await resolveConfig({ configFile }, 'serve');
  const names = (config) => config.plugins.map((plugin) => plugin.name);

  assert.deepEqual(names(buildConfig).filter((name) => name.startsWith('nv-')), [],
    "no nv- dev plugin may be present in the resolved build config: apply: 'serve' is the guarantee");
  assert.ok(names(serveConfig).includes('nv-externalize-dev-css'),
    'the dev CSS externalizer must be active in the dev server');
});

test('the packaged renderer still applies CSS through a real external stylesheet', (t) => {
  const builtHtml = path.join(root, 'build/renderer/index.html');
  if (!fs.existsSync(builtHtml)) {
    t.skip('build/renderer/index.html absent — run npm run build to exercise this');
    return;
  }
  const html = fs.readFileSync(builtHtml, 'utf8');
  assert.equal(metaCsp(html), EXPECTED_CSP, 'the shipped CSP must be exactly as strict as the source CSP');
  assert.match(html, /<link[^>]+rel="stylesheet"[^>]+href="[^"]+\.css"/i,
    'the packaged document must link a real external stylesheet');
  assert.doesNotMatch(html, /<style[\s>]/i, 'the packaged document must carry no <style> element');
  assert.equal(/nv-dev-css|updateStyle|csp-nonce/.test(html), false,
    'no dev-only CSS plumbing may appear in the shipped HTML');
});
