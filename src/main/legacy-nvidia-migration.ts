import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_CHILD_KEYS, type GatewayKeyProjection } from "./state-ownership";
import { parseLegacyNvidiaDocument } from "./legacy-nvidia-schema";

const systemDrive = process.env.SystemDrive || "C:";
export const LEGACY_NVIDIA_SOURCE = process.env.LEGACY_NVIDIA_SOURCE || path.join(systemDrive, "OPENCODE-PROVIDER", "RotatingGateway", "config", "nvidia.json");
export const LEGACY_NVIDIA_MAX_BYTES = 1_048_576;

export interface MigrationStore {
  createVersionedBackup(label: string, protect?: (filePath: string) => void, operationId?: string): string;
  restoreVersionedBackup(backupPath: string, protect?: (filePath: string) => void): void;
  persist(state: unknown): void;
  initialize?(): unknown;
}

function fail(code: string): never { throw new Error(code); }

function isReparseOrLink(stat: fs.Stats): boolean { return stat.isSymbolicLink() || (((stat as unknown as { fileAttributes?: number }).fileAttributes ?? 0) & 0x400) !== 0; }
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { const attributes = (value: fs.Stats) => (value as unknown as { fileAttributes?: number }).fileAttributes ?? 0; return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && attributes(left) === attributes(right); }
function assertFixedSourceHasNoReparseAncestors(): void {
  const parsed = path.parse(LEGACY_NVIDIA_SOURCE); let current = parsed.root;
  for (const piece of LEGACY_NVIDIA_SOURCE.slice(parsed.root.length).split(path.sep).filter(Boolean)) { current = path.join(current, piece); let stat: fs.Stats; try { stat = fs.lstatSync(current); } catch { fail("LEGACY_SOURCE_UNAVAILABLE"); } if (isReparseOrLink(stat)) fail("LEGACY_SOURCE_NOT_REGULAR"); }
  try { if (path.resolve(fs.realpathSync(LEGACY_NVIDIA_SOURCE)) !== LEGACY_NVIDIA_SOURCE) fail("LEGACY_SOURCE_NOT_REGULAR"); } catch (error) { if (error instanceof Error && error.message === "LEGACY_SOURCE_NOT_REGULAR") throw error; fail("LEGACY_SOURCE_UNAVAILABLE"); }
}

function readStrictLegacySource(): { keys: string[]; fingerprint: string } {
  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    assertFixedSourceHasNoReparseAncestors();
    const before = fs.lstatSync(LEGACY_NVIDIA_SOURCE);
    if (!before.isFile() || isReparseOrLink(before) || before.size > LEGACY_NVIDIA_MAX_BYTES) fail(before.size > LEGACY_NVIDIA_MAX_BYTES ? "LEGACY_SOURCE_TOO_LARGE" : "LEGACY_SOURCE_NOT_REGULAR");
    descriptor = fs.openSync(LEGACY_NVIDIA_SOURCE, "r");
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || isReparseOrLink(opened) || !sameIdentity(before, opened)) fail("LEGACY_SOURCE_CHANGED_DURING_READ");
    bytes = fs.readFileSync(descriptor) as Buffer;
    if (!sameIdentity(opened, fs.fstatSync(descriptor)) || !sameIdentity(before, fs.lstatSync(LEGACY_NVIDIA_SOURCE))) fail("LEGACY_SOURCE_CHANGED_DURING_READ");
  } catch (error) {
    if (error instanceof Error && /^LEGACY_SOURCE_/.test(error.message)) throw error;
    return fail("LEGACY_SOURCE_UNAVAILABLE");
  } finally { if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {} }
  if (bytes!.length > LEGACY_NVIDIA_MAX_BYTES) fail("LEGACY_SOURCE_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail("LEGACY_SOURCE_MALFORMED"); }
  const keys = parseLegacyNvidiaDocument(parsed);
  return { keys, fingerprint: crypto.createHash("sha256").update(bytes!).digest("hex") };
}

export interface ValidatedLegacyNvidiaSource {
  keys: string[];
  fingerprint: string;
}

/** Reads the fixed source once and validates it before runtime initialization. */
export function validateFixedLegacyNvidiaSource(): ValidatedLegacyNvidiaSource {
  return readStrictLegacySource();
}

function emptyUsage(): GatewayKeyProjection["usage"] { return { success: 0, fail: 0, tokens: 0, lastUsed: 0 }; }

