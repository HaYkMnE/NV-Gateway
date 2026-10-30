import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Periodic background update check (6 h ± 15 min) and plain-text release notes
// in the offer dialog. Timers are faked through the injected `scheduler`, the
// updater is an EventEmitter stand-in for electron-updater's autoUpdater.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const built = pathToFileURL(path.join(root, 'build', 'src', 'main', 'auto-update.js')).href;
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

function fakeUpdater() {
  const emitter = new EventEmitter();
  const calls = [];
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    calls,
    emit: (name, payload) => emitter.emit(name, payload),
    on: (name, listener) => emitter.on(name, listener),
    checkForUpdates: async () => { calls.push('checkForUpdates'); },
    downloadUpdate: async () => { calls.push('downloadUpdate'); },
    quitAndInstall: () => { calls.push('quitAndInstall'); }
  };
}

/** Fake timers: records every setTimeout; `fire()` runs the latest live one. */
function fakeScheduler() {
  const timers = [];
  const cleared = [];
  return {
    timers,
    cleared,
    setTimeout(callback, ms) {
      const handle = { callback, ms, unrefed: false, live: true, unref() { this.unrefed = true; } };
      timers.push(handle);
      return handle;
    },
    clearTimeout(handle) { handle.live = false; cleared.push(handle); },
    live() { return timers.filter((t) => t.live); },
    async fire() {
      const handle = timers.at(-1);
      assert.ok(handle && handle.live, 'a live periodic timer must be armed');
      handle.live = false;
      handle.callback();
      await flush();
    }
  };
}

