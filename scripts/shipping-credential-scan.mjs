import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Declared explicitly in devDependencies at the version already resolved in the
// tree (4.3.0), so this guard never depends on electron-builder continuing to
// pull js-yaml in transitively — and so no second copy appears.
import yaml from 'js-yaml';

export const DENIED_CREDENTIAL_LITERALS = [
  'test-gateway-token',
  'test-admin-token',
  'fake-nvidia-key-not-real',
  'fake-gateway-token-not-real',
  'fake-admin-token-not-real'
];

const EXPECTED_FILES_RULES = [
  'build/src/main/**/*',
  'build/src/test-support/**/*',
  '!build/src/test-support/**/*',
  'build/src/preload/**/*',
  'build/renderer/**/*',
  // The engine bundle moved INTO app.asar so ASAR integrity validation covers
  // it; it used to be an extraResource, i.e. outside the integrity envelope.
  'build/gateway/**/*',
  'package.json',
  // Deliberate, reviewed addition (source-map exclusion, shipped-size work):
  // a pure NEGATION, so it adds no payload root and the scanned roots below
  // are unchanged. It also filters the collected production node_modules —
  // electron-builder applies the main matcher's patterns to them
  // (app-builder-lib/out/util/appFileCopier.js:168-170).
  '!**/*.map'
];
// Only inert image assets ship OUTSIDE app.asar now. The engine bundle moved into
// the archive (see EXPECTED_FILES_RULES) so ASAR integrity validation covers it,
// and src/shared is not shipped at all — redaction.mjs is inlined into the bundle.
// Nothing executable is left in resources/.
const EXPECTED_EXTRA_RESOURCE_RULES = [
  'build/assets -> assets'
];

export function runShippingCredentialScan({
  root = path.resolve(import.meta.dirname, '..'),
  readFile = fs.readFileSync,
  afterSnapshot = () => {}
} = {}) {
  const scannedRoots = deriveScannedRoots(root);
  const files = collectRegularFiles(root, scannedRoots);
  const snapshots = files.map((file) => {
    const content = Buffer.from(readFile(file));
    return { file, content, sha256: sha256(content) };
  });
  afterSnapshot();

  let matchCount = 0;
  for (const { content } of snapshots) {
    for (const literal of DENIED_CREDENTIAL_LITERALS) {
      if (content.includes(Buffer.from(literal, 'utf8'))) matchCount += 1;
    }
  }
  assert.equal(matchCount, 0, 'SHIPPING_CREDENTIAL_LITERAL_FOUND');

  for (const snapshot of snapshots) {
    if (sha256(Buffer.from(readFile(snapshot.file))) !== snapshot.sha256) {
      throw new Error('SHIPPING_CREDENTIAL_SCAN_CHANGED');
    }
  }
  return {
    scannedRoots,
    scannedFileCount: snapshots.length,
    testSupportExcluded: true
  };
}

export function deriveScannedRoots(root) {
  // FIRST: prove electron-builder will actually READ the file we are about to
  // audit. Everything below is worthless if the config arrives from elsewhere.
  assertConfigSourceIsAuthoritative(root);
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assertArchiveEnvelopeIsSealed(builder);
  assert.deepEqual(extractListSection(builder, 'files'), EXPECTED_FILES_RULES, 'PACKAGING_FILES_RULES_CHANGED');
  assert.deepEqual(extractExtraResources(builder), EXPECTED_EXTRA_RESOURCE_RULES, 'PACKAGING_EXTRA_RESOURCES_RULES_CHANGED');
  const roots = [
    'build/src/main', 'build/src/preload', 'build/renderer', 'package.json',
    'build/gateway', 'build/assets'
  ];
  for (const relative of roots) assert.equal(fs.existsSync(path.join(root, relative)), true, `PACKAGING_PAYLOAD_MISSING:${relative}`);
  return roots;
}

