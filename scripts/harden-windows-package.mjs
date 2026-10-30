// Windows package hardening: ASAR integrity resource + Electron fuses.
//
// WHY THIS FILE EXISTS (instead of two lines of config):
// electron-builder 24.13.3 CANNOT ship ASAR integrity on Windows.
//   * It has no `electronFuses` config block at all — absent from out/*.js and
//     from scheme.json. That arrived in electron-builder 25.
//   * It DOES compute the hash (platformPackager.js:219 -> asar/integrity.js),
//     but ElectronFramework.js forwards it only to createMacApp(), which writes
//     the macOS Info.plist key. Its Windows branch merely renames the .exe.
//     25.1.8 added the missing `addWinAsarIntegrity(executable, integrity)` call
//     plus a `resedit` dependency; 24.13.3 has neither.
//
// ELECTRON-BUILDER 26.18.0 (current pin) re-read: it now embeds the resource
// itself (out/electron/ElectronFramework.js:51-53 -> electronWin.js
// addWinAsarIntegrity, in beforeCopyExtraFiles, i.e. BEFORE afterPack) and it
// only flips fuses when `electronFuses` is configured (platformPackager.js:262-265,
// run after afterPack). This repo configures no `electronFuses`, so the builder
// never touches the fuse wire, and injectWindowsAsarIntegrity below FILTERS the
// builder's entry before pushing its own, so the resource is present exactly once.
// The hook is kept: it is the single owner of REQUIRED_FUSE_STATES and the
// post-flip assertion.
//
// Enabling the fuse WITHOUT embedding the hash is the worst outcome: Electron
// aborts at startup with
//   FATAL:archive_win.cc(152)] Failed to find file integrity info for resources\app.asar
// (exactly electron/electron#43514). So this module backports the missing step:
// embed the resource FIRST, then flip the fuses.
//
// ORDER MATTERS. resedit rewrites the whole PE image, while the fuse wire lives
// in a sentinel inside the binary, so flipping fuses before a full-image rewrite
// risks losing them. Upstream 25.x also injects the resource during packaging and
// flips fuses afterwards; the same order is used here.
//
// RunAsNode IS DELIBERATELY LEFT ENABLED. The gateway engine is spawned as a
// child of this very binary with ELECTRON_RUN_AS_NODE=1 (see
// createGatewaySpawnOptions in src/main/gateway-runtime.ts). Disabling that fuse
// — which hardening guides routinely recommend — would kill the gateway
// outright, and this module asserts it stays ON so that regression is loud.
//
// RESIDUAL RISK, stated precisely because it is a real code channel and not a
// cosmetic trade-off: with RunAsNode enabled, ANY local process that can write to
// or launch this executable can run arbitrary JavaScript inside the Electron
// runtime as the current user —
//     ELECTRON_RUN_AS_NODE=1 NV-Gateway.exe -e "<js>"
// — and the ASAR integrity fuse does not apply, because nothing under app.asar is
// read on that path: `-e` is evaluated directly by the Node runtime that the exe
// becomes. The same is true of ELECTRON_RUN_AS_NODE=1 with a script path. So the
// two integrity fuses protect the PACKAGED APP's code, not this entry point.
//
// What that channel does and does not give an attacker:
//   * It grants no privilege the user does not already have. Code running as the
//     user can already read %APPDATA%\NV-Gateway\keys.json only through DPAPI
//     (CryptUnprotectData, same user), so this is not a privilege escalation.
//   * It DOES bypass the app's own redaction and "zero raw secrets to renderer"
//     boundaries for anything that process chooses to do, and it is a convenient
//     execution primitive for a dropper that has already achieved user-level code
//     execution. In that threat model the attacker has code execution anyway; the
//     fuse is not the boundary that stops them.
//   * It is NOT remotely reachable: the fuse only matters if something can already
//     spawn a local process.
//
// EVALUATED ALTERNATIVE (not implemented — reported, not applied): spawn the
// gateway child from a SEPARATE node.exe (e.g. a bundled standalone Node binary,
// or the system node) instead of re-executing NV-Gateway.exe with
// ELECTRON_RUN_AS_NODE=1. That would let RunAsNode be turned OFF and would remove
// this channel entirely. The trade-offs measured against the current design:
//   * + Closes ELECTRON_RUN_AS_NODE=1 ... -e on the shipped binary.
//   * - Adds a second runtime to sign, ship, patch and audit. The gateway bundle
//     is currently shipped INSIDE the signed, integrity-checked app; a separate
//     node.exe is a new unsigned-by-default binary in the install directory, which
//     is itself an execution primitive unless it is signed and covered by the
//     installer's integrity story.
//   * - Diverges from Electron's own Node version/ABI. The gateway runs today on
//     exactly the Node that Electron embeds; a standalone binary reintroduces a
//     version-skew class of bug (native modules, ESM loader behaviour) that the
//     current single-runtime design cannot have.
//   * - Requires reworking createGatewaySpawnOptions, the paired-port attestation
//     handshake and tests/gateway-runtime.test.mjs, all of which assert the child
//     is THIS executable. That is a behavioural change to the process-isolation
//     design, not a packaging tweak.
//   Conclusion: the residual risk is accepted and documented here. It is a
//   user-level code channel that a user-level attacker already has, and closing it
//   costs a second runtime whose own attack surface is at least as large.
//
// TWO MORE FUSES ARE DELIBERATELY DISABLED (measured, not assumed):
//
//   EnableNodeOptionsEnvironmentVariable — when ON, NODE_OPTIONS is honoured by
//   this binary. That is a code-execution channel that bypasses every other
//   control here: `NODE_OPTIONS=--require=<anything>` runs attacker code inside
//   the packaged app before a single line of app code, and it survives ASAR
//   integrity because nothing in app.asar changed. The app does not need it —
//   the gateway child is spawned with an explicitly filtered environment
//   (WINDOWS_CHILD_ENVIRONMENT_NAMES in src/main/gateway-runtime.ts does NOT
//   include NODE_OPTIONS; tests/gateway-runtime.test.mjs asserts a parent
//   NODE_OPTIONS is dropped). So nothing legitimate depends on it.
//
//   EnableNodeCliInspectArguments — when ON, `--inspect`/`--inspect-brk` open a
//   debugger port on this binary. A local debugger on a process that holds the
//   user's NVIDIA keys in memory is a key-exfiltration primitive, and the app
//   never launches with those flags (no --inspect anywhere in src/, scripts/ or
//   the npm scripts). So nothing legitimate depends on it either.
//
// ONE FUSE IS DELIBERATELY ENABLED for hardening: EnableCookieEncryption (Electron 44).
// Cookies on disk are then encrypted with the OS-level key. The app uses no
// cookies, so turning it on costs nothing. GrantFileProtocolExtraPrivileges stays ON
// (default) because the renderer is loaded from file://.
//
// The two integrity fuses stay ON, and every OTHER fuse is left untouched: the
// gateway child is the same executable, so unrelated hardening could kill it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRawHeader } from "@electron/asar";
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { NtExecutable, NtExecutableResource, Resource } from "resedit";

