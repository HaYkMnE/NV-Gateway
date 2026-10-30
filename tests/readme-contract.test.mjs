import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gatewayRuntimeSource = fs.readFileSync(path.join(root, 'src', 'main', 'gateway-runtime.ts'), 'utf8');

test('README local Markdown targets exist', () => {
  const missing = [];
  for (const match of readme.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (/^(?:https?:\/\/|mailto:|#)/i.test(target)) continue;
    const pathname = decodeURIComponent(target.split('#', 1)[0]);
    if (pathname && !fs.existsSync(path.resolve(root, pathname))) missing.push(target);
  }
  assert.deepEqual(missing, []);
});

test('README source-development commands match package scripts', () => {
  assert.equal(packageJson.scripts.build, 'tsc --project tsconfig.node.json && tsc --project tsconfig.json --noEmit && vite build && npm run build:gateway');
  assert.equal(packageJson.scripts.dev, 'vite');
  assert.equal(packageJson.scripts.start, 'electron .');
  assert.equal(packageJson.scripts['package:dir'], 'npm run build && node scripts/run-electron-builder.mjs --dir && npm run package:audit');
  assert.match(readme, /# Build the Electron app and gateway bundle\r?\nnpm run build/);
  assert.match(readme, /# In terminal 1, start the Vite renderer\r?\nnpm run dev/);
  assert.match(readme, /# In terminal 2, start Electron\r?\nnpm start/);
});

test('README gives executable shell-specific packaged-build setup', () => {
  const fencedBlocks = [...readme.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g)]
    .map((match) => ({ language: match[1].trim().toLowerCase(), body: match[2] }));

  const powershell = fencedBlocks.find(({ language, body }) =>
    language === 'powershell' &&
    /^\$env:NVGW_GH_OWNER = "HaYkMnE"$/m.test(body) &&
    /^npm run package:dir$/m.test(body));
  const bash = fencedBlocks.find(({ language, body }) =>
    language === 'bash' &&
    /^export NVGW_GH_OWNER="HaYkMnE"$/m.test(body) &&
    /^npm run package:dir$/m.test(body));

  assert.ok(powershell, 'missing executable PowerShell packaged-build setup');
  assert.ok(bash, 'missing executable Bash/Zsh packaged-build setup');
  assert.doesNotMatch(
    readme,
    /^\s*\$env:NVGW_GH_OWNER\s*=.*#.*(?:Bash|Zsh|export NVGW_GH_OWNER)/m,
    'PowerShell assignment must not carry Bash/Zsh instructions in an inline comment'
  );
});

test('README client examples require the generated gateway token', () => {
  assert.doesNotMatch(readme, /local-nv-gateway/);
  assert.doesNotMatch(readme, /ANTHROPIC_API_KEY\s*=/);
  assert.match(readme, /ANTHROPIC_AUTH_TOKEN\s*=\s*"<gateway-token>"/);
  assert.match(readme, /OPENAI_API_KEY\s*=\s*"<gateway-token>"/);
  assert.match(readme, /Copy the generated \*\*Gateway Token\*\* from the app's \*\*Endpoint\*\* screen/);
});

test('README integration commands use executable shell-specific fences', () => {
  const fencedBlocks = [...readme.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g)]
    .map((match) => ({ language: match[1].trim().toLowerCase(), body: match[2] }));

  for (const variable of ['ANTHROPIC_BASE_URL', 'OPENAI_API_BASE']) {
    assert.ok(fencedBlocks.some(({ language, body }) =>
      language === 'powershell' && body.includes(`$env:${variable} = `)),
    `missing PowerShell block for ${variable}`);
    assert.ok(fencedBlocks.some(({ language, body }) =>
      language === 'bash' && body.includes(`export ${variable}=`)),
    `missing Bash/Zsh block for ${variable}`);
  }
  for (const { language, body } of fencedBlocks) {
    if (language === 'bash') assert.doesNotMatch(body, /^\$env:/m);
    if (language === 'powershell') assert.doesNotMatch(body, /^export /m);
  }
});

test('README OpenCode example uses the current custom-provider schema', () => {
  assert.match(readme, /"npm": "@ai-sdk\/openai-compatible"/);
  assert.match(readme, /"models": \{\s*"z-ai\/glm-5\.2":/);
  assert.doesNotMatch(readme, /"type": "openai-compatible"/);
});

test('README uses the application default paired ports', () => {
  const runtimeDefault = Number(gatewayRuntimeSource.match(/const DEFAULT_GATEWAY_PORT = (\d+);/)?.[1]);
  assert.equal(runtimeDefault, 12000);
  assert.doesNotMatch(readme, /12004|12005/);
  assert.match(readme, /default `12000` and `12001`/);
  assert.match(readme, /\| `POST \/v1\/chat\/completions` \| `12000` \| Gateway Bearer Token \|/);
  assert.match(readme, /\| `GET \/admin\/logs` \| `12001` \| Admin Token \|/);
});

test('README API reference reflects protected routes and the current logs path', () => {
  for (const route of ['POST /v1/chat/completions', 'POST /v1/messages', 'GET /v1/models']) {
    assert.ok(readme.includes(`| \`${route}\` | \`12000\` | Gateway Bearer Token |`), route);
  }
  assert.match(readme, /\| `GET \/health` \| `12000` \| Public \|/);
  assert.match(readme, /\| `GET \/admin\/logs` \| `12001` \| Admin Token \|/);
  assert.doesNotMatch(readme, /\/admin\/logs\/recent/);
  assert.doesNotMatch(readme, /GET \/ready/);
});
