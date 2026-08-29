import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPackage, uncacheAll } from '@electron/asar';
import { linkPackagedGatewayModules, runPackagedGatewayLinkSmoke } from '../scripts/packaged-gateway-link-smoke.mjs';

const fixturePrefix = `nvgw-packaged-gateway-link-${process.pid}-`;
const sandboxRoot = 'C:\\OPENCODE-SANDBOX';
const fixtureRoots = new Set();

function isFixtureOwnedRoot(directory) {
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(sandboxRoot, resolvedDirectory);
  return relative !== ''
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
    && path.dirname(relative) === '.'
    && path.basename(resolvedDirectory).startsWith(fixturePrefix)
    && fixtureRoots.has(resolvedDirectory);
}

function createFixture() {
  assert.equal(fs.existsSync(sandboxRoot), true, `Missing approved sandbox root: ${sandboxRoot}`);
  const directory = fs.mkdtempSync(path.join(sandboxRoot, fixturePrefix));
  fixtureRoots.add(path.resolve(directory));
  return directory;
}

function removeFixture(directory) {
  const resolvedDirectory = path.resolve(directory);
  if (!isFixtureOwnedRoot(resolvedDirectory)) {
    throw new Error('Refusing to clean an unregistered test fixture root.');
  }

  try {
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  } finally {
    fixtureRoots.delete(resolvedDirectory);
  }
}

function createLinkOnlyTestModule(source, { identifier }) {
  return {
    identifier,
    status: 'unlinked',
    async link(resolve) {
      if (this.status === 'linked' || this.status === 'linking') return;
      this.status = 'linking';
      const imports = [...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g)];
      for (const [, specifier] of imports) {
        const dependency = await resolve(specifier, this);
        await dependency.link(resolve);
      }
      this.status = 'linked';
    }
  };
}

test('fixture cleanup refuses an unregistered path even when it has the process fixture prefix', () => {
  assert.equal(fs.existsSync(sandboxRoot), true, `Missing approved sandbox root: ${sandboxRoot}`);
  const unregistered = fs.mkdtempSync(path.join(sandboxRoot, fixturePrefix));
  try {
    assert.throws(
      () => removeFixture(unregistered),
      /Refusing to clean an unregistered test fixture root\./
    );
  } finally {
    fs.rmSync(unregistered, { recursive: true, force: true });
  }
});

test('package graph audit rejects a dependency whose canonical path escapes resources', async () => {
  const fixture = createFixture();
  const gateway = path.join(fixture, 'dist', 'win-unpacked', 'resources', 'gateway');
  const dependency = path.join(gateway, 'dependency.mjs');
  const outsideDependency = path.join(fixture, 'outside-resources.mjs');
  try {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'server.mjs'), 'import "./dependency.mjs";\n', 'utf8');
    fs.writeFileSync(dependency, 'export const dependency = true;\n', 'utf8');
    fs.writeFileSync(outsideDependency, 'export const outside = true;\n', 'utf8');

    await assert.rejects(
      linkPackagedGatewayModules(path.join(gateway, 'server.mjs'), {
        sourceTextModuleFactory: createLinkOnlyTestModule,
        fileSystem: {
          lstatSync: fs.lstatSync,
          statSync: fs.statSync,
          readFileSync: fs.readFileSync,
          openSync: fs.openSync,
          fstatSync: fs.fstatSync,
          readSync: fs.readSync,
          closeSync: fs.closeSync,
          realpathSync(filePath) {
            return path.resolve(filePath) === path.resolve(dependency)
              ? outsideDependency
              : fs.realpathSync(filePath);
          }
        }
      }),
      /PACKAGED_GATEWAY_IMPORT_CANONICAL_OUTSIDE_RESOURCES/
    );
  } finally {
    removeFixture(fixture);
  }
});

