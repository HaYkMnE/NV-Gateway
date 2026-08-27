import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeStrictUtf8OpenCodeConfig } from "./opencode-config-decoding";
import { validateOpenCodeConfigForMigration } from "./opencode-config-migration-validation";
import { locateOpenCodeJsoncTargets } from "./opencode-jsonc-targets";

const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
const OPENCODE_TARGETS = [
  path.join(userHome, ".config", "opencode", "opencode.json"),
  path.join(userHome, ".config", "opencode", "opencode.jsonc")
] as const;
function fail(code: string): never { throw new Error(code); }
export function digestOpenCodeConfig(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
export interface MigrationLockOwner { version: 1; operationId: string; instanceId: string; pid: number; lockPath: string }
export function migrationLockPath(statePath: string, operationId: string, instanceId: string): string { return path.join(path.dirname(statePath), `migration.${operationId}.${instanceId}.lock`); }
function validLockOwner(value: unknown): value is MigrationLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1 && typeof owner.operationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.operationId) && typeof owner.instanceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.instanceId) && Number.isInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.lockPath === "string";
}
function liveProcess(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ESRCH"); }
}
function sameLockOwner(left: MigrationLockOwner, right: MigrationLockOwner): boolean { return left.version === right.version && left.operationId === right.operationId && left.instanceId === right.instanceId && left.pid === right.pid && left.lockPath === right.lockPath; }
/** Validates a dead, journal-owned immutable marker before a recovery retry. It never unlinks a pathname. */
export function reconcileFixedMigrationLock(options: { owner: MigrationLockOwner }): void {
  if (!validLockOwner(options.owner)) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  let before: Buffer; let parsed: unknown;
  try { before = fs.readFileSync(options.owner.lockPath); parsed = JSON.parse(before.toString("utf8")); } catch { fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE"); }
  if (!validLockOwner(parsed) || !sameLockOwner(parsed, options.owner) || liveProcess(parsed.pid)) fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE");
  try {
    const current = fs.readFileSync(options.owner.lockPath);
    if (!current.equals(before)) fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE");
  } catch (error) {
    if (error instanceof Error && error.message === "OPENCODE_CONFIG_LOCK_UNAVAILABLE") throw error;
    fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE");
  }
}
function rewrite(source: string, gatewayToken: string, baseURL: string): string { const target = locateOpenCodeJsoncTargets(source); return [{ rawOffset: target.apiKey.rawOffset, length: target.apiKey.length, text: JSON.stringify(gatewayToken) }, { rawOffset: target.baseURL.rawOffset, length: target.baseURL.length, text: JSON.stringify(baseURL) }].sort((left, right) => right.rawOffset - left.rawOffset).reduce((value, replacement) => value.slice(0, replacement.rawOffset) + replacement.text + value.slice(replacement.rawOffset + replacement.length), source); }
function verify(source: string, gatewayToken: string, baseURL: string): void { const target = locateOpenCodeJsoncTargets(source); if (target.apiKey.value !== gatewayToken || target.baseURL.value !== baseURL) fail("OPENCODE_CONFIG_VERIFY_FAILED"); }
interface Snapshot { hash: string; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
function snapshot(filePath: string): Snapshot { try { const stat = fs.statSync(filePath); return { hash: digestOpenCodeConfig(fs.readFileSync(filePath)), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev }; } catch { return fail("OPENCODE_CONFIG_UNAVAILABLE"); } }
function same(left: Snapshot, right: Snapshot): boolean { return left.hash === right.hash && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev; }
function writeProtected(filePath: string, content: Buffer | string, protectFile: (filePath: string) => void): void { const descriptor = fs.openSync(filePath, "wx", 0o600); try { protectFile(filePath); fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } }
function replace(source: string, target: string): void { try { fs.renameSync(source, target); } catch { fail("OPENCODE_CONFIG_WRITE_FAILED"); } }

export function validateFixedOpenCodeRecovery(options: { backups: string[]; originalHashes: string[]; operationId: string }): void {
  if (!Array.isArray(options.backups) || !Array.isArray(options.originalHashes) || options.backups.length !== OPENCODE_TARGETS.length || options.originalHashes.length !== OPENCODE_TARGETS.length) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.operationId)) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  for (let index = 0; index < OPENCODE_TARGETS.length; index++) {
    const target = OPENCODE_TARGETS[index]; const backup = options.backups[index]; const expectedHash = options.originalHashes[index];
    const expectedBackup = path.join(path.dirname(target), `.${path.basename(target)}.nvgw-migration.${options.operationId}.bak`);
    if (typeof backup !== "string" || typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash) || backup !== expectedBackup) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
    let backupStat: fs.Stats; let content: Buffer; try { backupStat = fs.statSync(backup); content = fs.readFileSync(backup); validateOpenCodeConfigForMigration(content); } catch (error) { if (error instanceof Error && /^OPENCODE_CONFIG_/.test(error.message)) throw error; fail("OPENCODE_CONFIG_BACKUP_UNAVAILABLE"); }
    if (!backupStat.isFile() || digestOpenCodeConfig(content) !== expectedHash) fail("OPENCODE_CONFIG_BACKUP_UNAVAILABLE");
  }
}

