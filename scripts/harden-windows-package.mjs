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
// outright. Only the two integrity fuses are flipped; every other fuse is left
// untouched for the same reason: the child process is the same executable.

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
 * Turn ON the two integrity fuses and NOTHING else. RunAsNode stays as shipped
 * (enabled) because the gateway child depends on it — see the module header.
 * @param {string} executablePath
 */
export async function enableIntegrityFuses(executablePath) {
    await flipFuses(executablePath, {
        version: FuseVersion.V1,
        resetAdHocDarwinSignature: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true
    });
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
    await enableIntegrityFuses(executablePath);

    const fuses = await readFuseStates(executablePath);
    const embedded = readWindowsAsarIntegrity(executablePath);
    if (!embedded) throw new Error(`ASAR_INTEGRITY_RESOURCE_NOT_EMBEDDED:${executablePath}`);
    if (fuses.EnableEmbeddedAsarIntegrityValidation !== "enabled") throw new Error("ASAR_INTEGRITY_FUSE_NOT_ENABLED");
    if (fuses.OnlyLoadAppFromAsar !== "enabled") throw new Error("ONLY_LOAD_APP_FROM_ASAR_FUSE_NOT_ENABLED");
    // Without this one the gateway child cannot run at all.
    if (fuses.RunAsNode !== "enabled") throw new Error("RUN_AS_NODE_FUSE_MUST_STAY_ENABLED");

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
            RunAsNode: proof.fuses.RunAsNode
        }
    })}`);
}