const flush = async (times = 6) => { for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

async function build({ responses = [], dialog, enabled = true, random = () => 0.5, language = 'en' } = {}) {
  const { createAutoUpdateService } = await import(built);
  const updater = fakeUpdater();
  const scheduler = fakeScheduler();
  const shown = [];
  const states = [];
  const logs = [];
  const service = createAutoUpdateService({
    updater,
    dialog: dialog ?? { showMessageBox: async (options) => { shown.push(options); return { response: responses.length ? responses.shift() : 1 }; } },
    getLanguage: () => language,
    log: (level, event, data) => logs.push({ level, event, data }),
    setQuitting() {},
    stopGateway: async () => {},
    onStatusChanged: (status) => states.push(status),
    enabled,
    scheduler,
    random
  });
  return { service, updater, scheduler, shown, states, logs };
}

// ── 1. periodic check ─────────────────────────────────────────────────────

test('interval and jitter are named constants: 6 h and 15 min', async () => {
  const mod = await import(built);
  assert.equal(mod.PERIODIC_CHECK_INTERVAL_MS, 6 * HOUR);
  assert.equal(mod.PERIODIC_CHECK_JITTER_MS, 15 * MIN);
});

test('the periodic check fires at 6 h ± jitter, unref\'d, and re-arms after each run', async () => {
  for (const [r, expected] of [[0, 6 * HOUR - 15 * MIN], [0.5, 6 * HOUR], [1, 6 * HOUR + 15 * MIN]]) {
    const h = await build({ random: () => r });
    h.service.startPeriodicChecks();
    assert.equal(h.scheduler.timers.length, 1, 'exactly one timer is armed');
    assert.equal(h.scheduler.timers[0].ms, expected, `random=${r} -> delay ${expected}`);
    assert.equal(h.scheduler.timers[0].unrefed, true, 'the timer never keeps the process alive');
    h.service.startPeriodicChecks();
    assert.equal(h.scheduler.timers.length, 1, 'starting twice does not double-arm');
  }
  const h = await build({ random: () => 0.25 });
  h.service.startPeriodicChecks();
  assert.equal(h.updater.calls.filter((c) => c === 'checkForUpdates').length, 0, 'nothing runs before the delay elapses');
  await h.scheduler.fire();
  assert.equal(h.updater.calls.filter((c) => c === 'checkForUpdates').length, 1, 'the elapsed timer runs one network check');
  assert.equal(h.logs.find((l) => l.event === 'update_checking').data.manual, false, 'periodic checks are background (silent) checks');
  assert.equal(h.scheduler.live().length, 1, 'the next round is armed');
  const delay = h.scheduler.live()[0].ms;
  assert.ok(delay >= 6 * HOUR - 15 * MIN && delay <= 6 * HOUR + 15 * MIN, `next delay ${delay} within 6 h ± 15 min`);
});

test('the periodic check is skipped while busy: dialog open, downloading, install pending, check running', async () => {
  // Dialog open: the offer dialog never resolves.
  {
    const shown = [];
    const h = await build({ dialog: { showMessageBox: (o) => { shown.push(o); return new Promise(() => {}); } } });
    await h.service.checkForUpdates({ manual: false });
    h.updater.emit('update-available', { version: '2.0.0' });
    await flush();
    assert.equal(shown.length, 1);
    h.service.startPeriodicChecks();
    await h.scheduler.fire();
    assert.equal(h.updater.calls.filter((c) => c === 'checkForUpdates').length, 1, 'no network check while a dialog is open');
    assert.equal(shown.length, 1, 'no stacked dialog');
    assert.ok(h.logs.some((l) => l.event === 'update_periodic_check_skipped'), 'the skip is logged');
    assert.equal(h.scheduler.live().length, 1, 'a skipped round still re-arms');
  }
  // Downloading.
  {
    const h = await build({ responses: [0] });
    await h.service.checkForUpdates({ manual: false });
    h.updater.emit('update-available', { version: '2.0.0' });
    await flush();
    assert.equal(h.service.getStatus().state, 'downloading');
    h.service.startPeriodicChecks();
    await h.scheduler.fire();
    assert.equal(h.updater.calls.filter((c) => c === 'checkForUpdates').length, 1, 'no check during a download');
  }
  // Install pending (downloaded, user said Later): the timer must not re-open the install dialog.
  {
    const h = await build({ responses: [1] });
    h.updater.emit('update-downloaded', { version: '2.0.0' });
    await flush();
    assert.equal(h.service.getStatus().state, 'ready');
    const shownBefore = h.shown.length;
    h.service.startPeriodicChecks();
    await h.scheduler.fire();
    assert.equal(h.updater.calls.filter((c) => c === 'checkForUpdates').length, 0, 'no check while an install is pending');
    assert.equal(h.shown.length, shownBefore, 'the background timer never re-opens the install dialog');
  }
  // A check already running.
  {
    const h = await build();
    h.updater.emit('checking-for-update');
    assert.equal(h.service.getStatus().state, 'checking');
    h.service.startPeriodicChecks();
    await h.scheduler.fire();
    assert.equal(h.updater.calls.filter((c) => c === 'checkForUpdates').length, 0, 'no second concurrent check');
  }
});

test('a postponed version is not re-offered by a periodic check; a newer version is offered exactly once', async () => {
  const h = await build({ responses: [1, 1] }); // "Later", "Later"
  await h.service.checkForUpdates({ manual: false }); // startup check
  h.updater.emit('update-available', { version: '2.0.0' });
  await flush();
  assert.equal(h.shown.length, 1, 'first sighting shows the modal');

  h.service.startPeriodicChecks();
  await h.scheduler.fire();
  h.states.length = 0;
  h.updater.emit('update-available', { version: '2.0.0' });
  await flush();
  assert.equal(h.shown.length, 1, 'same postponed version: no repeat modal');
  assert.deepEqual(h.service.getStatus(), { state: 'available', version: '2.0.0', percent: null }, 'status still says an update exists');
  assert.ok(h.states.some((s) => s.state === 'available' && s.version === '2.0.0'), 'tray/pet status is pushed via onStatusChanged');
  assert.ok(h.logs.some((l) => l.event === 'update_offer_suppressed'));

  await h.scheduler.fire();
  h.updater.emit('update-available', { version: '2.1.0' });
  await flush();
  assert.equal(h.shown.length, 2, 'a newer version shows the modal');
  assert.match(h.shown[1].message, /2\.1\.0/);

  await h.scheduler.fire();
  h.updater.emit('update-available', { version: '2.1.0' });
  await flush();
  assert.equal(h.shown.length, 2, 'the newer version is offered once, then postponed like the first');

  // An explicit manual check still offers the postponed version.
  await h.service.checkForUpdates({ manual: true });
  h.updater.emit('update-available', { version: '2.1.0' });
  await flush();
  assert.equal(h.shown.length, 3, 'a manual check always offers');
});

test('the periodic timer is cleared on quit and never re-armed', async () => {
  const h = await build();
  h.service.startPeriodicChecks();
  const [handle] = h.scheduler.timers;
  h.service.stopPeriodicChecks();
  assert.deepEqual(h.scheduler.cleared, [handle], 'the armed timer is cleared');
  assert.equal(h.scheduler.live().length, 0);
  h.service.startPeriodicChecks();
  h.service.stopPeriodicChecks();
  assert.equal(h.scheduler.timers.length, 1, 'no timer after quit');
});

test('no periodic check in unpackaged builds', async () => {
  const h = await build({ enabled: false });
  h.service.startPeriodicChecks();
  assert.equal(h.scheduler.timers.length, 0, 'nothing is scheduled when not packaged');
  assert.ok(h.logs.some((l) => l.event === 'update_periodic_check_disabled'));
});

test('main process arms the periodic check with the packaged startup check and clears it on will-quit', () => {
  const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /if \(app\.isPackaged\) \{[\s\S]*?checkForUpdates\(\{ manual: false \}\)[\s\S]*?updaterService\.startPeriodicChecks\(\);\s*\}/,
    'startPeriodicChecks sits in the same app.isPackaged block as the startup check');
  assert.match(main, /app\.on\("will-quit", \(\) => \{[\s\S]*?updaterService\?\.stopPeriodicChecks\(\);/, 'the timer is cleared on quit');
});

// ── 2. release notes ──────────────────────────────────────────────────────

test('release notes: HTML is stripped, entities decoded, blank runs collapsed', async () => {
  const { formatReleaseNotes } = await import(built);
  const out = formatReleaseNotes('<h2>Fixed</h2>\n<ul><li>Crash &amp; hang</li><li>&lt;tag&gt; &quot;q&quot; &#39;s&#39;</li></ul>\n\n\n\n<p>Tail</p>');
  assert.match(out, /Fixed/);
  assert.match(out, /Crash & hang/);
  assert.match(out, /<tag> "q" 's'/);
  assert.doesNotMatch(out, /<\/?(h2|ul|li|p)\b/, 'no tags survive');
  assert.doesNotMatch(out, /\n{3,}/, 'runs of blank lines collapse');
  assert.match(out, /Tail$/);
  assert.equal(formatReleaseNotes('a\n\n\n\n\nb'), 'a\n\nb');
});

test('release notes: a <script> tag and its content never reach the dialog', async () => {
  const { formatReleaseNotes } = await import(built);
  for (const input of [
    '<p>ok</p><script>alert("x")</script><img src=x onerror=alert(1)>',
    '<p>ok</p><SCRIPT type="text/javascript">\nalert(1)\n</SCRIPT >',
    '<p>ok</p><script>alert(1)' // unterminated
  ]) {
    const out = formatReleaseNotes(input);
    assert.equal(out, 'ok', `only the text survives: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
  }
  // A closed script is removed WITH its body, and the notes after it are kept.
  assert.equal(formatReleaseNotes('<p>ok</p><script>alert("x")</script><p>after</p>'), 'ok\nafter');
});

test('release notes: capped at 1500 chars with an ellipsis', async () => {
  const { formatReleaseNotes, RELEASE_NOTES_MAX_CHARS } = await import(built);
  assert.equal(RELEASE_NOTES_MAX_CHARS, 1500);
  const out = formatReleaseNotes('x'.repeat(5000));
  assert.equal(out.length, 1500);
  assert.ok(out.endsWith('…'));
  assert.equal(formatReleaseNotes('y'.repeat(1500)), 'y'.repeat(1500), 'exactly at the cap: untouched');
});

test('release notes: bidi, zero-width and C0 control characters are stripped; \\n and \\t survive', async () => {
  const { formatReleaseNotes } = await import(built);
  const spoofers = ['\u202E', '\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069', '\u061C',
    '\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\uFEFF', '\u0000', '\u0007', '\u001B', '\u0001', '\u0008', '\u000B', '\u000C', '\u001F', '\u007F'];
  for (const ch of spoofers) {
    const code = ch.codePointAt(0).toString(16);
    assert.equal(formatReleaseNotes(`a${ch}b\nc${ch}d`), 'ab\ncd', `U+${code} is removed and \\n survives`);
    assert.equal(formatReleaseNotes([{ version: `1${ch}.0`, note: `x${ch}y` }]), '1.0\nxy', `U+${code} is removed from the array form`);
  }
  assert.equal(formatReleaseNotes('col1\tcol2\r\nline2\rline3'), 'col1\tcol2\nline2\nline3', '\\t is kept; \\r\\n and lone \\r become \\n');
  assert.equal(formatReleaseNotes('evil.exe\u202Etxt.pdf'), 'evil.exetxt.pdf', 'an RLO cannot reorder the dialog text');
});

// ── CR10-001: CHANGELOG Markdown -> dialog plain text ──────────────────────

const AD_INPUT = '## [1.5.0] - 2026-10-01\n### Added\n- **New** `Works with any app` block, see [docs](https://x.y)\n  - 17 apps\n\n\n### Fixed\n- snake_case_id kept';

test('markdown: the art director\'s exact example renders in en and ru', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(formatReleaseNotes(AD_INPUT), 'Added:\n• New Works with any app block, see docs\n  • 17 apps\n\nFixed:\n• snake_case_id kept');
  assert.equal(formatReleaseNotes(AD_INPUT, { language: 'en' }), 'Added:\n• New Works with any app block, see docs\n  • 17 apps\n\nFixed:\n• snake_case_id kept');
  assert.equal(formatReleaseNotes(AD_INPUT, { language: 'ru' }), 'Добавлено:\n• New Works with any app block, see docs\n  • 17 apps\n\nИсправлено:\n• snake_case_id kept');
  assert.equal(formatReleaseNotes([{ version: '1.5.0', note: AD_INPUT }], { language: 'ru' }),
    '1.5.0\nДобавлено:\n• New Works with any app block, see docs\n  • 17 apps\n\nИсправлено:\n• snake_case_id kept', 'each array note gets the same rules');
});

test('markdown: all six Keep a Changelog sections are translated; unknown headings stay as written', async () => {
  const { formatReleaseNotes } = await import(built);
  const input = '### Added\n- a\n### Changed\n- b\n### Deprecated\n- c\n### Removed\n- d\n### Fixed\n- e\n### Security\n- f\n### Highlights\n- g';
  assert.equal(formatReleaseNotes(input, { language: 'ru' }),
    'Добавлено:\n• a\n\nИзменено:\n• b\n\nУстарело:\n• c\n\nУдалено:\n• d\n\nИсправлено:\n• e\n\nБезопасность:\n• f\n\nHighlights:\n• g');
  for (const language of ['en', 'ru', 'zh', 'es', 'hi', 'fr', 'ar']) {
    const out = formatReleaseNotes(input, { language });
    assert.equal(out.split('\n').filter((line) => line.endsWith(':')).length, 7, `${language}: 7 headings`);
    assert.match(out, /Highlights:/, `${language}: unknown heading is not translated`);
    assert.doesNotMatch(out, /#/, `${language}: no # left`);
  }
  assert.equal(formatReleaseNotes('*emph* and _word_ but snake_case_id, a*b and 5 * 3'), 'emph and word but snake_case_id, a*b and 5 * 3');
  assert.equal(formatReleaseNotes('* star bullet\n    * deep'), '• star bullet\n  • deep');
});

test('markdown: bold/emphasis only strip real pairs (__init__, 2**10, *** survive)', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(formatReleaseNotes('call __init__ now'), 'call __init__ now');
  assert.equal(formatReleaseNotes('__init__'), '__init__');
  assert.equal(formatReleaseNotes('2**10 is 1024'), '2**10 is 1024');
  assert.equal(formatReleaseNotes('a *** b'), 'a *** b');
  assert.equal(formatReleaseNotes('**bold** and **two words**'), 'bold and two words');
  assert.equal(formatReleaseNotes('**a** and **b**'), 'a and b', 'two bold spans on one line are stripped separately');
  assert.equal(formatReleaseNotes('**x**y**z**'), 'xyz', 'adjacent spans: each closed pair is stripped');
  assert.equal(formatReleaseNotes('***bold***'), 'bold', 'bold+emphasis: ** pair, then the * pair');
  assert.equal(formatReleaseNotes('_italic_ and *em* text'), 'italic and em text');
  assert.equal(formatReleaseNotes('- **New** _x_ snake_case_id'), '• New x snake_case_id');
});

test('release notes: 50 KB pathological tag repeats finish fast (input capped before the regexes)', async (t) => {
  const { formatReleaseNotes, RELEASE_NOTES_INPUT_MAX_CHARS } = await import(built);
  assert.equal(RELEASE_NOTES_INPUT_MAX_CHARS, 16_384);
  for (const [label, unit] of [['<p', '<p'], ['<a ', '<a '], ['<!--', '<!--'], ['<script', '<script']]) {
    const input = unit.repeat(Math.ceil(50_000 / unit.length));
    for (const [form, value] of [['string', input], ['array', [{ version: '1.0.0', note: input }]]]) {
      const started = performance.now();
      formatReleaseNotes(value);
      const ms = performance.now() - started;
      t.diagnostic(`measured ${label} ${form} ${ms.toFixed(1)}ms`);
      assert.ok(ms < 200, `${label} x50KB (${form}) took ${ms.toFixed(1)} ms`);
    }
  }
});

test('release notes: the input cap leaves normal notes alone and never splits a surrogate pair', async () => {
  const { formatReleaseNotes } = await import(built);
  const normal = '### Fixed\n- Promise<string> works\n- **Faster** startup';
  assert.equal(formatReleaseNotes(normal), 'Fixed:\n• Promise<string> works\n• Faster startup');
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const straddle = formatReleaseNotes(`${'a'.repeat(16_383)}\u{1F600}tail`, { maxChars: 1e9 });
  assert.equal(straddle, 'a'.repeat(16_383), 'cut lands before the emoji, not inside it');
  assert.equal(unpaired.test(straddle), false);
  assert.equal(formatReleaseNotes('b'.repeat(20_000), { maxChars: 1e9 }).length, 16_384, 'long input is cut at 16 384');
});

test('CR10-003: a tag name must end at space, "/", ">" or end of input (custom elements, a:b are text)', async () => {
  const { formatReleaseNotes } = await import(built);
  for (const kept of ['<code-editor>x</code-editor>', '<p-foo>', '<a:b>', '<b-tree> node', 'use <span-x', '<h7>']) {
    assert.equal(formatReleaseNotes(kept), kept, `kept as text: ${JSON.stringify(kept)}`);
  }
  assert.equal(formatReleaseNotes('- use <script-runner> tool\n- keep me'), '• use <script-runner> tool\n• keep me', '<script-runner> swallows nothing');
  assert.equal(formatReleaseNotes('- see <style-guide> docs\n- next line'), '• see <style-guide> docs\n• next line', '<style-guide> swallows nothing');
  assert.equal(formatReleaseNotes('a <script-x>b</script-x> c'), 'a <script-x>b</script-x> c', 'not a script block');
  for (const [input, expected] of [
    ['<p>ok</p>', 'ok'],
    ['a<br/>b', 'a\nb'],
    ['a<img src=x>b', 'ab'],
    ['<p\n class=y>t</p>', 't'],
    ['<a\thref=x>t</a>', 't'],
    ['x</p>', 'x'],
    ['<P>Up</P>', 'Up'],
    ['<h1>T</h1>', 'T'],
    ['<SCRIPT src=x>y</SCRIPT>z', 'z'],
    ['ok <p', 'ok'],
    ['ok <img src=x', 'ok'],
    ['ok <script', 'ok']
  ]) {
    assert.equal(formatReleaseNotes(input), expected, `stripped: ${JSON.stringify(input)}`);
  }
});

test('CR10-002: generics and comparisons survive; only known HTML tags are stripped', async () => {
  const { formatReleaseNotes } = await import(built);
  const inline = 'Returns Promise<string> or Map<string, number>; call f<T>() when a < b > c';
  assert.equal(formatReleaseNotes(inline), inline, 'inline generics/comparisons are text, not tags');
  const body = 'const m: Map<string, number> = new Map();\nfunction f<T>(): Promise<string> {}\nif (a < b > c) {}';
  assert.equal(formatReleaseNotes(`Code:\n\`\`\`ts\n${body}\n\`\`\``), `Code:\n${body}`, 'same inside a ts fence');
  assert.equal(formatReleaseNotes('ends with Promise<string'), 'ends with Promise<string', 'an unterminated generic is not an unterminated tag');
  assert.equal(formatReleaseNotes('<p>x</p>'), 'x');
  assert.equal(formatReleaseNotes('a<img src=x onerror=alert(1)>b'), 'ab', 'img is removed entirely');
  assert.equal(formatReleaseNotes('x <img src=x onerror=alert(1)'), 'x', 'an unterminated known tag is removed');
  assert.equal(formatReleaseNotes('a<script>alert(1)</script>b'), 'ab', 'script still dropped with its content');
  assert.equal(formatReleaseNotes('a<!-- c -->b'), 'ab', 'comments are removed');
  assert.equal(formatReleaseNotes('a<!--\nhidden\n-->b'), 'ab', 'multi-line comments are removed');
  assert.equal(formatReleaseNotes('a <!-- never closed'), 'a', 'an unterminated comment is removed');
  assert.equal(formatReleaseNotes('<STRONG>Bold</STRONG> <span class="x">s</span> <abbr>t</abbr>'), 'Bold s <abbr>t</abbr>', 'case-insensitive list; unlisted names are kept as text');
});

test('markdown: code-fence lines are dropped, the fenced body is kept as written', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(formatReleaseNotes('Run:\n```js\nconst a_b_ = 1; // - not a bullet\n```\nDone'), 'Run:\nconst a_b_ = 1; // - not a bullet\nDone');
  assert.equal(formatReleaseNotes('```\nx\n```'), 'x', 'a bare fence (no language) is dropped too');
  assert.doesNotMatch(formatReleaseNotes('```bash\nnpm i\n```'), /^(bash|```)/m, 'no stray language line');
});

test('markdown: horizontal rules are dropped; bullets are not', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(formatReleaseNotes('a\n---\nb\n***\nc\n___\nd\n - - - \ne'), 'a\nb\nc\nd\ne');
  assert.equal(formatReleaseNotes('---\n- item\n* star\n-- x'), '• item\n• star\n-- x', '"- item" stays a bullet; "-- x" is not a rule');
});

test('markdown: HTML input still renders through the HTML path; the Markdown pass is harmless', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(formatReleaseNotes('<h3>Added</h3><ul><li>snake_case_id &amp; a*b*c</li><li>x - y</li></ul>'), 'Added\nsnake_case_id & a*b*c\nx - y');
});

test('markdown: a long input is cut at a whole line with … on its own line', async () => {
  const { formatReleaseNotes } = await import(built);
  const input = `### Fixed\n${Array.from({ length: 200 }, (_, i) => `- item ${i} ${'z'.repeat(i % 17)}`).join('\n')}`;
  const full = formatReleaseNotes(input, { maxChars: 1e9 }).split('\n');
  const out = formatReleaseNotes(input);
  assert.ok(out.length <= 1500, `length ${out.length}`);
  const lines = out.split('\n');
  assert.equal(lines.at(-1), '…', 'the ellipsis has its own line');
  assert.deepEqual(lines.slice(0, -1), full.slice(0, lines.length - 1), 'every kept line is a whole rendered line');
});

test('markdown: the real CHANGELOG.md [Unreleased] section renders with no #, "- " or brackets', async () => {
  const { formatReleaseNotes } = await import(built);
  const { extractReleaseNotes } = await import(pathToFileURL(path.join(root, 'scripts', 'release-notes.mjs')).href);
  const section = extractReleaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), 'Unreleased');
  for (const language of ['ru', 'en']) {
    const out = formatReleaseNotes(section, { language });
    assert.ok(out.length > 0);
    assert.doesNotMatch(out, /#/, `${language}: no #`);
    assert.doesNotMatch(out, /^\s*- /m, `${language}: no "- " bullets`);
    assert.doesNotMatch(out, /[[\]]/, `${language}: no brackets`);
    assert.match(out, /^\s*• /m, `${language}: bullets became •`);
  }
  assert.match(formatReleaseNotes(section, { language: 'ru' }), /^Добавлено:$/m);
});

test('release notes: lone surrogates already in the input are dropped; valid pairs survive', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(formatReleaseNotes('a\uDC00b'), 'ab', 'a lone low surrogate is removed');
  assert.equal(formatReleaseNotes('a\uD83Db'), 'ab', 'a lone high surrogate is removed');
  assert.equal(formatReleaseNotes([{ version: '1.0.0', note: 'x\uD83Dy\uDC00z' }]), '1.0.0\nxyz', 'array form too');
  assert.equal(formatReleaseNotes('ok \u{1F600} done'), 'ok \u{1F600} done', 'a valid emoji survives intact');
});

test('release notes: the cap never leaves a lone surrogate before the ellipsis', async () => {
  const { formatReleaseNotes } = await import(built);
  const unpaired = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const pad of [1497, 1498, 1499]) {
    const out = formatReleaseNotes(`${'a'.repeat(pad)}\u{1F600}${'b'.repeat(50)}`);
    assert.equal(unpaired.test(out), false, `pad ${pad}: ${JSON.stringify(out.slice(-4))} has no unpaired surrogate`);
    assert.ok(out.endsWith('…') && out.length <= 1500, `pad ${pad}: capped with an ellipsis`);
  }
});

