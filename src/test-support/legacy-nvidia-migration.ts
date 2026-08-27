import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_CHILD_KEYS, type GatewayKeyProjection } from "../main/state-ownership";
import { parseLegacyNvidiaDocument } from "../main/legacy-nvidia-schema";

export const LEGACY_NVIDIA_MAX_BYTES = 1_048_576;
export interface MigrationStore { createVersionedBackup(label: string, protect?: (filePath: string) => void, operationId?: string): string; restoreVersionedBackup(backupPath: string, protect?: (filePath: string) => void): void; persist(state: unknown): void; initialize?(): unknown; }
export interface LegacyMigrationResult { code: "MIGRATED" | "ALREADY_MIGRATED"; importedCount: number; existingCount: number }
export interface PreparedLegacyMigration { result: LegacyMigrationResult; state: Record<string, unknown>; commit(): Record<string, unknown>; rollbackAndVerify(): Record<string, unknown>; }
type SourceFs = Pick<typeof fs, "lstatSync" | "realpathSync" | "readFileSync" | "openSync" | "fstatSync" | "closeSync">;
function fail(code: string): never { throw new Error(code); }
function isReparseOrLink(stat: fs.Stats): boolean { return stat.isSymbolicLink() || (((stat as unknown as { fileAttributes?: number }).fileAttributes ?? 0) & 0x400) !== 0; }
function sameIdentity(left: fs.Stats, right: fs.Stats): boolean { const attributes = (value: fs.Stats) => (value as unknown as { fileAttributes?: number }).fileAttributes ?? 0; return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && attributes(left) === attributes(right); }
function assertNoReparseAncestors(sourcePath: string, sourceFs: SourceFs): void {
  const resolved = path.resolve(sourcePath); const parsed = path.parse(resolved); let current = parsed.root;
  for (const piece of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) { current = path.join(current, piece); let stat: fs.Stats; try { stat = sourceFs.lstatSync(current); } catch { fail("LEGACY_SOURCE_UNAVAILABLE"); } if (isReparseOrLink(stat)) fail("LEGACY_SOURCE_NOT_REGULAR"); }
  try { if (path.resolve(sourceFs.realpathSync(resolved)) !== resolved) fail("LEGACY_SOURCE_NOT_REGULAR"); } catch (error) { if (error instanceof Error && error.message === "LEGACY_SOURCE_NOT_REGULAR") throw error; fail("LEGACY_SOURCE_UNAVAILABLE"); }
}
export function readStrictLegacySourceForTests(sourcePath: string, overrides: Partial<SourceFs> = {}): { keys: string[]; fingerprint: string } {
  const sourceFs = { ...fs, ...overrides } as SourceFs; assertNoReparseAncestors(sourcePath, sourceFs); let descriptor: number | undefined; let bytes: Buffer; let before: fs.Stats;
  try { before = sourceFs.lstatSync(sourcePath); if (!before.isFile() || isReparseOrLink(before)) fail("LEGACY_SOURCE_NOT_REGULAR"); if (before.size > LEGACY_NVIDIA_MAX_BYTES) fail("LEGACY_SOURCE_TOO_LARGE"); descriptor = sourceFs.openSync(sourcePath, "r"); const opened = sourceFs.fstatSync(descriptor); if (!opened.isFile() || isReparseOrLink(opened) || !sameIdentity(before, opened)) fail("LEGACY_SOURCE_CHANGED_DURING_READ"); bytes = sourceFs.readFileSync(descriptor) as Buffer; if (!sameIdentity(opened, sourceFs.fstatSync(descriptor)) || !sameIdentity(before, sourceFs.lstatSync(sourcePath))) fail("LEGACY_SOURCE_CHANGED_DURING_READ"); } catch (error) { if (error instanceof Error && /^LEGACY_SOURCE_/.test(error.message)) throw error; return fail("LEGACY_SOURCE_UNAVAILABLE"); } finally { if (descriptor !== undefined) try { sourceFs.closeSync(descriptor); } catch {} }
  if (bytes!.length > LEGACY_NVIDIA_MAX_BYTES) fail("LEGACY_SOURCE_TOO_LARGE"); let parsed: unknown; try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return fail("LEGACY_SOURCE_MALFORMED"); }
  const keys = parseLegacyNvidiaDocument(parsed);
  return { keys, fingerprint: crypto.createHash("sha256").update(bytes!).digest("hex") };
}
function emptyUsage(): GatewayKeyProjection["usage"] { return { success: 0, fail: 0, tokens: 0, lastUsed: 0 }; }
export function prepareLegacyNvidiaMigrationForTests(options: { sourcePath: string; store: MigrationStore; state: unknown; protectFile?: (filePath: string) => void }): PreparedLegacyMigration {
  const { keys: sourceKeys, fingerprint } = readStrictLegacySourceForTests(options.sourcePath); if (!options.state || typeof options.state !== "object" || Array.isArray(options.state)) fail("MIGRATION_STATE_INVALID"); const prior = options.state as Record<string, unknown>; const marker = prior.legacyNvidiaMigration as Record<string, unknown> | undefined;
  if (marker) { if (marker.sourceFingerprint !== fingerprint) fail("LEGACY_SOURCE_CHANGED"); return { result: { code: "ALREADY_MIGRATED", importedCount: 0, existingCount: Array.isArray(prior.keys) ? prior.keys.length : 0 }, state: prior, commit: () => prior, rollbackAndVerify: () => prior }; }
  if (!Array.isArray(prior.keys) || prior.keys.length > MAX_CHILD_KEYS) fail("MIGRATION_STATE_INVALID"); const existingByKey = new Map<string, GatewayKeyProjection>(); for (const record of prior.keys) { if (!record || typeof record !== "object" || typeof (record as Record<string, unknown>).key !== "string") fail("MIGRATION_STATE_INVALID"); existingByKey.set((record as GatewayKeyProjection).key, record as GatewayKeyProjection); }
  const newKeys = sourceKeys.filter((key) => !existingByKey.has(key)); if (prior.keys.length + newKeys.length > MAX_CHILD_KEYS) fail("MIGRATION_KEY_LIMIT"); const operationId = crypto.randomUUID(); let backupPath: string; try { backupPath = options.store.createVersionedBackup("pre-migration", options.protectFile, operationId); } catch { return fail("MIGRATION_BACKUP_FAILED"); }
  const next = { ...prior, keys: [...sourceKeys.map((key) => existingByKey.get(key) ?? { id: crypto.randomUUID(), key, status: "active" as const, backoffUntil: 0, usage: emptyUsage() }), ...prior.keys.filter((record) => !sourceKeys.includes((record as GatewayKeyProjection).key))], legacyNvidiaMigration: { version: 1, sourceFingerprint: fingerprint, importedCount: sourceKeys.length, importedAt: new Date().toISOString() }, migrationJournal: { version: 1, phase: "state_prepared", operationId, stateBackup: backupPath } };
  const result = { code: "MIGRATED" as const, importedCount: newKeys.length, existingCount: sourceKeys.length - newKeys.length };
  return { result, state: next, commit: () => { try { options.store.persist(next); return next; } catch { fail("MIGRATION_STATE_WRITE_FAILED"); } }, rollbackAndVerify: () => { try { options.store.restoreVersionedBackup(backupPath, options.protectFile); const restored = options.store.initialize?.(); if (!restored || JSON.stringify(restored) !== JSON.stringify(prior)) fail("MIGRATION_STATE_ROLLBACK_FAILED"); return restored as Record<string, unknown>; } catch (error) { if (error instanceof Error && error.message === "MIGRATION_STATE_ROLLBACK_FAILED") throw error; fail("MIGRATION_STATE_ROLLBACK_FAILED"); } } };
}
export function migrateLegacyNvidiaForTests(options: Parameters<typeof prepareLegacyNvidiaMigrationForTests>[0]): LegacyMigrationResult { const prepared = prepareLegacyNvidiaMigrationForTests(options); if (prepared.result.code === "ALREADY_MIGRATED") return prepared.result; try { prepared.commit(); } catch (error) { try { prepared.rollbackAndVerify(); } catch {} throw error; } return prepared.result; }