test('package graph audit rejects a dependency reported as a reparse point', async () => {
  const fixture = createFixture();
  const gateway = path.join(fixture, 'dist', 'win-unpacked', 'resources', 'gateway');
  const dependency = path.join(gateway, 'dependency.mjs');
  try {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'server.mjs'), 'import "./dependency.mjs";\n', 'utf8');
    fs.writeFileSync(dependency, 'export const dependency = true;\n', 'utf8');

    await assert.rejects(
      linkPackagedGatewayModules(path.join(gateway, 'server.mjs'), {
        sourceTextModuleFactory: createLinkOnlyTestModule,
        fileSystem: {
          lstatSync(filePath) {
            const source = fs.lstatSync(filePath);
            return path.resolve(filePath) === path.resolve(dependency)
              ? { ...source, isSymbolicLink: () => true }
              : source;
          },
          statSync: fs.statSync,
          readFileSync: fs.readFileSync,
          openSync: fs.openSync,
          fstatSync: fs.fstatSync,
          readSync: fs.readSync,
          closeSync: fs.closeSync,
          realpathSync: fs.realpathSync
        }
      }),
      /PACKAGED_GATEWAY_IMPORT_REPARSE_POINT/
    );
  } finally {
    removeFixture(fixture);
  }
});

test('TOCTOU: rejects replacement observed between path validation and descriptor byte read without compiling replacement bytes', async () => {
  const fixture = createFixture();
  const gateway = path.join(fixture, 'dist', 'win-unpacked', 'resources', 'gateway');
  const server = path.join(gateway, 'server.mjs');
  const dependency = path.join(gateway, 'dependency.mjs');
  const originalSource = 'export const source = "original";\n';
  const replacementSource = 'export const source = "REPLACEMENT_BYTES_MUST_NOT_REACH_FACTORY";\n';
  let phase = 'original';
  const factorySources = [];
  const originalMetadata = { dev: 1, ino: 11, size: Buffer.byteLength(originalSource), isFile: () => true, isSymbolicLink: () => false };
  const replacementMetadata = { dev: 1, ino: 22, size: Buffer.byteLength(replacementSource), isFile: () => true, isSymbolicLink: () => false };
  try {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(server, 'import "./dependency.mjs";\n', 'utf8');
    fs.writeFileSync(dependency, originalSource, 'utf8');

    const fileSystem = {
      lstatSync(filePath) {
        if (path.resolve(filePath) === path.resolve(dependency)) return phase === 'original' ? originalMetadata : replacementMetadata;
        return fs.lstatSync(filePath);
      },
      statSync(filePath) {
        if (path.resolve(filePath) === path.resolve(dependency)) return phase === 'original' ? originalMetadata : replacementMetadata;
        return fs.statSync(filePath);
      },
      realpathSync: fs.realpathSync,
      readFileSync(filePath) {
        if (path.resolve(filePath) === path.resolve(dependency)) {
          phase = 'replacement';
          return replacementSource;
        }
        return fs.readFileSync(filePath, 'utf8');
      },
      openSync(filePath, flags) {
        if (path.resolve(filePath) !== path.resolve(dependency)) return fs.openSync(filePath, flags);
        assert.equal(flags, 'r');
        return 73;
      },
      fstatSync(fileDescriptor) {
        return fileDescriptor === 73 ? originalMetadata : fs.fstatSync(fileDescriptor);
      },
      readSync(fileDescriptor, buffer, offset, length) {
        if (fileDescriptor !== 73) return fs.readSync(fileDescriptor, buffer, offset, length);
        phase = 'replacement';
        return Buffer.from(replacementSource).copy(buffer, offset, 0, length);
      },
      closeSync(fileDescriptor) {
        if (fileDescriptor !== 73) fs.closeSync(fileDescriptor);
      }
    };

    await assert.rejects(
      linkPackagedGatewayModules(server, {
        fileSystem,
        sourceTextModuleFactory(source, options) {
          factorySources.push(source);
          return createLinkOnlyTestModule(source, options);
        }
      }),
      /PACKAGED_GATEWAY_IMPORT_IDENTITY_CHANGED/
    );
    assert.equal(factorySources.includes(replacementSource), false);
  } finally {
    removeFixture(fixture);
  }
});