// Every packaging assertion in this file reads electron-builder.yml. That is only
// meaningful while electron-builder ITSELF reads that same file — and two edits can
// silently redirect it, leaving the audit green while auditing an inert document.
//
// READ FROM THE DEPENDENCY, not assumed:
//
//   read-config-file/out/main.js:71-72
//     const data = packageMetadata == null ? null : packageMetadata[request.packageKey];
//     return data == null ? findAndReadConfig(request) : { result: data, configFile: null };
//
//   app-builder-lib/out/util/config.js:35
//     { packageKey: "build", configFilename: "electron-builder", ... }
//
// So a TOP-LEVEL `build` field in package.json short-circuits the whole lookup:
// findAndReadConfig is never called and electron-builder.yml is never opened. This
// does not bypass one rule — it disables the entire first layer at once.
//
//   read-config-file/out/main.js:42
//     for (const configFile of [`${prefix}.yml`, `${prefix}.yaml`, `${prefix}.json`,
//       `${prefix}.json5`, `${prefix}.toml`, `${prefix}.js`, `${prefix}.cjs`, `${prefix}.ts`])
//
// The loop returns the FIRST file that exists. `.yml` happens to be first, so a
// competing sibling is latent rather than active today — it takes over the moment
// the .yml is renamed or removed. Same class of defect, so it is refused too.
// (Note: `.mjs` is NOT in that list; the extensions below are copied from it
// verbatim rather than guessed, so this guard cannot drift from the real lookup.)
const CONFIG_BASENAME = 'electron-builder';
const AUTHORITATIVE_CONFIG_FILE = `${CONFIG_BASENAME}.yml`;
/** Extensions read-config-file probes, in its own precedence order. */
const CONFIG_LOOKUP_EXTENSIONS = Object.freeze(['yml', 'yaml', 'json', 'json5', 'toml', 'js', 'cjs', 'ts']);
/** The package.json field that, when present, replaces the file lookup entirely. */
const CONFIG_PACKAGE_KEY = 'build';

const CONFIG_SOURCE_REMEDY = `electron-builder resolves its config as: package.json#${CONFIG_PACKAGE_KEY} FIRST, and only if that is absent does it search ${CONFIG_LOOKUP_EXTENSIONS.map((extension) => `${CONFIG_BASENAME}.${extension}`).join(', ')} and take the first hit. Either edit therefore makes ${AUTHORITATIVE_CONFIG_FILE} — and every packaging assertion in this file, including the files/extraResources rules and the asar guard — silently inert while still passing. If the config source is being changed deliberately, that is a decision to make explicitly: update assertConfigSourceIsAuthoritative in scripts/shipping-credential-scan.mjs to audit the NEW source, and add a targeted test proving the engine still ships as a single entry inside app.asar.`;

/**
 * Refuse any arrangement in which electron-builder would not read
 * {@link AUTHORITATIVE_CONFIG_FILE}.
 *
 * @param {string} root Project root.
 * @returns {void}
 */
export function assertConfigSourceIsAuthoritative(root) {
  // The audited file must itself exist — otherwise the lookup falls through to a
  // sibling extension and the assertions below would read nothing at all.
  assert.equal(
    fs.existsSync(path.join(root, AUTHORITATIVE_CONFIG_FILE)),
    true,
    `PACKAGING_CONFIG_SOURCE_MISSING:${AUTHORITATIVE_CONFIG_FILE}. ${CONFIG_SOURCE_REMEDY}`
  );

  // 1. package.json#build wins over every file, so its mere PRESENCE is the
  //    defect — an empty object or a string path hijacks the lookup just as a
  //    populated object does. Only the top level counts: `scripts.build` is a
  //    normal npm script and must not trip this.
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    assert.fail(`PACKAGING_MANIFEST_UNPARSEABLE:${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}`);
  }
  assert.ok(
    manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest),
    'PACKAGING_MANIFEST_NOT_A_MAPPING'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(manifest, CONFIG_PACKAGE_KEY),
    false,
    `PACKAGING_CONFIG_SOURCE_HIJACKED:package.json#${CONFIG_PACKAGE_KEY}. ${CONFIG_SOURCE_REMEDY}`
  );

  // 2. No competing sibling config may sit next to the authoritative one.
  const competing = CONFIG_LOOKUP_EXTENSIONS
    .map((extension) => `${CONFIG_BASENAME}.${extension}`)
    .filter((name) => name !== AUTHORITATIVE_CONFIG_FILE && fs.existsSync(path.join(root, name)));
  assert.deepEqual(
    competing,
    [],
    `PACKAGING_CONFIG_SOURCE_HIJACKED:${competing.join(',')}. ${CONFIG_SOURCE_REMEDY}`
  );
}

