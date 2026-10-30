// PET SIZE PARITY — the hacker column and the mascot box must render at a
// COMPARABLE size inside the sidebar button, and neither artwork may be
// distorted to get there.
//
// ───────────────────────────────────────────────────────────────────────────
// WHY THIS FILE WAS REWRITTEN (the previous version pinned the WRONG state)
// ───────────────────────────────────────────────────────────────────────────
// The owner's report was: the hacker's box is a GOOD size, the ROBOT is too
// small next to it. Attempt 1 and attempt 2 both read it backwards and SHRANK
// the hacker column to 112px (`.hacker-viewport { width: 112px }`, then
// `height: auto` / `width: 100%` stages) to make it match the robot. The owner
// rejected that ("ужасно"). The previous version of this file pinned that
// wrong direction: it asserted `.hacker-viewport` width == `.mascot-viewport`
// width == 112px and that the canvas carries no pixel size at all, so restoring
// the shipped `width: 100%`/80x76 stage turned it red, and enlarging the mascot
// turned it red too. A test that blocks the correct fix is a defective test —
// it is replaced here, not amended.
//
// It also asserted `src/renderer/index.css` has NO `*{box-sizing:border-box}`
// preflight. The shipped bundle DOES contain the Tailwind preflight
// `*,:before,:after{box-sizing:border-box}` (measured:
// `getComputedStyle(probe).boxSizing === 'border-box'`), so that assertion was
// factually wrong and is gone.
//
// ───────────────────────────────────────────────────────────────────────────
// MEASURED GROUND TRUTH (real Electron 31.7.7 BrowserWindow, shipped bundle,
// Tailwind preflight active — not arithmetic, not a stylesheet guess)
// ───────────────────────────────────────────────────────────────────────────
//   sidebar <aside>           250px
//   .px-5 gutter              20px x 2
//   .sidebar-widget-wrap      209px
//   .widget-btn               209px, padding 8px + border 1px
//     => content box          EXACTLY 191px
//
//   HEAD (the shipped, owner-approved look)          attempt-2 (wrong)
//   .mascot-viewport      112 x 98                  112 x 98 (never changed)
//   .hacker-viewport      191 x 157.5 (100%)        112 x 175.33
//   .crt-casing           191 x 119.5               112 x 131.39
//   .crt-screen           179 x 94 (height:94px)    100 x 105.89 (height:auto)
//   .hacker-stage         80 x 76 absolute/bottom   98 x 93.09 relative/full
//   .hacker-stage canvas  80 x 76                   98 x 93.09
//   sprite rendered H     80.0                      98.0
//
//   THE FIX THIS FILE PINS:
//     hacker  restored to HEAD  -> .hacker-viewport width:100% => 191px
//     mascot  changed 112x98    -> 191 x 176.31px (±0.5 rounding band)
//     ratio   191/191 = 1.000   (was 112/191 = 0.586)
//
//   191 is the widest size BOTH can take: the button's content box is exactly
//   191px, so it fits with 0 to spare, and 191 is a fixed px (not a percentage)
//   so it cannot depend on the container and cannot overflow it. The mascot's
//   height preserves the viewBox aspect 130:120 exactly (191 * 120/130 =
//   176.3077px, round 176.31px) so the SVG scales uniformly.
//
// ───────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED, AND WHY IT IS NOT VACUOUS
// ───────────────────────────────────────────────────────────────────────────
// No jsdom and no @testing-library/react are installed, so this file asserts
// the stylesheet contract and derives the rendered boxes from the declared
// values plus the measured container chain. Every assertion below is a
// PROPERTY of the intended state, and the header documents that the WRONG
// attempt-2 numbers (112px column, 80x76 stage) violate them — verified by
// mutating the worktree, not by wishing it.
//
// The two invariants that actually encode the owner's decision:
//   1. `.hacker-viewport` declares `width: 100%` (it fills the button).
//   2. `.mascot-viewport`'s WIDTH is within 10% of the hacker's rendered width
//      (191px), i.e. comparable, and its rendered width never exceeds it.
// Attempt 2 fails (1) by construction; attempt 1 fails (2) by 41%.
// ───────────────────────────────────────────────────────────────────────────

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const CSS = 'src/renderer/pet/pet.css';
const WIDGET = 'src/renderer/pet/PetWidget.tsx';

// The sidebar chain, measured in the real Electron BrowserWindow (see header).
const SIDEBAR_W = 250; // Layout.tsx: `w-[250px]`
const GUTTER_PX = 20; // Layout.tsx: `px-5` (both sides)
const BUTTON_PAD = 8; // pet.css `.widget-btn { padding: 8px }`
const BUTTON_BORDER = 1; // pet.css `.widget-btn { border: 1px ... }`
const BUTTON_CONTENT_W = SIDEBAR_W - 2 * GUTTER_PX - 2 * (BUTTON_PAD + BUTTON_BORDER); // 191