function createCycleFixture() {
  const fixture = createFixture();
  const gateway = path.join(fixture, 'dist', 'win-unpacked', 'resources', 'gateway');
  const server = path.join(gateway, 'server.mjs');
  const aliasA = path.join(gateway, 'alias-a.mjs');
  const aliasB = path.join(gateway, 'alias-b.mjs');
  const shared = path.join(gateway, 'shared.mjs');
  const cycleB = path.join(gateway, 'cycle-b.mjs');
  fs.mkdirSync(gateway, { recursive: true });
  fs.writeFileSync(server, 'import "./alias-a.mjs";\nimport "./alias-b.mjs";\nexport const entry = true;\n', 'utf8');
  fs.writeFileSync(aliasA, 'import "./cycle-b.mjs";\nexport const aliasA = true;\n', 'utf8');
  fs.writeFileSync(aliasB, 'import "./cycle-b.mjs";\nexport const aliasB = true;\n', 'utf8');
  fs.writeFileSync(shared, 'import "./cycle-b.mjs";\nexport const shared = true;\n', 'utf8');
  fs.writeFileSync(cycleB, 'import "./alias-a.mjs";\nexport const cycleB = true;\n', 'utf8');
  return { fixture, gateway, server, aliasA, aliasB, shared, cycleB };
}

test('RED identity seam: a non-canonical alias resolver duplicates an ESM cycle module identity', async () => {
  const { fixture, server, aliasA, aliasB, shared } = createCycleFixture();
  const identifiers = [];
  try {
    const proof = await linkPackagedGatewayModules(server, {
      fileSystem: {
        ...fs,
        realpathSync(filePath) {
          const resolved = path.resolve(filePath);
          return resolved === path.resolve(aliasA) || resolved === path.resolve(aliasB)
            ? resolved
            : fs.realpathSync(filePath);
        }
      },
      sourceTextModuleFactory(source, options) {
        identifiers.push(options.identifier);
        return createLinkOnlyTestModule(source, options);
      }
    });
    assert.equal(proof.linked, true);
    assert.equal(proof.evaluated, false);
    assert.equal(proof.moduleCount, 4);
    assert.equal(identifiers.filter((identifier) => identifier === pathToFileURL(shared).href).length, 0);
    assert.equal(identifiers.filter((identifier) => identifier === pathToFileURL(aliasA).href).length, 1);
    assert.equal(identifiers.filter((identifier) => identifier === pathToFileURL(aliasB).href).length, 1);
    console.log('PACKAGED_GATEWAY_LINK_IDENTITY_RED nonCanonicalAliasModules=2 moduleCount=4 evaluationSkipped=true');
  } finally {
    removeFixture(fixture);
  }
});

test('canonical aliases share exactly one module identity in a static ESM cycle without evaluation', async () => {
  const { fixture, server, aliasA, aliasB, shared } = createCycleFixture();
  const identifiers = [];
  try {
    const proof = await linkPackagedGatewayModules(server, {
      fileSystem: {
        ...fs,
        realpathSync(filePath) {
          const resolved = path.resolve(filePath);
          return resolved === path.resolve(aliasA) || resolved === path.resolve(aliasB)
            ? shared
            : fs.realpathSync(filePath);
        }
      },
      sourceTextModuleFactory(source, options) {
        identifiers.push(options.identifier);
        return createLinkOnlyTestModule(source, options);
      }
    });
    assert.equal(proof.linked, true);
    assert.equal(proof.evaluated, false);
    assert.equal(proof.listenerCreated, false);
    assert.equal(proof.moduleCount, 3);
    assert.equal(identifiers.filter((identifier) => identifier === pathToFileURL(shared).href).length, 1);
    assert.equal(identifiers.includes(pathToFileURL(aliasA).href), false);
    assert.equal(identifiers.includes(pathToFileURL(aliasB).href), false);
  } finally {
    removeFixture(fixture);
  }
});

/**
 * Cleanup for fixtures that PACKAGED an archive.
 *
 * @electron/asar caches an open view of every archive it touches, so on Windows
 * the app.asar handle can outlive createPackage/listPackage/extractFile and make
 * `rmdir` of the parent fail with ENOTEMPTY. uncacheAll() releases that view, and
 * the bounded retry covers the residual close latency. This mirrors the existing
 * precedent in packaged-security-smoke.test.mjs, whose cleanup needed the same
 * treatment "after double packaging".
 *
 * Kept SEPARATE from the synchronous removeFixture on purpose: that one is itself
 * under test (assert.throws on an unregistered root), so it must stay sync.
 *
 * @param {string} directory Fixture root to remove.
 */