export function validateFixedOpenCodeRecoveryCurrent(options: { backups: string[]; originalHashes: string[]; operationId: string; gatewayToken: string; port: number }): void {
  validateFixedOpenCodeRecovery(options);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65534) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  const baseURL = `http://127.0.0.1:${options.port}/v1`;
  for (let index = 0; index < OPENCODE_TARGETS.length; index++) {
    let original: Buffer; let current: Buffer;
    let validatedOriginal: ReturnType<typeof validateOpenCodeConfigForMigration>; try { original = fs.readFileSync(options.backups[index]); current = fs.readFileSync(OPENCODE_TARGETS[index]); validatedOriginal = validateOpenCodeConfigForMigration(original); validateOpenCodeConfigForMigration(current); } catch (error) { if (error instanceof Error && /^OPENCODE_CONFIG_/.test(error.message)) throw error; fail("OPENCODE_CONFIG_UNAVAILABLE"); }
    const candidate = Buffer.from(rewrite(validatedOriginal.source, options.gatewayToken, baseURL));
    if (digestOpenCodeConfig(current) !== digestOpenCodeConfig(original) && digestOpenCodeConfig(current) !== digestOpenCodeConfig(candidate)) fail("OPENCODE_CONFIG_CHANGED");
  }
}

export function syncFixedOpenCodeConfigs(options: { gatewayToken: string; port: number; protectFile: (filePath: string) => void; lockOwner: MigrationLockOwner; priorBackups?: string[]; priorBackupHashes?: string[]; onBackups?: (backups: string[], originalHashes: string[]) => void; onVerified?: () => void }): { backups: string[]; originalHashes: string[] } {
  const { gatewayToken, port, protectFile } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65534) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  if (!validLockOwner(options.lockOwner)) fail("OPENCODE_CONFIG_ARGUMENT_INVALID");
  const lockOwner = options.lockOwner;
  const operationId = lockOwner.operationId; const baseURL = `http://127.0.0.1:${port}/v1`; let lock: number | undefined;
  const work: Array<{ target: string; original: Buffer; expected: string; backup: string; temporary: string }> = [];
  try {
    try { lock = fs.openSync(lockOwner.lockPath, "wx", 0o600); protectFile(lockOwner.lockPath); fs.writeFileSync(lock, JSON.stringify(lockOwner)); fs.fsyncSync(lock); } catch { fail("OPENCODE_CONFIG_LOCK_UNAVAILABLE"); }
    if (options.priorBackups) validateFixedOpenCodeRecovery({ backups: options.priorBackups, originalHashes: options.priorBackupHashes ?? [], operationId });
    for (let index = 0; index < OPENCODE_TARGETS.length; index++) { const target = OPENCODE_TARGETS[index]; let current: Buffer; try { current = fs.readFileSync(target); validateOpenCodeConfigForMigration(current); } catch (error) { if (error instanceof Error && /^OPENCODE_CONFIG_/.test(error.message)) throw error; fail("OPENCODE_CONFIG_UNAVAILABLE"); } const backup = options.priorBackups?.[index]; let original = current; let originalValidated = validateOpenCodeConfigForMigration(original); if (backup) try { original = fs.readFileSync(backup); originalValidated = validateOpenCodeConfigForMigration(original); } catch (error) { if (error instanceof Error && /^OPENCODE_CONFIG_/.test(error.message)) throw error; fail("OPENCODE_CONFIG_BACKUP_UNAVAILABLE"); } const expected = rewrite(originalValidated.source, gatewayToken, baseURL); verify(expected, gatewayToken, baseURL); if (backup && digestOpenCodeConfig(current) !== digestOpenCodeConfig(original) && digestOpenCodeConfig(current) !== digestOpenCodeConfig(expected)) fail("OPENCODE_CONFIG_CHANGED"); const stem = path.basename(target); work.push({ target, original, expected, backup: backup ?? path.join(path.dirname(target), `.${stem}.nvgw-migration.${operationId}.bak`), temporary: path.join(path.dirname(target), `.${stem}.nvgw-migration.${operationId}.tmp`) }); }
    if (!options.priorBackups) { for (const item of work) writeProtected(item.backup, item.original, protectFile); options.onBackups?.(work.map((item) => item.backup), work.map((item) => digestOpenCodeConfig(item.original))); }
    const replaced: typeof work = [];
    try {
      for (const item of work) { const before = snapshot(item.target); if (before.hash === digestOpenCodeConfig(item.expected)) { verify(decodeStrictUtf8OpenCodeConfig(fs.readFileSync(item.target)), gatewayToken, baseURL); continue; } if (before.hash !== digestOpenCodeConfig(item.original)) fail("OPENCODE_CONFIG_CHANGED"); writeProtected(item.temporary, item.expected, protectFile); if (!same(before, snapshot(item.target))) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); replace(item.temporary, item.target); replaced.push(item); protectFile(item.target); const after = snapshot(item.target); if (after.hash !== digestOpenCodeConfig(item.expected)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); verify(decodeStrictUtf8OpenCodeConfig(fs.readFileSync(item.target)), gatewayToken, baseURL); }
    } catch (error) {
      let rollbackFailed = false;
      for (const item of replaced.reverse()) { try { const before = snapshot(item.target); if (before.hash !== digestOpenCodeConfig(item.expected)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); const rollback = `${item.temporary}.rollback`; writeProtected(rollback, item.original, protectFile); if (!same(before, snapshot(item.target))) { try { fs.unlinkSync(rollback); } catch {} fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); } replace(rollback, item.target); protectFile(item.target); if (snapshot(item.target).hash !== digestOpenCodeConfig(item.original)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); } catch (rollbackError) { if (rollbackError instanceof Error && rollbackError.message === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION") throw rollbackError; rollbackFailed = true; } }
      if (rollbackFailed) fail("OPENCODE_CONFIG_WRITE_FAILED");
      if (error instanceof Error && /^OPENCODE_CONFIG_/.test(error.message)) throw error; fail("OPENCODE_CONFIG_WRITE_FAILED");
    }
    options.onVerified?.();
    return { backups: work.map((item) => item.backup), originalHashes: work.map((item) => digestOpenCodeConfig(item.original)) };
  } finally { for (const item of work) try { fs.unlinkSync(item.temporary); } catch {} if (lock !== undefined) try { fs.closeSync(lock); } catch {} }
}

