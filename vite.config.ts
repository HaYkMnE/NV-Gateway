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

export default defineConfig({
  plugins: [react(), externalizeDevPreamble()],
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