test('release notes: the fullChangelog array form is rendered as version + note blocks', async () => {
  const { formatReleaseNotes } = await import(built);
  assert.equal(
    formatReleaseNotes([{ version: '1.2.0', note: '<p>B &amp; C</p>' }, { version: '1.1.0', note: 'A' }, { version: '1.0.0', note: null }, null]),
    '1.2.0\nB & C\n\n1.1.0\nA'
  );
});

test('release notes: empty notes add nothing to the dialog', async () => {
  const { formatReleaseNotes } = await import(built);
  for (const value of [undefined, null, '', '   \n\n', '<p></p>', [], [{ version: '1.0.0', note: '' }], 42]) {
    assert.equal(formatReleaseNotes(value), '', `${JSON.stringify(value)} -> ""`);
  }
  const h = await build();
  await h.service.checkForUpdates({ manual: true });
  h.updater.emit('update-available', { version: '2.0.0', releaseNotes: '<p> </p>' });
  await flush();
  assert.equal(h.shown.length, 1);
  assert.equal('detail' in h.shown[0], false, 'no detail when there is nothing to show');
});

test('release notes appear as plain text under a localized heading in the offer dialog', async () => {
  const h = await build({ language: 'ru' });
  await h.service.checkForUpdates({ manual: false });
  h.updater.emit('update-available', { version: '2.0.0', releaseNotes: '<ul><li>Быстрее</li></ul><script>evil()</script>' });
  await flush();
  assert.equal(h.shown.length, 1);
  assert.match(h.shown[0].message, /Доступна новая версия: 2\.0\.0/, 'the existing text is unchanged');
  assert.equal(h.shown[0].detail, 'Что нового:\nБыстрее');
  const en = await build({ language: 'en' });
  await en.service.checkForUpdates({ manual: false });
  en.updater.emit('update-available', { version: '2.0.0', releaseNotes: [{ version: '2.0.0', note: 'Faster' }] });
  await flush();
  assert.equal(en.shown[0].detail, "What's new:\n2.0.0\nFaster");
});
