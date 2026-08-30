import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));

// ───────────────────────────────────────────────────────────────────────────
// DEFECT: `npm run dev` renders a blank window.
//
// MEASURED SYMPTOMS (previous campaign, reproduced by this test at the HTML
// layer): #root innerHTML length 0, 0 buttons, typeof window.$RefreshReg$ ===
// "undefined", page exception "Error: @vitejs/plugin-react can't detect
// preamble", and the console error
//   Refused to execute inline script because it violates the following
//   Content-Security-Policy directive: "script-src 'self'"
//
// ROOT CAUSE. @vitejs/plugin-react injects its react-refresh preamble as an
// INLINE <script type="module"> during dev. Two independent CSPs apply to that
// document and BOTH must allow a script for it to run:
//   1. src/renderer/index.html's own <meta http-equiv="Content-Security-Policy">
//   2. PRODUCTION_CSP, attached as a response header by installSecurityHeaders()
//      via onHeadersReceived — installed unconditionally at src/main/index.ts:389,
//      so it covers the http://localhost:5173 dev document too.
// Neither carries 'unsafe-inline', so the preamble never executes, $RefreshReg$
// is never defined, and the first React module to load throws "can't detect
// preamble" — leaving #root empty. Packaged users are unaffected: the built
// index.html carries no inline script.
//
// REQUIRED BEHAVIOUR. Dev mode must work WITHOUT weakening either CSP. The fix
// is not to permit inline script; it is to stop emitting one. A same-origin
// EXTERNAL module script is already allowed by `script-src 'self'` under both
// policies, so the preamble must be served as a real URL instead of inlined.
// That is also why the fix provably cannot ship: there is no relaxation to leak,
// and the transform is dev-only (apply: 'serve').
// ───────────────────────────────────────────────────────────────────────────

/** The exact CSP the renderer HTML must keep. Production must not get looser. */
const EXPECTED_META_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
  + "form-action 'none'";

/** Every <script> tag in a document, with its attributes and inline body. */
function scriptTags(html) {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({
    attrs: m[1],
    body: m[2],
    external: /\ssrc\s*=/i.test(m[1]),
    inlineCode: m[2].trim()
  }));
}

function metaCsp(html) {
  // The content attribute is double-quoted and legitimately contains single
  // quotes ('self'), so the value class must exclude only the double quote.
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  return m ? m[1] : null;
}

test('the renderer HTML keeps its strict CSP with no inline-script escape hatch', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const csp = metaCsp(html);
  assert.equal(csp, EXPECTED_META_CSP,
    'the source CSP must stay byte-identical: dev mode must not be bought with a weaker policy');
  assert.equal(/unsafe-inline/.test(csp), false, "script-src must never gain 'unsafe-inline'");
  assert.equal(/unsafe-eval/.test(csp), false, "script-src must never gain 'unsafe-eval'");
});

test('the dev server serves a document whose every script is external and same-origin', async () => {
  // Measures what the browser actually receives from the dev server, which is
  // the only place the preamble is injected. No Electron needed: the CSP that
  // blocks it is already present in the HTML the server returns.
  const { createServer } = require('vite');
  const server = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    // A port and host of its own so a developer's running dev server is not
    // disturbed; the URL is taken from Vite rather than assumed.
    server: { port: 5199, strictPort: false, host: '127.0.0.1' },
    logLevel: 'silent'
  });
  try {
    await server.listen();
    const base = server.resolvedUrls.local[0].replace(/\/$/, '');
    const response = await fetch(`${base}/index.html`);
    const html = await response.text();

    // The document the dev server serves still carries the strict CSP...
    assert.equal(metaCsp(html), EXPECTED_META_CSP,
      'the dev document must be served under the same strict CSP as production');

    // ...therefore no script in it may be inline, or it simply will not execute.
    const inline = scriptTags(html).filter((s) => !s.external && s.inlineCode.length > 0);
    assert.deepEqual(inline.map((s) => s.inlineCode.slice(0, 120)), [],
      'an inline <script> under "script-src \'self\'" is silently refused by Chromium, '
      + 'which is exactly why the dev window renders blank: the react-refresh preamble '
      + 'never runs, $RefreshReg$ stays undefined, and React throws '
      + '"@vitejs/plugin-react can\'t detect preamble". The preamble must be served as '
      + 'an external same-origin module instead of inlined.');

    // The refresh runtime must still actually be wired up in dev — a fix that
    // merely deletes the preamble would trade a blank window for broken HMR.
    assert.match(html, /<script[^>]+src="[^"]*react-refresh[^"]*"/i,
      'dev HTML must load the react-refresh preamble from a real same-origin URL');
  } finally {
    await server.close();
  }
});

test('the dev-only HTML transform cannot reach a production build', () => {
  const config = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
  // A plugin that rewrites dev HTML must be gated to the dev server. `apply:
  // 'serve'` is Vite's own guarantee that `vite build` never loads it.
  assert.match(config, /apply:\s*'serve'/,
    "the dev preamble transform must be declared apply: 'serve' so `vite build` never runs it");
});

test('the built renderer HTML has no inline script and no weakened CSP', (t) => {
  // Gated on a real build being present, like the other dist-dependent tests.
  const built = path.join(root, 'build/renderer/index.html');
  if (!fs.existsSync(built)) {
    t.skip('build/renderer/index.html absent — run npm run build to exercise this');
    return;
  }
  const html = fs.readFileSync(built, 'utf8');
  assert.equal(metaCsp(html), EXPECTED_META_CSP,
    'the shipped CSP must be exactly as strict as the source CSP');
  const inline = scriptTags(html).filter((s) => !s.external && s.inlineCode.length > 0);
  assert.deepEqual(inline.map((s) => s.inlineCode.slice(0, 120)), [],
    'the packaged document must contain no inline script at all');
  assert.equal(/react-refresh|RefreshReg|vite\/client|@vite/.test(html), false,
    'no dev-only refresh or client plumbing may appear in the shipped HTML');
});