async function removePackagedFixture(directory) {
  const resolvedDirectory = path.resolve(directory);
  if (!isFixtureOwnedRoot(resolvedDirectory)) {
    throw new Error('Refusing to clean an unregistered test fixture root.');
  }
  uncacheAll();
  try {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        fs.rmSync(resolvedDirectory, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
        if (attempt === 8) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  } finally {
    fixtureRoots.delete(resolvedDirectory);
  }
}

/**
 * Build a fake packaged output whose engine lives INSIDE app.asar, which is where
 * it now ships: ASAR integrity validation only covers the archive, so the former
 * resources/gateway location was outside the integrity envelope. The fixtures
 * therefore package their engine files rather than writing them to resources/.
 *
 * @param {Record<string, string>} engineFiles relative name -> source
 * @returns {Promise<{ fixture: string, packageOutputDirectory: string }>}
 */
async function createPackagedEngineFixture(engineFiles) {
  const fixture = createFixture();
  const source = path.join(fixture, 'source');
  const gateway = path.join(source, 'build', 'gateway');
  fs.mkdirSync(gateway, { recursive: true });
  for (const [name, contents] of Object.entries(engineFiles)) {
    fs.writeFileSync(path.join(gateway, name), contents, 'utf8');
  }
  const archive = path.join(fixture, 'dist', 'win-unpacked', 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  await createPackage(source, archive);
  return { fixture, packageOutputDirectory: path.join(fixture, 'dist') };
}

test('regression: a mixed packaged gateway module set fails ESM linking before server evaluation', async () => {
  // Unchanged property: a server whose sibling does not provide the imported
  // binding must fail at LINK time, before any evaluation. Only the location
  // changed — the modules are now archive entries instead of files in resources/.
  const { fixture, packageOutputDirectory } = await createPackagedEngineFixture({
    'server.mjs': [
      'import http from "node:http";',
      'import { capResponseHeaders } from "./proxy-headers.mjs";',
      'process.stdout.write("UNEXPECTED_SERVER_EVALUATION\\n");',
      'http.createServer().listen(18765);',
      'export { capResponseHeaders };'
    ].join('\n'),
    'proxy-headers.mjs': 'export function sanitizeProxyHeaders() {}\n'
  });
  try {
    let thrown;
    try {
      runPackagedGatewayLinkSmoke({ packageOutputDirectory });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /does not provide an export named ['"]capResponseHeaders['"]/);
    console.log('PACKAGED_GATEWAY_LINK_RED SyntaxError: requested module ./proxy-headers.mjs does not provide export named capResponseHeaders; evaluationSkipped=true');
  } finally {
    await removePackagedFixture(fixture);
  }
});

test('package graph audit links a server without evaluating its listener startup code', async () => {
  const { fixture, packageOutputDirectory } = await createPackagedEngineFixture({
    'server.mjs': [
      'import http from "node:http";',
      'process.stdout.write("UNEXPECTED_SERVER_EVALUATION\\n");',
      'http.createServer().listen(18765);',
      'export const linked = true;'
    ].join('\n')
  });
  try {
    const proof = runPackagedGatewayLinkSmoke({ packageOutputDirectory });
    assert.equal(proof.linked, true);
    assert.equal(proof.evaluated, false);
    assert.equal(proof.listenerCreated, false);
    // New: the engine was audited FROM the archive, which is what integrity covers.
    assert.equal(proof.asarEntry, 'build/gateway/server.mjs');
    assert.equal(proof.integrityCovered, true);
  } finally {
    await removePackagedFixture(fixture);
  }
});

test('the link audit refuses a packaged output whose engine sits OUTSIDE app.asar', async () => {
  // Direct regression guard for the closed hole: an engine in resources/gateway is
  // not covered by ASAR integrity, so the audit must reject that layout outright.
  const { fixture, packageOutputDirectory } = await createPackagedEngineFixture({
    'server.mjs': 'export const linked = true;\n'
  });
  try {
    const stray = path.join(packageOutputDirectory, 'win-unpacked', 'resources', 'gateway');
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, 'server.mjs'), 'export const substituted = true;\n', 'utf8');
    assert.throws(
      () => runPackagedGatewayLinkSmoke({ packageOutputDirectory }),
      /PACKAGED_GATEWAY_STILL_OUTSIDE_ASAR/
    );
  } finally {
    await removePackagedFixture(fixture);
  }
});