/** Win32 resource Electron reads the integrity manifest from. */
export const INTEGRITY_RESOURCE_TYPE = "INTEGRITY";
export const INTEGRITY_RESOURCE_ID = "ELECTRONASAR";

/**
 * SHA-256 of an archive's RAW HEADER (not of the whole file) — the value
 * Electron compares against at load time. Mirrors @electron/packager's
 * resedit.ts, which hashes `headerString`.
 * @param {string} asarPath
 * @returns {string} hex digest
 */
export function hashAsarHeader(asarPath) {
    const { headerString } = getRawHeader(asarPath);
    return crypto.createHash("sha256").update(headerString).digest("hex");
}

/**
 * Integrity map for every .asar in a resources directory, keyed by the path
 * Electron looks the archive up by.
 *
 * The key MUST use the platform separator: a `resources/app.asar` key makes
 * Windows abort with "Failed to find file integrity info"
 * (electron-userland/electron-builder#8690). path.join yields
 * `resources\app.asar` on Windows, which is what is wanted.
 *
 * @param {{ resourcesPath: string, resourcesRelativePath?: string }} options
 * @returns {Record<string, { algorithm: string, hash: string }>}
 */
export function computeAsarIntegrity({ resourcesPath, resourcesRelativePath = "resources" }) {
    const names = fs.readdirSync(resourcesPath).filter((name) => name.endsWith(".asar")).sort();
    /** @type {Record<string, { algorithm: string, hash: string }>} */
    const result = {};
    for (const name of names) {
        result[path.join(resourcesRelativePath, name)] = {
            algorithm: "SHA256",
            hash: hashAsarHeader(path.join(resourcesPath, name))
        };
    }
    return result;
}

/**
 * Serialize the integrity map into the JSON array Electron expects inside the
 * resource. `alg` is lowercase, per the Electron ASAR-integrity docs and
 * @electron/packager's resedit.ts.
 *
 * @param {Record<string, { algorithm: string, hash: string }>} integrity
 * @returns {Array<{ file: string, alg: string, value: string }>}
 */