export interface LegacyMigrationResult { code: "MIGRATED" | "ALREADY_MIGRATED"; importedCount: number; existingCount: number }

export interface PreparedLegacyMigration {
  result: LegacyMigrationResult;
  state: Record<string, unknown>;
  commit(): Record<string, unknown>;
  rollbackAndVerify(): Record<string, unknown>;
}

export function prepareLegacyNvidiaMigration(options: { store: MigrationStore; state: unknown; protectFile?: (filePath: string) => void; source?: ValidatedLegacyNvidiaSource }): PreparedLegacyMigration {
  const { keys: sourceKeys, fingerprint } = options.source ?? validateFixedLegacyNvidiaSource();
  if (!options.state || typeof options.state !== "object" || Array.isArray(options.state)) fail("MIGRATION_STATE_INVALID");
  const prior = options.state as Record<string, unknown>;
  const marker = prior.legacyNvidiaMigration as Record<string, unknown> | undefined;
  if (marker) {
    if (marker.sourceFingerprint !== fingerprint) fail("LEGACY_SOURCE_CHANGED");
    const result = { code: "ALREADY_MIGRATED" as const, importedCount: 0, existingCount: Array.isArray(prior.keys) ? prior.keys.length : 0 };
    return { result, state: prior, commit: () => prior, rollbackAndVerify: () => prior };
  }
  if (!Array.isArray(prior.keys) || prior.keys.length > MAX_CHILD_KEYS) fail("MIGRATION_STATE_INVALID");
  const existingByKey = new Map<string, GatewayKeyProjection>();
  for (const record of prior.keys) {
    if (!record || typeof record !== "object" || typeof (record as Record<string, unknown>).key !== "string") fail("MIGRATION_STATE_INVALID");
    existingByKey.set((record as GatewayKeyProjection).key, record as GatewayKeyProjection);
  }
  const newKeys = sourceKeys.filter((key) => !existingByKey.has(key));
  if (prior.keys.length + newKeys.length > MAX_CHILD_KEYS) fail("MIGRATION_KEY_LIMIT");
  const protect = options.protectFile ?? (() => {});
  const operationId = crypto.randomUUID();
  let backupPath: string;
  try { backupPath = options.store.createVersionedBackup("pre-migration", protect, operationId); } catch { return fail("MIGRATION_BACKUP_FAILED"); }
  const now = new Date().toISOString();
  const migratedKeys = sourceKeys.map((key) => existingByKey.get(key) ?? { id: crypto.randomUUID(), key, status: "active" as const, backoffUntil: 0, usage: emptyUsage() });
  const untouchedKeys = prior.keys.filter((record) => !sourceKeys.includes((record as GatewayKeyProjection).key));
  const next = {
    ...prior,
    keys: [...migratedKeys, ...untouchedKeys],
    legacyNvidiaMigration: { version: 1, sourceFingerprint: fingerprint, importedCount: sourceKeys.length, importedAt: now },
    migrationJournal: { version: 1, phase: "state_prepared", operationId, stateBackup: backupPath }
  };
  const result = { code: "MIGRATED" as const, importedCount: newKeys.length, existingCount: sourceKeys.length - newKeys.length };
  return {
    result,
    state: next,
    commit: () => { try { options.store.persist(next); return next; } catch { fail("MIGRATION_STATE_WRITE_FAILED"); } },
    rollbackAndVerify: () => {
      try {
        options.store.restoreVersionedBackup(backupPath, protect);
        const restored = options.store.initialize?.();
        if (!restored || JSON.stringify(restored) !== JSON.stringify(prior)) fail("MIGRATION_STATE_ROLLBACK_FAILED");
        return restored as Record<string, unknown>;
      } catch (error) {
        if (error instanceof Error && error.message === "MIGRATION_STATE_ROLLBACK_FAILED") throw error;
        fail("MIGRATION_STATE_ROLLBACK_FAILED");
      }
    }
  };
}

export function migrateLegacyNvidia(options: { store: MigrationStore; state: unknown; protectFile?: (filePath: string) => void }): LegacyMigrationResult {
  const prepared = prepareLegacyNvidiaMigration(options);
  if (prepared.result.code === "ALREADY_MIGRATED") return prepared.result;
  try { prepared.commit(); } catch (error) {
    try { prepared.rollbackAndVerify(); } catch {}
    throw error;
  }
  return prepared.result;
}
