import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// @vitejs/plugin-react injects its react-refresh preamble as an INLINE
// <script type="module">. Two independent CSPs govern the dev document and both
// must allow a script for it to execute:
//   1. the <meta http-equiv="Content-Security-Policy"> in src/renderer/index.html
//   2. PRODUCTION_CSP, attached as a response header to every session request by
//      installSecurityHeaders() (src/main/electron-security.ts), installed
//      unconditionally at src/main/index.ts:389 -- so it covers the dev document.
// Neither carries 'unsafe-inline', so Chromium refuses the preamble,
// window.$RefreshReg$ is never defined, and the first React module throws
// "@vitejs/plugin-react can't detect preamble", leaving #root empty. That is the
// blank `npm run dev` window.
//
// The fix is NOT to permit inline script. `script-src 'self'` already allows a
// same-origin EXTERNAL module, so the preamble is lifted out of the document and
// served from a real dev-server URL instead. No policy is relaxed anywhere, so
// there is nothing that could leak into production; and `apply: 'serve'` is
// Vite's own guarantee that `vite build` never loads this plugin. Both
// properties are asserted by tests/dev-server-csp-preamble.test.mjs.
const DEV_PREAMBLE_URL = '/@nv-react-refresh-preamble.js';

function externalizeDevPreamble(): Plugin {
  let preamble = '';
  return {
    name: 'nv-externalize-dev-preamble',
    apply: 'serve',
    configureServer(server) {
      // Registered directly rather than via a returned function, so it runs
      // BEFORE Vite's transform middleware -- which would otherwise try to
      // resolve this URL as a source module and 404 it.
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== DEV_PREAMBLE_URL) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(preamble);
      });
    },
    transformIndexHtml: {
      // 'post' so plugin-react has already injected its inline preamble.
      order: 'post',
      handler(html) {
        let moved = false;
        const withoutInline = html.replace(
          /[ \t]*<script type="module">([\s\S]*?)<\/script>\n?/g,
          (match: string, body: string) => {
            // Only the refresh preamble is moved; any other inline module is
            // left exactly as it is, so this cannot silently swallow scripts.
            if (!body.includes('$RefreshReg$')) return match;
            preamble = body;
            moved = true;
            return '';
          }
        );
        if (!moved) return html;
        return withoutInline.replace(
          '</head>',
          `  <script type="module" src="${DEV_PREAMBLE_URL}"></script>\n  </head>`
        );
      }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The SAME defect one directive over: dev CSS, blocked by style-src instead of
// script-src.
//
// In dev, Vite serves every JS-imported stylesheet as a JS module ending in
//   __vite__updateStyle(__vite__id, __vite__css)
// and that client helper (node_modules/vite/dist/client/client.mjs:786-795) does
// `document.createElement("style")` + `style.textContent = css`, i.e. an INLINE
// style. Under `style-src 'self'` -- carried by BOTH the meta CSP above and the
// PRODUCTION_CSP response header, which also covers http://localhost:5173 --
// Chromium refuses it:
//   Refused to apply inline style because it violates the following
//   Content-Security-Policy directive: "style-src 'self'". Either the
//   'unsafe-inline' keyword, a hash, or a nonce is required...
// so `npm run dev` renders with ZERO CSS. Packaged builds are unaffected:
// `vite build` emits a real external <link rel="stylesheet">, which
// `style-src 'self'` allows -- which is why only dev is blacked out.
//
// Fix, same shape as the preamble one above: stop emitting an inline style. Vite
// already serves the compiled stylesheet as real text/css at `<url>?direct`, so
// in dev the module points a <link rel="stylesheet"> at that URL -- external and
// same-origin, therefore already permitted. NOTHING is added to any CSP: no
// 'unsafe-inline', no hash, and deliberately no nonce either (Vite would read one
// from <meta property="csp-nonce">, but the policy text it would have to appear
// in is the very string that ships to users). React's style={{...}} is untouched:
// it writes through CSSOM, which CSP does not govern.
//
// `apply: 'serve'` is Vite's guarantee that `vite build` never loads this, and
// the transform only fires on modules Vite itself marked with __vite__updateStyle.
// Asserted by tests/dev-server-csp-style.test.mjs.
// ─────────────────────────────────────────────────────────────────────────────
const DEV_CSS_APPLIER_ID = 'virtual:nv-dev-css-applier';
const DEV_CSS_APPLIER_RESOLVED = `\0${DEV_CSS_APPLIER_ID}`;
const DEV_CSS_INLINE_CALL = '__vite__updateStyle(__vite__id, __vite__css)';
const DEV_CSS_LINK_CALL = '__vite__updateStyle(__vite__id, import.meta.url)';

// Drop-in replacement for the client's updateStyle/removeStyle: same contract
// (keyed by the stylesheet's module id, idempotent, prunable on HMR) but it
// applies CSS through an external <link> instead of an inline <style>. The URL
// handed in is the CSS module's own import.meta.url, so an HMR reload -- which
// re-imports the module as `?t=<timestamp>` -- yields a genuinely new href.
const DEV_CSS_APPLIER_SOURCE = `const links = new Map();

export function updateStyle(id, moduleUrl) {
  const previous = links.get(id);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.setAttribute('data-nv-dev-css-id', id);
  // Vite serves the compiled stylesheet as text/css at the same URL with
  // ?direct. Same origin, so style-src 'self' already covers it.
  link.href = moduleUrl + (moduleUrl.includes('?') ? '&' : '?') + 'direct';
  // Swap only once the replacement has really loaded, so an HMR update cannot
  // flash an unstyled frame; on failure the old sheet is kept rather than lost.
  const dropPrevious = () => { if (previous) previous.remove(); };
  link.addEventListener('load', dropPrevious);
  link.addEventListener('error', dropPrevious);
  document.head.appendChild(link);
  links.set(id, link);
}

export function removeStyle(id) {
  const link = links.get(id);
  if (link) link.remove();
  links.delete(id);
}
`;

function externalizeDevCss(): Plugin {
  return {
    name: 'nv-externalize-dev-css',
    apply: 'serve',
    // 'post' so vite:css-post has already produced the __vite__updateStyle call
    // this redirects, and still ahead of vite:import-analysis so the rewritten
    // specifier and import.meta.url are processed normally.
    enforce: 'post',
    resolveId(id) {
      return id === DEV_CSS_APPLIER_ID ? DEV_CSS_APPLIER_RESOLVED : null;
    },
    load(id) {
      return id === DEV_CSS_APPLIER_RESOLVED ? DEV_CSS_APPLIER_SOURCE : null;
    },
    transform(code) {
      // Only modules Vite itself turned into inline-style appliers.
      if (!code.includes(DEV_CSS_INLINE_CALL)) return null;
      const rewritten = code
        .replace(
          /import\s*\{\s*updateStyle as __vite__updateStyle,\s*removeStyle as __vite__removeStyle\s*\}\s*from\s*"[^"]*"/,
          `import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from ${JSON.stringify(DEV_CSS_APPLIER_ID)}`
        )
        // __vite__css stays declared but unused: the stylesheet now arrives over
        // the wire as text/css, and leaving the constant alone keeps this rewrite
        // down to the two lines that actually matter.
        .replace(DEV_CSS_INLINE_CALL, DEV_CSS_LINK_CALL);
      // A partially applied rewrite would silently reintroduce the blocked
      // inline style, so fail loudly instead.
      if (!rewritten.includes(DEV_CSS_APPLIER_ID) || !rewritten.includes(DEV_CSS_LINK_CALL)) {
        throw new Error(
          "nv-externalize-dev-css: could not redirect Vite's inline-style applier, "
          + "so dev CSS would be refused by style-src 'self'. Vite's dev CSS module "
          + 'shape changed; update this plugin.'
        );
      }
      return { code: rewritten, map: null };
    }
  };
}

export default defineConfig({
  plugins: [react(), externalizeDevPreamble(), externalizeDevCss()],
  base: './',
  root: resolve(__dirname, 'src/renderer'),
  build: {
    outDir: resolve(__dirname, 'build/renderer'),
    emptyOutDir: true
  },
  server: {
    port: 5173
  }
});