export function buildIntegrityManifest(integrity) {
    return Object.entries(integrity).map(([file, { algorithm, hash }]) => ({
        file,
        alg: String(algorithm).toLowerCase(),
        value: hash
    }));
}

/**
 * Embed the integrity manifest into the executable's resources.
 * Idempotent: a previously written entry is replaced, never duplicated.
 *
 * @param {string} executablePath
 * @param {Record<string, { algorithm: string, hash: string }>} integrity
 * @returns {Array<{ file: string, alg: string, value: string }>} what was written
 */
export function injectWindowsAsarIntegrity(executablePath, integrity) {
    const manifest = buildIntegrityManifest(integrity);
    const executable = NtExecutable.from(fs.readFileSync(executablePath));
    const resource = NtExecutableResource.from(executable);

    // Reuse the language/codepage of the existing version info, mirroring
    // app-builder-lib 25.1.8's addWinAsarIntegrity.
    const versionInfo = Resource.VersionInfo.fromEntries(resource.entries);
    if (versionInfo.length !== 1) throw new Error(`ASAR_INTEGRITY_VERSION_INFO_UNPARSEABLE:${executablePath}`);
    const languages = versionInfo[0].getAllLanguagesForStringValues();
    if (languages.length !== 1) throw new Error(`ASAR_INTEGRITY_LANGUAGE_UNRESOLVED:${executablePath}`);

    resource.entries = resource.entries.filter(
        (entry) => !(entry.type === INTEGRITY_RESOURCE_TYPE && entry.id === INTEGRITY_RESOURCE_ID)
    );
    resource.entries.push({
        type: INTEGRITY_RESOURCE_TYPE,
        id: INTEGRITY_RESOURCE_ID,
        bin: Buffer.from(JSON.stringify(manifest)),
        lang: languages[0].lang,
        codepage: languages[0].codepage
    });
    resource.outputResource(executable);
    fs.writeFileSync(executablePath, Buffer.from(executable.generate()));
    return manifest;
}

/**
 * Read the embedded integrity manifest back out, or null when absent.
 * @param {string} executablePath
 * @returns {Array<{ file: string, alg: string, value: string }> | null}
 */
export function readWindowsAsarIntegrity(executablePath) {
    const resource = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(executablePath)));
    const entry = resource.entries.find(
        (candidate) => candidate.type === INTEGRITY_RESOURCE_TYPE && candidate.id === INTEGRITY_RESOURCE_ID
    );
    if (!entry) return null;
    try {
        return JSON.parse(Buffer.from(entry.bin).toString("utf8"));
    } catch {
        return null;
    }
}

/** getCurrentFuseWire yields raw bytes ('1'/'0' as char codes); decode them. */
function decodeFuseState(value) {
    const character = typeof value === "number" ? String.fromCharCode(value) : String(value);
    if (character === "1") return "enabled";
    if (character === "0") return "disabled";
    if (character === "r") return "removed";
    return "inherit";
}

/**
 * Actual fuse states of a built binary, keyed by fuse NAME.
 * @param {string} executablePath
 * @returns {Promise<Record<string, string>>}
 */
export async function readFuseStates(executablePath) {
    const wire = await getCurrentFuseWire(executablePath);
    /** @type {Record<string, string>} */
    const states = {};
    for (const [key, value] of Object.entries(wire)) {
        if (key === "version") continue;
        states[FuseV1Options[key] ?? key] = decodeFuseState(value);
    }
    return states;
}

/**
 * The fuse states this package REQUIRES, as one table so the flip and the
 * post-build assertion cannot drift apart.
 *
 * `true` = must be ON, `false` = must be OFF. Every entry is justified in the
 * module header; nothing here is a generic hardening recommendation.
 */
export const REQUIRED_FUSE_STATES = Object.freeze({
    // Integrity: the archive is validated against the hash embedded in the exe,
    // and the app can only be loaded from app.asar (no loose-file substitute).
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // The gateway child IS this binary with ELECTRON_RUN_AS_NODE=1. Off = dead app.
    // Residual risk (arbitrary local JS via `ELECTRON_RUN_AS_NODE=1 <exe> -e ...`,
    // not covered by ASAR integrity) is analysed in the module header.
    [FuseV1Options.RunAsNode]: true,
    // NODE_OPTIONS=--require=<code> must not reach this process. See header.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // No debugger port on a process holding the user's API keys. See header.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Hardening, no cookie use: cookies at rest are encrypted with the OS key.
    // The app sets no cookies, so the one-way migration cost is nil. See header.
    [FuseV1Options.EnableCookieEncryption]: true
});