// The mascot artwork's own coordinate system (PetWidget.tsx:674).
const MASCOT_VIEWBOX_W = 130;
const MASCOT_VIEWBOX_H = 120;

// The hacker sprite's backing store (PetWidget.tsx:1067).
const CANVAS_BACKING_W = 160;
const CANVAS_BACKING_H = 152;

/** The declaration block of the FIRST rule whose selector matches exactly. */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

/**
 * A declaration body with `/* ... *​/` comments blanked out.
 *
 * The heading comment of the fix explains the measurement inside the rule, and
 * `decl()` anchors every match on `(?:^|;)`. A declaration that follows a
 * comment has `*​/` before it, not `;`, so it would be invisible to a naive
 * parse ("width: 191px" right after the comment returned null). Comments are
 * parse-neutral to CSS, so remove them before reading properties.
 */
function code(body) {
  return body === null ? null : body.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Numeric value of `prop` in a declaration block, or null. */
function decl(body, prop) {
  const b = code(body);
  if (b === null) return null;
  const m = b.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?[0-9.]+)px`));
  return m ? Number(m[1]) : null;
}

/** Raw value of `prop` (any unit/keyword) in a declaration block, or null. */
function declRaw(body, prop) {
  const b = code(body);
  if (b === null) return null;
  const m = b.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
}

/** True if the declaration block declares `prop` at all (comments ignored). */
function hasDecl(body, prop) {
  const b = code(body);
  return b !== null && new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(b);
}

/** The `.widget-btn`'s measured-wide content box, in px. */
function buttonContentWidth(css) {
  const btn = ruleBody(css, '.nv-pet-wrap .widget-btn');
  const pad = decl(btn, 'padding') ?? BUTTON_PAD;
  const border = decl(btn, 'border') ?? BUTTON_BORDER;
  // Measured 209px wrap inside the 250px sidebar (see header) — derive that
  // from the layout chain rather than hard-coding 209, so a change to the
  // sidebar/gutter is caught rather than silently absorbed.
  const wrapW = SIDEBAR_W - 2 * GUTTER_PX;
  return wrapW - 2 * (pad + border);
}

/**
 * Rendered width of the hacker's column, in px, from the stylesheet + the
 * measured container chain. `width: 100%` resolves against the button's
 * content box (191px); anything else must be an explicit px.
 */
function hackerColumnWidth(css) {
  const viewport = ruleBody(css, '.nv-pet-wrap .hacker-viewport');
  const raw = declRaw(viewport, 'width');
  if (raw === null) return null;
  if (raw === '100%') return buttonContentWidth(css);
  if (/^-?[0-9.]+px$/.test(raw)) return Number.parseFloat(raw);
  return null;
}

test('the hacker column is restored to HEAD: it fills the button (width:100%)', () => {
  const css = read(CSS);
  const viewport = ruleBody(css, '.nv-pet-wrap .hacker-viewport');
  assert.ok(viewport, '.hacker-viewport must be defined');

  // THE owner-approved geometry. Attempt 1/2 replaced this with `112px` and
  // `margin: 0 auto`; both are wrong and must never come back.
  assert.match(
    viewport,
    /(?:^|;)\s*width\s*:\s*100%/,
    '.hacker-viewport must be width:100% (HEAD) — it fills the button content box, '
    + 'measured 191px. Shrinking it is what the owner rejected.',
  );
  assert.doesNotMatch(
    viewport,
    /(?:^|;)\s*width\s*:\s*[0-9.]+px/,
    '.hacker-viewport must not be pinned to a px width (that was attempt 1: 112px)',
  );
  assert.doesNotMatch(
    viewport,
    /(?:^|;)\s*margin\s*:\s*0\s+auto/,
    'the hacker column must fill its row, not be centred at a reduced width '
    + '(margin:0 auto was attempt 1)',
  );

  const columnW = hackerColumnWidth(css);
  assert.equal(
    columnW,
    BUTTON_CONTENT_W,
    `the hacker column must render at the button content box width `
    + `(${BUTTON_CONTENT_W}px) — derived ${columnW}px`,
  );
});

test('the mascot box is ENLARGED to a width comparable to the hacker column', () => {
  const css = read(CSS);
  const mascot = ruleBody(css, '.nv-pet-wrap .mascot-viewport');
  assert.ok(mascot, '.mascot-viewport must be defined');

  const w = decl(mascot, 'width');
  const h = decl(mascot, 'height');
  assert.ok(w !== null && h !== null, '.mascot-viewport must declare width and height');

  const hackerW = hackerColumnWidth(css);
  const ratio = w / hackerW;

  // The owner's two complaints, as numbers: 112/191 = 0.586 (too small),
  // the fix is 1.000. A 10% band around parity leaves room to nudge the height
  // or round the width without re-opening the defect.
  assert.ok(
    ratio >= 0.9 && ratio <= 1.1,
    `the mascot box width (${w}px) must be COMPARABLE to the hacker column `
    + `(${hackerW}px) — ratio ${ratio.toFixed(3)} must be 0.9..1.1. `
    + `(The too-small geometry was 112px = ${(112 / hackerW).toFixed(3)}.)`,
  );
  assert.ok(
    w <= hackerW,
    `the mascot box (${w}px) must never exceed the hacker column (${hackerW}px): `
    + `the button content box is exactly ${BUTTON_CONTENT_W}px, so anything wider `
    + `overflows the sidebar.`,
  );

  // Preserve the artwork's aspect ratio: the viewBox is 130:120, so the box
  // must be in that ratio or the SVG gets letterboxed/distorted. 0.5px of
  // rounding slack (176.31px is 191 * 120/130 = 176.3077 rounded).
  const boxRatio = w / h;
  const artRatio = MASCOT_VIEWBOX_W / MASCOT_VIEWBOX_H;
  assert.ok(
    Math.abs(boxRatio - artRatio) < 0.01,
    `the mascot box (${w}x${h} = ${boxRatio.toFixed(4)}) must keep the artwork's `
    + `viewBox aspect ${MASCOT_VIEWBOX_W}:${MASCOT_VIEWBOX_H} = ${artRatio.toFixed(4)} `
    + `so the SVG's preserveAspectRatio="xMidYMid meet" scale is uniform`,
  );

  // The round trip: what the browser actually renders the artwork at.
  const uniformScale = w / MASCOT_VIEWBOX_W;
  assert.ok(
    Math.abs(uniformScale - h / MASCOT_VIEWBOX_H) < 0.01,
    `uniform scale: width scale ${uniformScale.toFixed(5)} must equal height scale `
    + `${(h / MASCOT_VIEWBOX_H).toFixed(5)} (no non-uniform stretch)`,
  );
});

