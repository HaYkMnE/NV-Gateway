import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const childMode = '--link-only';

export function runPackagedGatewayLinkSmoke({
  root = path.resolve(import.meta.dirname, '..'),
  packageOutputDirectory = process.env.NVGW_PACKAGE_OUTPUT_DIRECTORY || path.join(root, 'dist'),
  nodePath = process.execPath
} = {}) {
  const gatewayDirectory = path.join(packageOutputDirectory, 'win-unpacked', 'resources', 'gateway');
  const server = path.join(gatewayDirectory, 'server.mjs');
  assert.equal(fs.existsSync(server), true, `PACKAGED_GATEWAY_SERVER_MISSING:${server}`);

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
  return proof;
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

  return { entry: entry.identifier, linked: entry.status === 'linked', evaluated: false, listenerCreated: false, moduleCount: modules.size };
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
