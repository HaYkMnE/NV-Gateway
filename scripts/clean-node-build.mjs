import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// build/gateway holds the generated engine bundle (scripts/build-gateway-bundle.mjs);
// clearing it keeps a stale bundle from surviving into a rebuild.
for (const relativePath of ['build/src/main', 'build/src/preload', 'build/src/test-support', 'build/gateway']) {
  fs.rmSync(path.join(root, relativePath), { recursive: true, force: true });
}
fs.rmSync(path.join(root, 'build', 'tsconfig.node.tsbuildinfo'), { force: true });