test('both pets fit the sidebar button with no overflow', () => {
  const css = read(CSS);
  const layout = read('src/renderer/components/Layout.tsx');

  // The container chain is measured, not assumed (see header): if the sidebar
  // or gutter changes, this test must be re-derived.
  assert.match(layout, /w-\[250px\]/, 'the sidebar must still be 250px (Layout.tsx)');
  assert.match(layout, /className="px-5 my-auto py-2 short:py-1"/, 'the pet gutter must still be px-5 (§12 adds short:py-1)');
  assert.match(
    ruleBody(css, '.nv-pet-wrap .widget-btn') ?? '',
    /padding:\s*8px/,
    'the widget button must still pad 8px',
  );

  const contentW = buttonContentWidth(css);
  assert.equal(contentW, BUTTON_CONTENT_W, 'the measured chain must reproduce 191px');

  // Hacker: proportional width, so it fills the box exactly and can never
  // overflow by construction.
  assert.equal(
    hackerColumnWidth(css),
    contentW,
    'the hacker column must fit the button content box exactly (0px to spare)',
  );

  // Mascot: a fixed px width, so it is this assertion, not the layout engine,
  // that keeps it inside the button.
  const mascotW = decl(ruleBody(css, '.nv-pet-wrap .mascot-viewport'), 'width');
  assert.ok(
    mascotW <= contentW,
    `the mascot box (${mascotW}px) must fit the ${contentW}px button content box`,
  );

  // Only ONE pet is in the DOM at a time (PetWidget.tsx renders the mascot for
  // character==='mascot' and the hacker otherwise), so the two never compete
  // for the same row. The widths may therefore both equal the content box.
  const widget = read(WIDGET);
  assert.match(widget, /character === 'mascot' \? \(/, 'the mascot branch must still be a ternary');
  assert.match(widget, /<div className="mascot-viewport">/, 'the mascot branch must mount .mascot-viewport');
  assert.match(widget, /<div className="hacker-viewport">/, 'the other branch must mount .hacker-viewport');
  assert.match(
    widget,
    /className="hacker-viewport"[\s\S]*?className="crt-casing"/,
    'the hacker branch must still open with the CRT casing',
  );
});

test('the hacker CRT geometry is restored to HEAD (casing / screen / stage / canvas / brand / jar)', () => {
  const css = read(CSS);
  const g = (sel) => ruleBody(css, sel);

  // HEAD values, verbatim from `git show HEAD:src/renderer/pet/pet.css`:
  //   .crt-screen  { position:relative; height:94px; ... }          (:1089-1099)
  //   .crt-term-line { position:absolute; top:4px; left/right:6px } (:1114-1128)
  //   .crt-brand   { justify-content:space-between; ... }           (:1144-1152)
  //   .hacker-stage { position:absolute; left:50%; bottom:0;
  //                   transform:translateX(-50%); width:80px; height:76px } (:1164-1172)
  //   .hacker-stage canvas { width:80px; height:76px; display:block; ... } (:1174-1180)
  //   .jar-box     { display:flex; align-items:center; gap:8px; padding:0 4px } (:1184-1188)
  assert.equal(decl(g('.nv-pet-wrap .crt-screen'), 'height'), 94,
    '.crt-screen must be back to height:94px (HEAD); `height:auto` was attempt 2');

  const screen = g('.nv-pet-wrap .crt-screen');
  assert.match(screen, /(?:^|;)\s*height\s*:\s*94px/, 'the screen height must be the hard 94px');
  assert.doesNotMatch(screen, /(?:^|;)\s*height\s*:\s*auto/, 'height:auto must be gone');

  const casing = g('.nv-pet-wrap .crt-casing');
  assert.doesNotMatch(casing, /overflow\s*:\s*hidden/,
    'HEAD has no overflow:hidden on the casing; `.crt-screen` already clips the sprite');

  const stage = g('.nv-pet-wrap .hacker-stage');
  assert.match(stage, /position\s*:\s*absolute/, 'HEAD pins the stage absolutely');
  assert.match(stage, /left\s*:\s*50%/, 'HEAD centres the stage with left:50%');
  assert.match(stage, /bottom\s*:\s*0/, 'HEAD pins the stage to the screen bottom');
  assert.match(stage, /transform\s*:\s*translateX\(-50%\)/, 'HEAD centres with translateX(-50%)');
  assert.equal(decl(stage, 'width'), 80, 'HEAD stage width is 80px (attempt 2: 100%)');
  assert.equal(decl(stage, 'height'), 76, 'HEAD stage height is 76px (attempt 2: auto)');

  const canvas = g('.nv-pet-wrap .hacker-stage canvas');
  assert.equal(decl(canvas, 'width'), 80, 'HEAD canvas width is 80px (attempt 2: 100%)');
  assert.equal(decl(canvas, 'height'), 76, 'HEAD canvas height is 76px (attempt 2: auto)');
  assert.match(canvas, /image-rendering\s*:\s*pixelated/, 'the pixel scaling must stay');

  const term = g('.nv-pet-wrap .crt-term-line');
  assert.match(term, /position\s*:\s*absolute/, 'HEAD pins the terminal line absolutely');
  assert.match(term, /top\s*:\s*4px/, 'HEAD terminal line is at top:4px');
  assert.match(term, /left\s*:\s*6px/, 'HEAD terminal line is inset 6px');
  assert.match(term, /right\s*:\s*6px/, 'HEAD terminal line is inset 6px');
  assert.doesNotMatch(term, /padding\s*:\s*[0-9.]+px/, 'HEAD terminal line carries no padding');

  assert.match(g('.nv-pet-wrap .crt-brand'), /justify-content\s*:\s*space-between/,
    'HEAD spreads the brand row edge to edge');
  assert.doesNotMatch(g('.nv-pet-wrap .crt-brand'), /(?:^|;)\s*gap\s*:/,
    'HEAD brand row has no gap (the gap came with justify-content:center in attempt 2)');

  const jarBox = code(g('.nv-pet-wrap .jar-box'));
  assert.doesNotMatch(jarBox, /(?:^|;)\s*width\s*:\s*100%/,
    'HEAD jar row is a flex row without a declared width');
  assert.doesNotMatch(jarBox, /(?:^|;)\s*justify-content\s*:/,
    'HEAD jar row keeps the default flex-start');
  assert.match(jarBox, /(?:^|;)\s*padding\s*:\s*0\s+4px/, 'HEAD jar row is `padding: 0 4px`');

  // Pet spec 2026-10-26 \u00a72.1/\u00a79.2: the jar text rows (.jar-title/.jar-subtitle)
  // are replaced by the activity caption. The row height stays fixed: the
  // caption box is a hard 30px (two 14px lines + 2px), so neither the jar nor a
  // caption change can resize the widget.
  for (const sel of ['.nv-pet-wrap .jar-title', '.nv-pet-wrap .jar-subtitle']) {
    assert.equal(g(sel), null, `${sel} must be removed (spec \u00a79.2)`);
  }
  assert.match(g('.nv-pet-wrap .pet-caption') ?? '', /(?:^|;)\s*height\s*:\s*30px/, 'the caption box is a fixed 30px');
  assert.match(g('.nv-pet-wrap .pet-caption-text') ?? '', /(?:^|;)\s*line-height\s*:\s*14px/, 'caption lines are 14px');
});

test('the hacker sprite keeps its rendered size and aspect (no distortion)', () => {
  const css = read(CSS);
  const widget = read(WIDGET);

  const attr = widget.match(/<canvas ref=\{canvasRef\} width=\{(\d+)\} height=\{(\d+)\} \/>/);
  assert.ok(attr, 'the hacker canvas backing store must be declared in the JSX');
  const [bw, bh] = [Number(attr[1]), Number(attr[2])];
  assert.equal(bw, CANVAS_BACKING_W, `the canvas backing width must stay ${CANVAS_BACKING_W}`);
  assert.equal(bh, CANVAS_BACKING_H, `the canvas backing height must stay ${CANVAS_BACKING_H}`);

  const stage = ruleBody(css, '.nv-pet-wrap .hacker-stage');
  const canvas = ruleBody(css, '.nv-pet-wrap .hacker-stage canvas');
  const stageW = decl(stage, 'width');
  const stageH = decl(stage, 'height');
  const canvasW = decl(canvas, 'width');
  const canvasH = decl(canvas, 'height');

  // The CSS box must be a uniform downscale of the backing store: rendered
  // aspect == backing aspect => the pixel art is not squashed.
  assert.equal(canvasW, stageW, 'the canvas must fill its stage horizontally');
  assert.equal(canvasH, stageH, 'the canvas must fill its stage vertically');
  assert.ok(
    Math.abs(canvasW / canvasH - bw / bh) < 1e-9,
    `the rendered box (${canvasW}x${canvasH} = ${(canvasW / canvasH).toFixed(5)}) must `
    + `equal the backing aspect (${bw}:${bh} = ${(bw / bh).toFixed(5)})`,
  );

  // And the visual height the sprite is actually drawn at, from the CSS box
  // plus the CSS-pixel backing ratio (80/160 = 0.5 => 76 / 152 = 0.5).
  const scale = canvasW / bw;
  assert.ok(
    Math.abs(scale - canvasH / bh) < 1e-9,
    `the uniform scale must be ${(scale).toFixed(4)} in both axes `
    + `(${(canvasW / bw).toFixed(4)} x vs ${(canvasH / bh).toFixed(4)} y)`,
  );
  assert.equal(
    canvasH * scale,
    canvasH * (canvasH / bh),
    'arithmetic self-check for the derived sprite height',
  );
});

test('the artwork itself is unchanged by the sizing fix', () => {
  const css = read(CSS);
  const widget = read(WIDGET);

  // The fix is presentation-only: the mascot artwork, the canvas backing store
  // and the drawing code must all be exactly as before.
  assert.match(
    css,
    /\.nv-pet-wrap \.mascot-svg\s*\{[^}]*width:\s*92%[^}]*height:\s*92%/,
    'the robot SVG is 92% x 92% of its unchanged box (owner 30.09: shrink the robot, not the frame)',
  );
  assert.match(widget, /viewBox="0 0 130 120"/, 'the mascot artwork viewBox must be untouched');
  assert.match(
    widget,
    /<canvas ref=\{canvasRef\} width=\{160\} height=\{152\} \/>/,
    'the hacker canvas backing store must be untouched (160x152)',
  );
  assert.match(widget, /private readonly width = 160;/, 'renderer width must stay 160');
  assert.match(widget, /private readonly height = 152;/, 'renderer height must stay 152');

  // The sizing fix must not touch the SVG's own box-fitting either.
  assert.doesNotMatch(
    ruleBody(css, '.nv-pet-wrap .mascot-svg') ?? '',
    /preserveAspectRatio\s*:/,
    'the artwork must keep its default preserveAspectRatio="xMidYMid meet" '
    + '(adding one would mean the box aspect drifted)',
  );

  // And the fix must not declare a new hard size on the canvas other than the
  // HEAD 80x76 — the backing store is the only place a canvas size belongs.
  assert.doesNotMatch(
    ruleBody(css, '.nv-pet-wrap .hacker-stage canvas') ?? '',
    /(?:^|;)\s*(?:width|height)\s*:\s*(?:auto|100%)/,
    'the canvas must not be sized by its container either (that was attempt 2)',
  );
});
