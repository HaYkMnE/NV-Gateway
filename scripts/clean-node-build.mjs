import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const relativePath of ['build/src/main', 'build/src/preload', 'build/src/test-support']) {
  fs.rmSync(path.join(root, relativePath), { recursive: true, force: true });
}
fs.rmSync(path.join(root, 'build', 'tsconfig.node.tsbuildinfo'), { force: true });
