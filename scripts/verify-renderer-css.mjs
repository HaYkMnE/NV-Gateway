import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rendererDirectory = path.resolve(process.cwd(), 'build', 'renderer');
const expectedColors = ['#060706', '#0D110E', '#76B900', '#F0F4F1', '#809285', '#FF3333'];
const expectedSelectors = ['bg-nvidia', 'bg-surface', 'text-textMuted', 'border-border', 'glow-red'];

function hexToRgb(color) {
  const hexadecimal = color.slice(1);
  return [0, 2, 4].map((offset) => Number.parseInt(hexadecimal.slice(offset, offset + 2), 16));
}

function hasGeneratedColor(css, color) {
  if (css.includes(color.toLowerCase())) {
    return true;
  }

  const [red, green, blue] = hexToRgb(color);
  const rgbPattern = new RegExp(
    `rgb\\(\\s*${red}(?:\\s*,\\s*|\\s+)${green}(?:\\s*,\\s*|\\s+)${blue}(?=\\s*(?:[,/)]))`,
  );

  if (rgbPattern.test(css)) {
    return true;
  }

  // Tailwind/CSSO minify a 6-digit hex whose channel pairs repeat (e.g.
  // #FF3333) into its 3-digit shorthand (#f33). Treat the shorthand as equal
  // to the full token color so token-derived rules are recognized.
  const rr = color.slice(1, 3).toLowerCase();
  const gg = color.slice(3, 5).toLowerCase();
  const bb = color.slice(5, 7).toLowerCase();
  if (rr[0] === rr[1] && gg[0] === gg[1] && bb[0] === bb[1]) {
    const shorthand = `#${rr[0]}${gg[0]}${bb[0]}`;
    if (css.includes(shorthand)) {
      return true;
    }
  }

  return false;
}

// Extracts the declaration block of a given selector (e.g. ".glow-red{...}")
// from normalized lowercase CSS. Returns null when the rule is absent. Used to
// prove a utility rule derives its color from a palette token (the rule body
// must carry the token's compiled color), not merely that the selector name
// survived the build.
function extractRule(css, selector) {
  const dotSelector = selector.startsWith('.') ? selector : `.${selector}`;
  const start = css.indexOf(dotSelector.toLowerCase());
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  return null;
}

async function findCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return findCssFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.css') ? [entryPath] : [];
  }));

  return files.flat();
}

function decodeCssEscapes(css) {
  return css.replace(/\\([\da-fA-F]{1,6}\s?|.)/g, (_match, escape) => {
    const hexadecimal = escape.match(/^([\da-fA-F]{1,6})\s?$/);
    return hexadecimal ? String.fromCodePoint(Number.parseInt(hexadecimal[1], 16)) : escape;
  });
}

async function main() {
  let cssFiles;

  try {
    cssFiles = await findCssFiles(rendererDirectory);
  } catch (error) {
    console.error(`CSS regression guard failed: unable to inspect ${rendererDirectory}.`);
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (cssFiles.length === 0) {
    console.error(`CSS regression guard failed: no CSS files found under ${rendererDirectory}.`);
    process.exitCode = 1;
    return;
  }

  const generatedCss = (await Promise.all(cssFiles.map((file) => readFile(file, 'utf8')))).join('\n');
  const normalizedCss = decodeCssEscapes(generatedCss).toLowerCase();
  const missingColors = expectedColors.filter((color) => !hasGeneratedColor(normalizedCss, color));
  const missingSelectors = expectedSelectors.filter((selector) => !normalizedCss.includes(`.${selector.toLowerCase()}`));
  // The .glow-red utility must derive its box-shadow color from the error
  // palette token (mirrors how :focus-visible uses theme('colors.accent-neon')).
  // Assert the built .glow-red rule body carries the error color in any
  // compiled form (raw hex, shorthand hex, or rgb()), so a source that embeds
  // a different literal color — or drops the color entirely — fails the guard.
  const errorColor = '#FF3333';
  const glowRedRule = extractRule(normalizedCss, 'glow-red');
  const glowRedCarriesErrorToken = glowRedRule !== null && hasGeneratedColor(glowRedRule, errorColor);

  if (missingColors.length > 0 || missingSelectors.length > 0 || !glowRedCarriesErrorToken) {
    console.error('CSS regression guard failed.');
    console.error(`Inspected: ${cssFiles.map((file) => path.relative(process.cwd(), file)).join(', ')}`);
    if (missingColors.length > 0) {
      console.error(`Missing semantic colors: ${missingColors.join(', ')}`);
    }
    if (missingSelectors.length > 0) {
      console.error(`Missing generated selectors: ${missingSelectors.join(', ')}`);
    }
    if (!glowRedCarriesErrorToken) {
      console.error(`.glow-red rule does not derive its color from the error token (${errorColor}).`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`CSS regression guard passed: ${cssFiles.length} generated CSS file(s) contain all semantic colors and selectors.`);
  console.log(`Colors: ${expectedColors.join(', ')}`);
  console.log(`Selectors: ${expectedSelectors.map((selector) => `.${selector}`).join(', ')}`);
  console.log(`Token-derived utility: .glow-red => error (${errorColor}).`);
}

await main();
