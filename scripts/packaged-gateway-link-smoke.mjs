import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const childMode = '--link-only';

export function runPackagedGatewayLinkSmoke({
  root = path.resolve(import.meta.dirname, '..'),
  packageOutputDirectory = process.env.NVGW_PACKAGE_OUTPUT_DIRECTORY || path.join(root, 'dist'),
  nodePath = process.execPath
} = {}) {
  const unpacked = path.join(packageOutputDirectory, 'win-unpacked');
  const archive = path.join(unpacked, 'resources', 'app.asar');
  assert.equal(fs.existsSync(archive), true, `PACKAGED_ASAR_MISSING:${archive}`);

  // LOCATION INVARIANT (stronger than before): the engine must be an ARCHIVE
  // ENTRY, because ASAR integrity validation only covers app.asar. The old
  // resources/gateway location sat outside that envelope, so a substituted —
  // still functional — engine ran with no complaint.
  const stripLeadingSeparators = (entry) => entry.replace(/^[\\/]+/, '');
  const toPosix = (entry) => entry.replace(/\\/g, '/');
  const engineEntries = listPackage(archive, {})
    .map(stripLeadingSeparators)
    .filter((entry) => toPosix(entry).startsWith('build/gateway/'));
  assert.ok(engineEntries.length > 0, 'PACKAGED_GATEWAY_ENGINE_NOT_IN_ASAR');
  const entryRelative = engineEntries.find((entry) => toPosix(entry).endsWith('/server.mjs'));
  assert.ok(entryRelative, 'PACKAGED_GATEWAY_SERVER_MISSING_IN_ASAR');
  // The old integrity-UNCOVERED location must be gone: an executable file there
  // could be swapped without detection, which is the hole this move closes.
  assert.equal(fs.existsSync(path.join(unpacked, 'resources', 'gateway')), false, 'PACKAGED_GATEWAY_STILL_OUTSIDE_ASAR');

  // Only Electron patches fs with asar support, so plain Node cannot read an
  // archive member. The SHIPPED BYTES are therefore extracted verbatim and
  // linked from a scratch copy: the property under test is the engine's CONTENT
  // (it links as ESM, resolves to a single file, and creates no listener while
  // linking), which extraction preserves byte-for-byte.
  //
  // EVERY engine entry is extracted, preserving its relative layout, so a
  // would-be multi-module ship still reaches the LINKER and is judged by the
  // module graph — rather than being rejected on a filename count before the
  // graph is ever examined. The single-bundle assertions run after the link.
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nvgw-link-smoke-'));
  const toScratch = (entry) => path.join(scratchRoot, ...toPosix(entry).split('/'));
  const server = toScratch(entryRelative);
  for (const entry of engineEntries) {
    const target = toScratch(entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, extractFile(archive, entry));
  }

  try {
    const result = spawnSync(nodePath, ['--experimental-vm-modules', fileURLToPath(import.meta.url), childMode, server], {
      encoding: 'utf8',
      windowsHide: true,
      env: {}
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit=${result.status}`).trim();
      throw new Error(`PACKAGED_GATEWAY_LINK_AUDIT_FAILED\n${detail}`);
    }

    const proof = JSON.parse(result.stdout);
    assert.equal(proof.entry, pathToFileURL(server).href, 'PACKAGED_GATEWAY_LINK_ENTRY_MISMATCH');
    assert.equal(proof.linked, true, 'PACKAGED_GATEWAY_LINK_INCOMPLETE');
    assert.equal(proof.evaluated, false, 'PACKAGED_GATEWAY_LINK_EVALUATED');
    assert.equal(proof.listenerCreated, false, 'PACKAGED_GATEWAY_LISTENER_CREATED');
    // The engine ships as ONE self-contained bundle: every former sibling module
    // is inlined, so exactly one file may take part in the link. This replaces
    // the old "the whole 21-file graph resolves" invariant with the stronger
    // property that there is no graph left to ship.
    assert.equal(proof.fileModuleCount, 1, `PACKAGED_GATEWAY_NOT_A_SINGLE_BUNDLE:${proof.fileModuleCount}`);
    return { ...proof, asarEntry: toPosix(entryRelative), integrityCovered: true };
  } finally {
    // Best-effort: this is scratch in the OS temp dir. On Windows a deletion can
    // still be pending right after a child process read the files, and a throw
    // from this `finally` would turn a PASSING audit into a failure — the audit
    // verdict must not hinge on temp-dir cleanup.
    try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* swept by the OS */ }
  }
}

export async function linkPackagedGatewayModules(entryPath, { fileSystem = fs, sourceTextModuleFactory } = {}) {
  const vm = sourceTextModuleFactory ? undefined : await import('node:vm');
  const resourcesDirectory = path.resolve(path.dirname(path.dirname(entryPath)));
  const canonicalResourcesDirectory = fileSystem.realpathSync(resourcesDirectory);
  const modules = new Map();

  function assertInsideResources(filePath) {
    const relative = path.relative(resourcesDirectory, filePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`PACKAGED_GATEWAY_IMPORT_OUTSIDE_RESOURCES:${filePath}`);
    }
  }

  function assertCanonicalInsideResources(filePath) {
    const relative = path.relative(canonicalResourcesDirectory, filePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`PACKAGED_GATEWAY_IMPORT_CANONICAL_OUTSIDE_RESOURCES:${filePath}`);
    }
  }

  function assertNotReparsePoint(filePath) {
    const metadata = fileSystem.lstatSync(filePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`PACKAGED_GATEWAY_IMPORT_REPARSE_POINT:${filePath}`);
    }
    return metadata;
  }

  function assertRegularFile(metadata, filePath) {
    if (!metadata.isFile()) throw new Error(`PACKAGED_GATEWAY_IMPORT_NOT_FILE:${filePath}`);
  }

  function assertSameIdentity(expected, actual, filePath) {
    if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
      throw new Error(`PACKAGED_GATEWAY_IMPORT_IDENTITY_CHANGED:${filePath}`);
    }
  }

  function readOpenedModule(filePath, canonicalFilePath) {
    const descriptor = fileSystem.openSync(canonicalFilePath, 'r');
    try {
      const openedMetadata = fileSystem.fstatSync(descriptor);
      assertRegularFile(openedMetadata, canonicalFilePath);
      const size = Number(openedMetadata.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`PACKAGED_GATEWAY_IMPORT_NOT_FILE:${canonicalFilePath}`);
      }

      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fileSystem.readSync(descriptor, bytes, offset, bytes.length - offset, null);
        if (count === 0) throw new Error(`PACKAGED_GATEWAY_IMPORT_IDENTITY_CHANGED:${canonicalFilePath}`);
        offset += count;
      }

      assertNotReparsePoint(filePath);
      const finalCanonicalFilePath = fileSystem.realpathSync(filePath);
      assertCanonicalInsideResources(finalCanonicalFilePath);
      if (path.resolve(finalCanonicalFilePath) !== path.resolve(canonicalFilePath)) {
        throw new Error(`PACKAGED_GATEWAY_IMPORT_IDENTITY_CHANGED:${canonicalFilePath}`);
      }
      const finalMetadata = fileSystem.statSync(finalCanonicalFilePath);
      assertRegularFile(finalMetadata, finalCanonicalFilePath);
      assertSameIdentity(openedMetadata, finalMetadata, canonicalFilePath);
      return bytes.toString('utf8');
    } finally {
      fileSystem.closeSync(descriptor);
    }
  }

  async function getModule(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    if (identifier.startsWith('node:')) {
      const namespace = await import(identifier);
      const module = new vm.SyntheticModule(Object.keys(namespace), function initializeBuiltin() {
        for (const name of Object.keys(namespace)) this.setExport(name, namespace[name]);
      }, { identifier });
      modules.set(identifier, module);
      return module;
    }

    const filePath = fileURLToPath(identifier);
    assertInsideResources(filePath);
    assertNotReparsePoint(filePath);
    const canonicalFilePath = fileSystem.realpathSync(filePath);
    assertCanonicalInsideResources(canonicalFilePath);
    assertRegularFile(fileSystem.statSync(canonicalFilePath), canonicalFilePath);
    const canonicalIdentifier = pathToFileURL(canonicalFilePath).href;
    if (modules.has(canonicalIdentifier)) return modules.get(canonicalIdentifier);
    const source = readOpenedModule(filePath, canonicalFilePath);
    const module = sourceTextModuleFactory
      ? sourceTextModuleFactory(source, { identifier: canonicalIdentifier })
      : new vm.SourceTextModule(source, { identifier: canonicalIdentifier });
    modules.set(canonicalIdentifier, module);
    return module;
  }

  const entry = await getModule(pathToFileURL(path.resolve(entryPath)).href);
  await entry.link(async (specifier, referencingModule) => {
    if (specifier.startsWith('node:')) return getModule(specifier);
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
      throw new Error(`PACKAGED_GATEWAY_UNSUPPORTED_IMPORT:${specifier}`);
    }
    return getModule(new URL(specifier, referencingModule.identifier).href);
  });

  // `moduleCount` counts EVERY linked module, node: builtins included.
  // `fileModuleCount` counts only on-disk engine files, which is what the
  // single-bundle invariant is about (builtins are irreducible and vary with
  // the engine's imports, so they must not be part of that assertion).
  const fileModuleCount = [...modules.keys()].filter((identifier) => !identifier.startsWith('node:')).length;
  return { entry: entry.identifier, linked: entry.status === 'linked', evaluated: false, listenerCreated: false, moduleCount: modules.size, fileModuleCount };
}

if (process.argv[2] === childMode) {
  linkPackagedGatewayModules(process.argv[3]).then((proof) => console.log(JSON.stringify(proof))).catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
} else if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(runPackagedGatewayLinkSmoke()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PACKAGED_GATEWAY_LINK_AUDIT_FAILED');
    process.exitCode = 1;
  }
}