// The engine bundle ships INSIDE app.asar so ASAR integrity validation covers it.
// Two config knobs can silently undo that, putting the engine back OUTSIDE the
// integrity envelope while every other packaged audit stays green:
//
//   asarUnpack: <pattern>  copies matching entries to app.asar.unpacked/ and
//                          loads them from there. A pattern reaching the engine
//                          yields resources/app.asar.unpacked/build/gateway/server.mjs
//                          — a loose file on disk that can be swapped undetected.
//   asar: false            disables archiving entirely, so the whole app (engine
//                          included) ships as loose files. Only `asar` and
//                          `asarUnpack` exist in the app-builder-lib schema, so
//                          these two knobs are the complete surface.
//
// MEASURED, which is why the guard lives HERE: with `asarUnpack` present the
// packaged migration / gateway-link / credential smokes all still exit 0. Only
// the dist-gated bundle-shipping test noticed it, and that test SKIPS in CI. This
// function runs from tests/shipping-credential-literals.test.mjs with no dist
// gate, so it is on the path that actually executes in the ordinary Test Suite.
//
// DELIBERATELY ABSOLUTE — no pattern matching. Any asarUnpack rule is rejected,
// not only ones that look like they hit the engine: a matcher would have to
// out-guess electron-builder's own glob semantics (`build/gateway/**`, `build/**`,
// `**` + `/*.mjs`, `**` + `/gateway/**` all reach it), and one missed form
// silently reopens the hole. Needing asarUnpack later therefore demands an
// explicit, reviewed edit of this guard — that is the intent, not an obstacle.
//
// DETECTED BY PARSING, NOT BY LINE MATCHING. The previous implementation tested
// `^\s*asarUnpack\s*:` per line, which only ever saw an UNQUOTED block-style key.
// Six equivalent YAML spellings slipped past it silently while js-yaml — the very
// parser electron-builder reads the config with — resolved every one of them:
//   "asarUnpack": [...]        quoted key
//   'asarUnpack': [...]        single-quoted key
//   ? asarUnpack / : [...]     explicit key syntax
//   win: {asarUnpack: [...]}   flow mapping
//   "asarUnpack": nested       quoted key inside a platform block
//   "asar": false              quoted key for the archive switch
// So the guard now loads the document and walks the resulting object. Anything
// js-yaml resolves to one of these keys is caught regardless of how it was
// written, comments included — the parser discards those on its own, which is why
// the old stripYamlComments helper is gone.
const ARCHIVE_UNPACK_KEYS = Object.freeze(['asarUnpack', 'asarUnpacked']);

const UNPACK_REMEDY = 'Unpacking copies entries to app.asar.unpacked/, i.e. OUTSIDE the ASAR integrity envelope, where the engine bundle could be swapped undetected. If an unpack rule is genuinely needed — the canonical case is a native .node addon that cannot be loaded from inside an archive — treat it as a deliberate decision: narrow ARCHIVE_UNPACK_KEYS in scripts/shipping-credential-scan.mjs and add a targeted test proving build/gateway/server.mjs is still a single entry inside app.asar.';

const ASAR_REMEDY = `Archiving must stay on: with it off the whole app, engine included, ships as loose files with no integrity coverage. Only the literal value true is accepted — an AsarOptions mapping is refused too, because options such as smartUnpack unpack files as well. ${UNPACK_REMEDY}`;

/**
 * Reject any packaging rule able to place the engine outside app.asar.
 *
 * Parses the document and inspects EVERY mapping at EVERY depth: `asarUnpack` is
 * equally valid at the top level and inside the platform blocks (win:, nsis:, …).
 *
 * @param {string} builder Raw electron-builder.yml contents.
 * @returns {void}
 */
