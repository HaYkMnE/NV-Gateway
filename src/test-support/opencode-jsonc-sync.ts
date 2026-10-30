import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeStrictUtf8OpenCodeConfig } from "../main/opencode-config-decoding";
import { locateOpenCodeJsoncTargets } from "../main/opencode-jsonc-targets";

function fail(code: string): never { throw new Error(code); }
function hash(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
export interface MigrationLockOwner { version: 1; operationId: string; instanceId: string; pid: number; lockPath: string }
export function migrationLockPath(statePath: string, operationId: string, instanceId: string): string { return path.join(path.dirname(statePath), `migration.${operationId}.${instanceId}.lock`); }
function validLockOwner(value: unknown): value is MigrationLockOwner { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const owner = value as Record<string, unknown>; return owner.version === 1 && typeof owner.operationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.operationId) && typeof owner.instanceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.instanceId) && Number.isInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.lockPath === "string"; }
function sameLockOwner(left: MigrationLockOwner, right: MigrationLockOwner): boolean { return left.version === right.version && left.operationId === right.operationId && left.instanceId === right.instanceId && left.pid === right.pid && left.lockPath === right.lockPath; }
function liveProcess(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return !(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ESRCH"); } }
export function reconcileMigrationLockForTests(options: { owner: MigrationLockOwner; hooks?: { afterValidated?: () => void } }): void {
  const { owner } = options;
  if (!validLockOwner(owner)) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  let before: Buffer; let parsed: unknown;
  try { before = fs.readFileSync(owner.lockPath); parsed = JSON.parse(before.toString("utf8")); } catch { fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE"); }
  if (!validLockOwner(parsed) || !sameLockOwner(parsed, owner) || liveProcess(parsed.pid)) fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE");
  options.hooks?.afterValidated?.();
  try { if (!fs.readFileSync(owner.lockPath).equals(before)) fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE"); } catch (error) { if (error instanceof Error && error.message === "OPENCODE_CONFIG_LOCK_UNAVAILABLE") throw error; fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE"); }
}
function fsyncFile(filePath: string): void { const fd = fs.openSync(filePath, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }

export function editOpenCodeJsonc(source: string, gatewayToken: string, baseURL: string): string {
  const targets = locateOpenCodeJsoncTargets(source);
  const replacements = [
    { rawOffset: targets.apiKey.rawOffset, length: targets.apiKey.length, text: JSON.stringify(gatewayToken) },
    { rawOffset: targets.baseURL.rawOffset, length: targets.baseURL.length, text: JSON.stringify(baseURL) }
  ].sort((left, right) => right.rawOffset - left.rawOffset);
  return replacements.reduce((result, replacement) => result.slice(0, replacement.rawOffset) + replacement.text + result.slice(replacement.rawOffset + replacement.length), source);
}

function semanticVerify(source: string, gatewayToken: string, baseURL: string): void {
  const targets = locateOpenCodeJsoncTargets(source);
  if (targets.apiKey.value !== gatewayToken || targets.baseURL.value !== baseURL) fail("OPENCODE_CONFIG_VERIFY_FAILED");
}

function writeProtectedExclusive(filePath: string, content: Buffer | string, protectFile: (filePath: string) => void): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    protectFile(filePath);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function replaceAtomic(source: string, target: string): void {
  try { fs.renameSync(source, target); }
  catch { fail("OPENCODE_CONFIG_WRITE_FAILED"); }
}

interface FileSnapshot { hash: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
function snapshot(filePath: string): FileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    return { hash: hash(fs.readFileSync(filePath)), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev };
  } catch { fail("OPENCODE_CONFIG_UNAVAILABLE"); }
}
function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.hash === right.hash && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev;
}

export function syncOpenCodeConfigs(options: {
  configPaths: string[];
  gatewayToken: string;
  port: number;
  protectFile: (filePath: string) => void;
  lockOwner?: MigrationLockOwner;
  priorBackups?: string[];
  hooks?: {
    afterBackups?: (backups: string[]) => void;
    beforeReplace?: (filePath: string) => void;
    afterFinalCheckBeforeReplace?: (filePath: string) => void;
    afterReplaceBeforeVerify?: (filePath: string) => void;
    beforeRollbackReplace?: (filePath: string) => void;
    afterVerified?: () => void;
  };
}): { backups: string[] } {
  if (!Array.isArray(options.configPaths) || options.configPaths.length !== 2 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65534) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  let lockDescriptor: number | undefined;
  if (options.lockOwner && !validLockOwner(options.lockOwner)) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  const lockOwner = options.lockOwner;
  const operationId = lockOwner?.operationId ?? crypto.randomUUID();
  const baseURL = `http://127.0.0.1:${options.port}/v1`;
  const work: Array<{ filePath: string; original: Buffer; originalHash: string; edited: string; editedHash: string; backup: string; temporary: string }> = [];
  try {
      if (options.lockOwner) {
        try {
          lockDescriptor = fs.openSync(lockOwner.lockPath, "wx", 0o600);
          options.protectFile(lockOwner.lockPath);
          fs.writeFileSync(lockDescriptor, JSON.stringify(lockOwner));
        fs.fsyncSync(lockDescriptor);
      } catch { fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE"); }
    }
    for (let index = 0; index < options.configPaths.length; index++) {
      const filePath = options.configPaths[index];
      let original: Buffer;
      try { original = fs.readFileSync(filePath); decodeStrictUtf8OpenCodeConfig(original); } catch (error) { if (error instanceof Error && error.message === "OPENCODE_CONFIG_MALFORMED") throw error; fail("OPENCODE_CONFIG_UNAVAILABLE"); }
      const priorBackup = options.priorBackups?.[index];
      const baseline = priorBackup ? (() => { try { const backup = fs.readFileSync(priorBackup); decodeStrictUtf8OpenCodeConfig(backup); return backup; } catch (error) { if (error instanceof Error && error.message === "OPENCODE_CONFIG_MALFORMED") throw error; return fail("OPENCODE_CONFIG_BACKUP_UNAVAILABLE"); } })() : original;
      const text = decodeStrictUtf8OpenCodeConfig(baseline);
      const edited = editOpenCodeJsonc(text, options.gatewayToken, baseURL);
      semanticVerify(edited, options.gatewayToken, baseURL);
      const directory = path.dirname(filePath);
      const stem = path.basename(filePath);
      const editedHash = hash(edited);
      if (priorBackup && hash(original) !== hash(baseline) && hash(original) !== editedHash) fail("OPENCODE_CONFIG_CHANGED");
      work.push({ filePath, original: baseline, originalHash: hash(baseline), edited, editedHash, backup: priorBackup ?? path.join(directory, `.${stem}.nvgw-migration.${operationId}.bak`), temporary: path.join(directory, `.${stem}.nvgw-migration.${operationId}.tmp`) });
    }
    if (!options.priorBackups) {
      for (const item of work) writeProtectedExclusive(item.backup, item.original, options.protectFile);
      options.hooks?.afterBackups?.(work.map((item) => item.backup));
    }
    const replaced: typeof work = [];
    try {
      for (const item of work) {
        writeProtectedExclusive(item.temporary, item.edited, options.protectFile);
        options.hooks?.beforeReplace?.(item.filePath);
        const beforeFinalCheck = snapshot(item.filePath);
        if (beforeFinalCheck.hash !== item.originalHash && beforeFinalCheck.hash !== item.editedHash) fail("OPENCODE_CONFIG_CHANGED");
        options.hooks?.afterFinalCheckBeforeReplace?.(item.filePath);
        const immediatelyBeforeReplace = snapshot(item.filePath);
        if (!sameSnapshot(beforeFinalCheck, immediatelyBeforeReplace)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
        replaceAtomic(item.temporary, item.filePath);
        replaced.push(item);
        options.protectFile(item.filePath);
        options.hooks?.afterReplaceBeforeVerify?.(item.filePath);
        const afterReplace = snapshot(item.filePath);
        if (afterReplace.hash !== item.editedHash) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
        const written = decodeStrictUtf8OpenCodeConfig(fs.readFileSync(item.filePath));
        semanticVerify(written, options.gatewayToken, baseURL);
      }
      options.hooks?.afterVerified?.();
    } catch (error) {
      let rollbackFailed = false;
      for (const item of replaced.reverse()) {
        try {
          const beforeRollback = snapshot(item.filePath);
          if (beforeRollback.hash === item.editedHash) {
            const rollback = `${item.temporary}.rollback`;
            writeProtectedExclusive(rollback, item.original, options.protectFile);
            options.hooks?.beforeRollbackReplace?.(item.filePath);
            if (!sameSnapshot(beforeRollback, snapshot(item.filePath))) {
              try { fs.unlinkSync(rollback); } catch {}
              fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
            }
            replaceAtomic(rollback, item.filePath);
            options.protectFile(item.filePath);
            if (snapshot(item.filePath).hash !== item.originalHash) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
          }
        } catch (rollbackError) {
          if (rollbackError instanceof Error && rollbackError.message === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION") fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) fail("OPENCODE_CONFIG_WRITE_FAILED");
      const code = error instanceof Error && /^OPENCODE_CONFIG_[A-Z_]+$/.test(error.message) ? error.message : "OPENCODE_CONFIG_WRITE_FAILED";
      fail(code);
    }
    return { backups: work.map((item) => item.backup) };
  } finally {
    for (const item of work) try { fs.unlinkSync(item.temporary); } catch {}
    if (lockDescriptor !== undefined) try { fs.closeSync(lockDescriptor); } catch {}
  }
}

/** Restore only files that still exactly contain this operation's verified output. */
export function rollbackOpenCodeConfigs(options: {
  configPaths: string[];
  backups: string[];
  gatewayToken: string;
  port: number;
  protectFile: (filePath: string) => void;
  hooks?: { beforeRollbackReplace?: (filePath: string) => void };
}): void {
  if (!Array.isArray(options.configPaths) || options.configPaths.length !== 2 || !Array.isArray(options.backups) || options.backups.length !== 2) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  const baseURL = `http://127.0.0.1:${options.port}/v1`;
  for (let index = options.configPaths.length - 1; index >= 0; index--) {
    const filePath = options.configPaths[index];
    let original: Buffer;
    try { original = fs.readFileSync(options.backups[index]); decodeStrictUtf8OpenCodeConfig(original); } catch (error) { if (error instanceof Error && error.message === "OPENCODE_CONFIG_MALFORMED") throw error; fail("OPENCODE_CONFIG_BACKUP_UNAVAILABLE"); }
    const expected = Buffer.from(editOpenCodeJsonc(decodeStrictUtf8OpenCodeConfig(original), options.gatewayToken, baseURL));
    const before = snapshot(filePath);
    if (before.hash !== hash(expected)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
    const temporary = `${filePath}.nvgw-rollback.${crypto.randomUUID()}.tmp`;
    try {
      writeProtectedExclusive(temporary, original, options.protectFile);
      options.hooks?.beforeRollbackReplace?.(filePath);
      if (!sameSnapshot(before, snapshot(filePath))) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
      replaceAtomic(temporary, filePath);
      options.protectFile(filePath);
      if (snapshot(filePath).hash !== hash(original)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
}
