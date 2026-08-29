// Bundle the gateway engine into ONE minified ESM file.
//
// WHY: extraResources used to ship `src/gateway` verbatim, so an installed copy
// held the whole engine as readable source — including the comments that
// document hard-won upstream behaviour (per-key vs per-model 429 semantics, the
// NVCF dispatch distinction, the validation-error parsing that discovers
// reasoning modes). Those comments are worth more than the code. Bundling with
// `legalComments: "none"` strips every comment and inlines the module graph, so
// the shipped artifact is one opaque file instead of an annotated codebase.
//
// CONTRACT PRESERVED: output is `build/gateway/server.mjs`, and
// electron-builder maps `build/gateway -> gateway`, so the packaged path stays
// `resources/gateway/server.mjs` — exactly what getGatewayServerPath() in
// src/main/index.ts already resolves. The engine is still spawned as a child
// process the same way. The DEV path (src/gateway/server.mjs) is untouched, so
// `npm run dev` and every test that imports from src keeps working.
//
// EXTERNALS: none. The engine imports only `node:*` builtins (automatically
// external for platform "node") plus ../shared/redaction.mjs, which is inlined.
// jsonc-parser is a src/main dependency and is NOT reachable from the engine.

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

/**
 * Electron 31 embeds Node 20, so the engine may use everything Node 20 offers
 * and nothing newer. Keeping this in step with the `electron` devDependency is
 * what makes the bundle safe to run in the packaged app.
 */
export const GATEWAY_BUNDLE_TARGET = "node20";

/** Entry point and output, relative to the repository root. */
export const GATEWAY_BUNDLE_ENTRY = "src/gateway/server.mjs";
export const GATEWAY_BUNDLE_OUTPUT = "build/gateway/server.mjs";

export async function buildGatewayBundle({ outputRoot = root } = {}) {
    const entryPath = path.join(root, GATEWAY_BUNDLE_ENTRY);
    const outputPath = path.join(outputRoot, GATEWAY_BUNDLE_OUTPUT);

    const result = await build({
        entryPoints: [entryPath],
        outfile: outputPath,
        bundle: true,
        minify: true,
        // Strip EVERY comment, including the license/legal comments esbuild
        // would otherwise preserve — the moat lives in comments.
        legalComments: "none",
        platform: "node",
        format: "esm",
        target: GATEWAY_BUNDLE_TARGET,
        // No sourcemap: it would republish the original sources verbatim and
        // undo the whole point of this step.
        sourcemap: false,
        metafile: true,
        logLevel: "silent"
    });

    const bundled = Object.keys(result.metafile.outputs[
        Object.keys(result.metafile.outputs).find((key) => key.endsWith("server.mjs"))
    ].inputs).length;

    return {
        entry: GATEWAY_BUNDLE_ENTRY,
        output: GATEWAY_BUNDLE_OUTPUT,
        target: GATEWAY_BUNDLE_TARGET,
        bundledModuleCount: bundled,
        bytes: fs.statSync(outputPath).size
    };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    buildGatewayBundle()
        .then((proof) => console.log(JSON.stringify(proof)))
        .catch((error) => {
            console.error(error instanceof Error ? (error.message ?? error) : error);
            process.exitCode = 1;
        });
}