export function rollbackFixedOpenCodeConfigs(options: { backups: string[]; gatewayToken: string; port: number; protectFile: (filePath: string) => void }): void {
  if (!Array.isArray(options.backups) || options.backups.length !== OPENCODE_TARGETS.length) fail("OPENCODE_CONFIG_ARGUMENT_INVALID"); const baseURL = `http://127.0.0.1:${options.port}/v1`;
  for (let index = OPENCODE_TARGETS.length - 1; index >= 0; index--) { const target = OPENCODE_TARGETS[index]; let original: Buffer; let validated: ReturnType<typeof validateOpenCodeConfigForMigration>; try { original = fs.readFileSync(options.backups[index]); validated = validateOpenCodeConfigForMigration(original); } catch (error) { if (error instanceof Error && /^OPENCODE_CONFIG_/.test(error.message)) throw error; fail("OPENCODE_CONFIG_BACKUP_UNAVAILABLE"); } const expected = Buffer.from(rewrite(validated.source, options.gatewayToken, baseURL)); const before = snapshot(target); if (before.hash !== digestOpenCodeConfig(expected)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); const temporary = `${target}.nvgw-rollback.${crypto.randomUUID()}.tmp`; try { writeProtected(temporary, original, options.protectFile); if (!same(before, snapshot(target))) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); replace(temporary, target); options.protectFile(target); if (snapshot(target).hash !== digestOpenCodeConfig(original)) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION"); } catch (error) { if (error instanceof Error && error.message === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION") throw error; fail("OPENCODE_CONFIG_WRITE_FAILED"); } finally { try { fs.unlinkSync(temporary); } catch {} } }
}