export function assertArchiveEnvelopeIsSealed(builder) {
  const config = parseBuilderConfig(builder);

  for (const { key, value, path: where } of walkMappings(config)) {
    if (ARCHIVE_UNPACK_KEYS.includes(key)) {
      assert.fail(`PACKAGING_ASAR_UNPACK_FORBIDDEN:${key} at ${where}. ${UNPACK_REMEDY}`);
    }
    // `asar` may be absent (electron-builder defaults it to true) but must never
    // be anything other than the literal true. Strict equality is what makes the
    // YAML truthiness zoo — false/False/FALSE plus the strings "no"/"off"/0 that
    // js-yaml 4 no longer coerces to booleans — collapse into one rejected case.
    if (key === 'asar' && value !== true) {
      assert.fail(`PACKAGING_ASAR_MUST_STAY_ENABLED:${describeValue(value)} at ${where}. ${ASAR_REMEDY}`);
    }
  }
}

/**
 * Load the config, failing CLOSED: an unparseable or non-mapping document must
 * never be read as "no forbidden keys found".
 *
 * @param {string} builder
 * @returns {Record<string, unknown>}
 */
function parseBuilderConfig(builder) {
  let config;
  try {
    config = yaml.load(builder, { filename: 'electron-builder.yml' });
  } catch (error) {
    assert.fail(`PACKAGING_CONFIG_UNPARSEABLE:${error instanceof Error ? error.message.split('\n')[0] : 'unknown'}`);
  }
  assert.ok(
    config !== null && typeof config === 'object' && !Array.isArray(config),
    'PACKAGING_CONFIG_NOT_A_MAPPING'
  );
  return config;
}

/**
 * Yield every mapping key in the document, depth first, with a readable path.
 *
 * Cycle-guarded: YAML anchors and aliases can produce a self-referential graph,
 * and a security guard must not be turned into an infinite loop by a config.
 *
 * @param {unknown} node
 * @param {string[]} [trail]
 * @param {WeakSet<object>} [seen]
 * @returns {Generator<{ key: string, value: unknown, path: string }>}
 */
function* walkMappings(node, trail = [], seen = new WeakSet()) {
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      yield* walkMappings(node[index], [...trail, `[${index}]`], seen);
    }
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const here = [...trail, key];
    yield { key, value, path: formatPath(here) };
    yield* walkMappings(value, here, seen);
  }
}

function formatPath(trail) {
  return trail.reduce((accumulator, segment) => {
    if (segment.startsWith('[')) return `${accumulator}${segment}`;
    return accumulator ? `${accumulator}.${segment}` : segment;
  }, '') || '(root)';
}

function describeValue(value) {
  if (value === undefined) return '(empty)';
  try {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return '(unserializable)';
  }
}

function extractListSection(builder, section) {
  const match = builder.match(new RegExp(`^${section}:\\r?\\n([\\s\\S]*?)(?=^[A-Za-z][^:\\r\\n]*:|(?![\\s\\S]))`, 'm'));
  assert.notEqual(match, null, `PACKAGING_SECTION_MISSING:${section}`);
  return match[1].split(/\r?\n/)
    .map((line) => line.match(/^  -\s+"?(.+?)"?\s*$/)?.[1])
    .filter((value) => value !== undefined);
}

function extractExtraResources(builder) {
  const match = builder.match(/^extraResources:\r?\n([\s\S]*?)(?=^[A-Za-z][^:\r\n]*:|(?![\s\S]))/m);
  assert.notEqual(match, null, 'PACKAGING_SECTION_MISSING:extraResources');
  const resources = [];
  let from = null;
  for (const line of match[1].split(/\r?\n/)) {
    const fromMatch = line.match(/^  - from:\s+(.+)$/);
    if (fromMatch) { from = fromMatch[1]; continue; }
    const toMatch = line.match(/^    to:\s+(.+)$/);
    if (toMatch && from !== null) { resources.push(`${from} -> ${toMatch[1]}`); from = null; }
  }
  return resources;
}

function collectRegularFiles(root, roots) {
  const files = [];
  for (const relative of roots) visit(path.join(root, relative));
  return files.sort((left, right) => left.localeCompare(right));

  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isFile()) { files.push(file); return; }
    assert.equal(stat.isDirectory(), true, `PACKAGING_PAYLOAD_NOT_REGULAR:${path.relative(root, file)}`);
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) visit(path.join(file, entry.name));
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = runShippingCredentialScan();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SHIPPING_CREDENTIAL_SCAN_FAILED');
    process.exitCode = 1;
  }
}