/**
 * Set exactly the fuses in REQUIRED_FUSE_STATES and leave the rest as shipped.
 * @param {string} executablePath
 */
export async function applyRequiredFuses(executablePath) {
    await flipFuses(executablePath, {
        version: FuseVersion.V1,
        resetAdHocDarwinSignature: false,
        ...REQUIRED_FUSE_STATES
    });
}

/**
 * Assert every required fuse is in its required state. Returns the first
 * mismatch as a descriptive error name, or null when everything is correct.
 * @param {Record<string, string>} fuses
 * @returns {string | null}
 */
export function findFuseViolation(fuses) {
    for (const [option, required] of Object.entries(REQUIRED_FUSE_STATES)) {
        const name = FuseV1Options[option] ?? String(option);
        const actual = fuses[name];
        const expected = required ? "enabled" : "disabled";
        if (actual !== expected) return `${name} must be ${expected.toUpperCase()} but is ${String(actual).toUpperCase()}`;
    }
    return null;
}

/**
 * Harden one packed Windows app directory: embed the hash, flip the fuses, then
 * read both back as proof. Throws rather than shipping an executable that cannot
 * start, or one whose gateway child is dead on arrival.
 *
 * @param {{ appOutDir: string, executableName?: string }} options
 * @returns {Promise<{ executablePath: string, manifest: object[], embedded: object[], fuses: Record<string,string> }>}
 */
export async function hardenWindowsPackage({ appOutDir, executableName }) {
    const resourcesPath = path.join(appOutDir, "resources");
    if (!fs.existsSync(resourcesPath)) throw new Error(`ASAR_INTEGRITY_RESOURCES_MISSING:${resourcesPath}`);

    const executablePath = path.join(appOutDir, executableName ?? resolveExecutableName(appOutDir));
    if (!fs.existsSync(executablePath)) throw new Error(`ASAR_INTEGRITY_EXECUTABLE_MISSING:${executablePath}`);

    const integrity = computeAsarIntegrity({ resourcesPath });
    if (Object.keys(integrity).length === 0) throw new Error(`ASAR_INTEGRITY_NO_ARCHIVES:${resourcesPath}`);

    const manifest = injectWindowsAsarIntegrity(executablePath, integrity);
    await applyRequiredFuses(executablePath);

    const fuses = await readFuseStates(executablePath);
    const embedded = readWindowsAsarIntegrity(executablePath);
    if (!embedded) throw new Error(`ASAR_INTEGRITY_RESOURCE_NOT_EMBEDDED:${executablePath}`);
    // Every fuse this package requires, in one assertion. Named individually in
    // the message so a failure says WHICH hardening step was lost.
    const violation = findFuseViolation(fuses);
    if (violation) throw new Error(`FUSE_STATE_VIOLATION:${violation}`);

    return { executablePath, manifest, embedded, fuses };
}

function resolveExecutableName(appOutDir) {
    const candidates = fs.readdirSync(appOutDir)
        .filter((name) => name.toLowerCase().endsWith(".exe") && name.toLowerCase() !== "elevate.exe");
    if (candidates.length !== 1) throw new Error(`ASAR_INTEGRITY_EXECUTABLE_AMBIGUOUS:${candidates.join(",")}`);
    return candidates[0];
}

/**
 * electron-builder `afterPack` hook. Runs once per packed platform directory and
 * BEFORE the nsis/portable artifacts are produced from it — which is why the
 * hardening lives here rather than in a post-build npm step: the installer must
 * contain the already-hardened executable.
 *
 * @param {{ appOutDir: string, electronPlatformName: string, packager?: object }} context
 */
export default async function afterPack(context) {
    if (context.electronPlatformName !== "win32") return;
    const productFilename = context.packager?.appInfo?.productFilename;
    const proof = await hardenWindowsPackage({
        appOutDir: context.appOutDir,
        executableName: productFilename ? `${productFilename}.exe` : undefined
    });
    console.log(`[harden-windows-package] ${JSON.stringify({
        manifest: proof.manifest,
        fuses: {
            EnableEmbeddedAsarIntegrityValidation: proof.fuses.EnableEmbeddedAsarIntegrityValidation,
            OnlyLoadAppFromAsar: proof.fuses.OnlyLoadAppFromAsar,
            RunAsNode: proof.fuses.RunAsNode,
            EnableNodeOptionsEnvironmentVariable: proof.fuses.EnableNodeOptionsEnvironmentVariable,
            EnableNodeCliInspectArguments: proof.fuses.EnableNodeCliInspectArguments,
            EnableCookieEncryption: proof.fuses.EnableCookieEncryption
        }
    })}`);
}
