import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { checkPorts } from "./port-scanner";
import { prepareLegacyNvidiaMigration, type ValidatedLegacyNvidiaSource } from "./legacy-nvidia-migration";
import { migrationLockPath, reconcileFixedMigrationLock, rollbackFixedOpenCodeConfigs, syncFixedOpenCodeConfigs, validateFixedOpenCodeRecovery, validateFixedOpenCodeRecoveryCurrent, type MigrationLockOwner } from "./opencode-jsonc-sync";
import type { GatewayRuntimePaths } from "./gateway-runtime";
import type { SecureStore } from "./secure-state";
import { emitMigrationWorkflowFailure, type MigrationPhaseAudit } from "./migration-phase-audit";

export const FINAL_MIGRATION_PORT = 12004;
function fail(code: string): never { throw new Error(code); }
function code(error: unknown): string { return error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "MIGRATION_FAILED"; }

export interface MigrationLifecycle {
  startPrepared(state: Record<string, unknown>, port: number): Promise<{ state: string; port?: number }>;
  stopPrepared(): Promise<unknown>;
  /** Atomically releases any child projections buffered during readiness. */
  commitPreparedState?(state: Record<string, unknown>): Record<string, unknown>;
}

export interface ExplicitMigrationWorkflowOptions {
  runtime: GatewayRuntimePaths;
  store: SecureStore;
  state: Record<string, unknown>;
  protectFile: (filePath: string) => void;
  lifecycle: MigrationLifecycle;
  source?: ValidatedLegacyNvidiaSource;
  audit?: MigrationPhaseAudit;
}

interface AppConfigRecovery { original: Buffer; candidate: Buffer; backup: string; originalHash: string; candidateHash: string }
interface IncompleteMigrationRecovery { backups?: string[]; originalHashes?: string[]; lockOwner?: MigrationLockOwner; appConfig?: AppConfigRecovery; rollbackAndVerify(): Record<string, unknown> }
interface FileSnapshot { content: Buffer; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }

function digest(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function snapshot(filePath: string): FileSnapshot {
  const before = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
  return { content, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev };
}
function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.content.equals(right.content) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev;
}
function writeProtectedExclusive(filePath: string, content: Buffer, protectFile: (filePath: string) => void): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try { protectFile(filePath); fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function removeTemporaryIfOwned(filePath: string, expected: Buffer): void {
  try { if (fs.readFileSync(filePath).equals(expected)) fs.unlinkSync(filePath); } catch {}
}
function exactAppConfigBackup(value: unknown, configPath: string, operationId: string): AppConfigRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.backup !== "string" || typeof metadata.originalHash !== "string" || typeof metadata.candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.originalHash) || !/^[a-f0-9]{64}$/.test(metadata.candidateHash)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  if (metadata.backup !== `${configPath}.nvgw-migration.${operationId}.app-config.bak`) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  let original: Buffer;
  try { original = fs.readFileSync(metadata.backup); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  const candidate = createAppConfigCandidate(original);
  if (digest(original) !== metadata.originalHash || digest(candidate) !== metadata.candidateHash) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  return { original, candidate, backup: metadata.backup, originalHash: metadata.originalHash, candidateHash: metadata.candidateHash };
}

function journalLockOwner(value: unknown): MigrationLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  const owner = value as Record<string, unknown>;
  if (owner.version !== 1 || typeof owner.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.operationId) || typeof owner.instanceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.instanceId) || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.lockPath !== "string") fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  return owner as unknown as MigrationLockOwner;
}

function incompleteMigrationRecovery(options: ExplicitMigrationWorkflowOptions): IncompleteMigrationRecovery | undefined {
  const journal = options.state.migrationJournal;
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return undefined;
  const value = journal as Record<string, unknown>;
  if (value.phase === "committed") return undefined;
  if (value.version !== 1 || !["state_prepared", "gateway_ready", "opencode_lock_prepared", "opencode_backup_prepared", "opencode_replaced_verified", "app_config_backup_prepared"].includes(String(value.phase)) || typeof value.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId) || typeof value.stateBackup !== "string") fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  if (value.stateBackup !== `${options.runtime.statePath}.pre-migration.v1.${value.operationId}.bak`) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  try { if (!fs.statSync(value.stateBackup).isFile()) fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); } catch (error) { if (error instanceof Error && error.message === "MIGRATION_JOURNAL_RECOVERY_FAILED") throw error; fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  let backups: string[] | undefined; let originalHashes: string[] | undefined; let lockOwner: MigrationLockOwner | undefined; let appConfig: AppConfigRecovery | undefined;
  if (["opencode_lock_prepared", "opencode_backup_prepared", "opencode_replaced_verified", "app_config_backup_prepared"].includes(String(value.phase))) {
    lockOwner = journalLockOwner(value.opencodeLock);
    if (lockOwner.operationId !== value.operationId) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
    if (lockOwner.lockPath !== migrationLockPath(options.runtime.statePath, lockOwner.operationId, lockOwner.instanceId)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  }
  if (["opencode_backup_prepared", "opencode_replaced_verified", "app_config_backup_prepared"].includes(String(value.phase))) {
    if (!Array.isArray(value.opencodeBackups) || !Array.isArray(value.opencodeOriginalHashes) || !value.opencodeBackups.every((item) => typeof item === "string") || !value.opencodeOriginalHashes.every((item) => typeof item === "string")) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
    backups = value.opencodeBackups as string[]; originalHashes = value.opencodeOriginalHashes as string[];
    try { validateFixedOpenCodeRecovery({ backups, originalHashes, operationId: value.operationId }); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  }
  if (value.phase === "app_config_backup_prepared") {
    appConfig = exactAppConfigBackup(value.appConfigBackup, options.runtime.configPath, value.operationId);
    try { const current = readAppConfigBytes(options.runtime.configPath); if (!current.equals(appConfig.original) && !current.equals(appConfig.candidate)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); } catch (error) { if (error instanceof Error && error.message === "MIGRATION_JOURNAL_RECOVERY_FAILED") throw error; fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  }
  return {
    backups,
    originalHashes,
    lockOwner,
    appConfig,
    rollbackAndVerify() {
      try {
        options.store.restoreVersionedBackup(value.stateBackup as string, options.protectFile);
        const restored = options.store.initialize?.();
        if (!restored || typeof restored !== "object" || Array.isArray(restored) || (restored as Record<string, unknown>).migrationJournal !== undefined) fail("MIGRATION_STATE_ROLLBACK_FAILED");
        return restored as Record<string, unknown>;
      } catch { fail("MIGRATION_STATE_ROLLBACK_FAILED"); }
    }
  };
}

/** Runs immutable recovery validation before any recovery-dependent migration work. */
export async function runRecoveryPrevalidationBeforeWork<T, Result>(validate: () => T, work: (validated: T) => Promise<Result>): Promise<Result> {
  let validated: T;
  try { validated = validate(); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  return work(validated);
}

async function runMigrationAfterRecovery(options: ExplicitMigrationWorkflowOptions, recovery: IncompleteMigrationRecovery | undefined): Promise<{ state: Record<string, unknown>; code: string }> {
  if (recovery?.lockOwner) try { reconcileFixedMigrationLock({ owner: recovery.lockOwner }); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  const occupied = await checkPorts([FINAL_MIGRATION_PORT, FINAL_MIGRATION_PORT + 1]);
  if (occupied[FINAL_MIGRATION_PORT] || occupied[FINAL_MIGRATION_PORT + 1]) fail("PORT_IN_USE");
  const prepared = prepareLegacyNvidiaMigration({ store: options.store, state: options.state, protectFile: options.protectFile, source: options.source });
  if (prepared.result.code === "ALREADY_MIGRATED" && (options.state as Record<string, unknown>).migrationJournal && ((options.state as Record<string, unknown>).migrationJournal as Record<string, unknown>).phase === "committed") return { state: options.state, code: prepared.result.code };
  const credentials = prepared.state.credentials as Record<string, unknown> | undefined;
  if (!credentials || typeof credentials.gatewayToken !== "string") fail("MIGRATION_CREDENTIALS_UNAVAILABLE");
  if (recovery?.backups && recovery.originalHashes) try { validateFixedOpenCodeRecoveryCurrent({ backups: recovery.backups, originalHashes: recovery.originalHashes, operationId: (options.state.migrationJournal as Record<string, unknown>).operationId as string, gatewayToken: credentials.gatewayToken, port: FINAL_MIGRATION_PORT }); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  const appConfig = prepareAppConfigMigrationWrite(options.runtime.configPath, recovery?.appConfig?.original);
  let state = options.state;
  let gatewayStarted = false;
  let backups = recovery?.backups;
  let backupHashes = recovery?.originalHashes;
  let lockOwner = recovery?.lockOwner;
  let appConfigBackup = recovery?.appConfig;
  let appWriteAttempted = false;
  let openCodeVerified = Boolean(recovery?.appConfig);
  try {
    const status = await options.lifecycle.startPrepared(prepared.state, FINAL_MIGRATION_PORT);
    if (status.state !== "running" || status.port !== FINAL_MIGRATION_PORT) fail("MIGRATION_GATEWAY_START_FAILED");
    gatewayStarted = true;
    options.audit?.emit("gateway_ready", { pid: process.pid });
    state = prepared.commit();
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "gateway_ready" } };
    options.store.persist(state);
    const operationId = (state.migrationJournal as Record<string, unknown>).operationId as string; const instanceId = crypto.randomUUID();
    lockOwner = { version: 1, operationId, instanceId, pid: process.pid, lockPath: migrationLockPath(options.runtime.statePath, operationId, instanceId) };
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "opencode_lock_prepared", opencodeLock: lockOwner } };
    options.store.persist(state);
    backups = syncFixedOpenCodeConfigs({
      gatewayToken: credentials.gatewayToken,
      port: FINAL_MIGRATION_PORT,
      protectFile: options.protectFile,
      lockOwner,
      priorBackups: recovery?.backups,
      priorBackupHashes: recovery?.originalHashes,
      onBackups: (created, originalHashes) => {
        backups = created; backupHashes = originalHashes;
        state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "opencode_backup_prepared", opencodeBackups: created, opencodeOriginalHashes: originalHashes } };
        options.store.persist(state);
      },
      onVerified: () => {
        openCodeVerified = true;
        state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "opencode_replaced_verified" } };
        options.store.persist(state);
      }
    }).backups;
    appConfigBackup ??= createAppConfigRecovery(options.runtime.configPath, appConfig.original, appConfig.candidate, (state.migrationJournal as Record<string, unknown>).operationId as string, options.protectFile);
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "app_config_backup_prepared", appConfigBackup: { backup: appConfigBackup.backup, originalHash: appConfigBackup.originalHash, candidateHash: appConfigBackup.candidateHash } } };
    options.store.persist(state);
    appWriteAttempted = true;
    appConfig.writeIfCurrent(options.protectFile);
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "committed", opencodeBackups: backups, opencodeOriginalHashes: backupHashes, appConfigBackup: { backup: appConfigBackup.backup, originalHash: appConfigBackup.originalHash, candidateHash: appConfigBackup.candidateHash } } };
    state = options.lifecycle.commitPreparedState?.(state) ?? state;
    options.store.persist(state);
    const result = { state, code: prepared.result.code };
    options.audit?.emit("workflow_committed", { pid: process.pid, code: result.code });
    return result;
  } catch (error) {
    let compensationFailed = code(error) === "MIGRATION_APP_CONFIG_ROLLBACK_FAILED";
    let openCodeConcurrent = code(error) === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION";
    let appConfigConcurrent = false;
    if (appWriteAttempted || recovery?.appConfig) try { appConfig.restoreIfOwned(options.protectFile); } catch (rollbackError) { compensationFailed = true; appConfigConcurrent ||= rollbackError instanceof Error && rollbackError.message === "MIGRATION_CONFIG_CONCURRENT_MODIFICATION"; }
    if (openCodeVerified && backups) try { rollbackFixedOpenCodeConfigs({ backups, gatewayToken: credentials.gatewayToken, port: FINAL_MIGRATION_PORT, protectFile: options.protectFile }); } catch (rollbackError) { compensationFailed = true; openCodeConcurrent ||= rollbackError instanceof Error && rollbackError.message === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION"; }
    try { state = recovery ? recovery.rollbackAndVerify() : prepared.rollbackAndVerify(); } catch { compensationFailed = true; }
    if (gatewayStarted) try { await options.lifecycle.stopPrepared(); } catch { compensationFailed = true; }
    if (openCodeConcurrent) fail("OPENCODE_CONFIG_CONCURRENT_MODIFICATION");
    if (appConfigConcurrent) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
    if (compensationFailed) fail("MIGRATION_ROLLBACK_FAILED");
    const failure = code(error);
    if (failure === "MIGRATION_GATEWAY_START_FAILED" || failure.startsWith("MIGRATION_")) fail(failure);
    fail("MIGRATION_FAILED");
  }
}

async function runMigrationWorkflow(options: ExplicitMigrationWorkflowOptions): Promise<{ state: Record<string, unknown>; code: string }> {
  try {
    return await runRecoveryPrevalidationBeforeWork(
      () => incompleteMigrationRecovery(options),
      (recovery) => {
        options.audit?.emit("recovery_prevalidated", { pid: process.pid });
        return runMigrationAfterRecovery(options, recovery);
      }
    );
  } catch (error) {
    emitMigrationWorkflowFailure(options.audit, error, { pid: process.pid });
    throw error;
  }
}

function createAppConfigRecovery(configPath: string, original: Buffer, candidate: Buffer, operationId: string, protectFile: (filePath: string) => void): AppConfigRecovery {
  const backup = `${configPath}.nvgw-migration.${operationId}.app-config.bak`;
  try { const descriptor = fs.openSync(backup, "wx", 0o600); try { protectFile(backup); fs.writeFileSync(descriptor, original); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } } catch { fail("MIGRATION_APP_CONFIG_BACKUP_FAILED"); }
  try { if (!fs.readFileSync(backup).equals(original)) fail("MIGRATION_APP_CONFIG_BACKUP_FAILED"); } catch (error) { if (error instanceof Error && error.message === "MIGRATION_APP_CONFIG_BACKUP_FAILED") throw error; fail("MIGRATION_APP_CONFIG_BACKUP_FAILED"); }
  return { backup, original, candidate, originalHash: digest(original), candidateHash: digest(candidate) };
}

function prepareAppConfigMigrationWrite(configPath: string, baseline?: Buffer): { original: Buffer; candidate: Buffer; writeIfCurrent(protectFile: (filePath: string) => void): void; restoreIfOwned(protectFile: (filePath: string) => void): void } {
  const original = baseline ?? readAppConfigBytes(configPath);
  const candidate = createAppConfigCandidate(original);
  const same = (value: Buffer, expected: Buffer) => value.equals(expected);
  const retainProtectedRecovery = (protectFile: (filePath: string) => void): void => {
    const recovery = `${configPath}.migration-rollback-recovery.${crypto.randomUUID()}.bak`;
    let retained = false;
    try {
      const descriptor = fs.openSync(recovery, "wx", 0o600);
      try { protectFile(recovery); fs.writeFileSync(descriptor, original); fs.fsyncSync(descriptor); retained = true; } finally { fs.closeSync(descriptor); }
    } finally { if (!retained) try { fs.unlinkSync(recovery); } catch {} }
  };
  const restoreOwned = (protectFile: (filePath: string) => void): void => {
    const temporary = `${configPath}.migration-rollback.${crypto.randomUUID()}.tmp`;
    try {
      const beforeReplacement = snapshot(configPath);
      if (same(beforeReplacement.content, original)) return;
      if (!same(beforeReplacement.content, candidate)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      writeProtectedExclusive(temporary, original, protectFile);
      if (!same(readAppConfigBytes(temporary), original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      if (!same(readAppConfigBytes(temporary), original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      fs.renameSync(temporary, configPath); protectFile(configPath);
      if (!same(readAppConfigBytes(configPath), original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
    } catch (error) {
      if (error instanceof Error && error.message === "MIGRATION_CONFIG_CONCURRENT_MODIFICATION") throw error;
      try { if (same(readAppConfigBytes(configPath), original)) retainProtectedRecovery(protectFile); } catch {}
      fail("MIGRATION_APP_CONFIG_ROLLBACK_FAILED");
    } finally { removeTemporaryIfOwned(temporary, original); }
  };
  return {
      writeIfCurrent(protectFile) {
      const temporary = `${configPath}.migration-write.${crypto.randomUUID()}.tmp`;
      let replaced = false;
      try {
        const beforeReplacement = snapshot(configPath);
        if (same(beforeReplacement.content, candidate)) return;
        if (!same(beforeReplacement.content, original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        writeProtectedExclusive(temporary, candidate, protectFile);
        if (!same(readAppConfigBytes(temporary), candidate)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        if (!same(readAppConfigBytes(temporary), candidate)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        replaced = true; fs.renameSync(temporary, configPath); protectFile(configPath);
        if (!same(readAppConfigBytes(configPath), candidate)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      } catch (error) {
        if (replaced) {
          try { restoreOwned(protectFile); } catch (restoreError) {
            if (restoreError instanceof Error && restoreError.message === "MIGRATION_CONFIG_CONCURRENT_MODIFICATION") throw restoreError;
            fail("MIGRATION_APP_CONFIG_ROLLBACK_FAILED");
          }
        }
        if (error instanceof Error && /^MIGRATION_(?:CONFIG_CONCURRENT_MODIFICATION|APP_CONFIG_WRITE_FAILED)$/.test(error.message)) throw error;
        fail("MIGRATION_APP_CONFIG_WRITE_FAILED");
      } finally { removeTemporaryIfOwned(temporary, candidate); }
    },
    original,
    candidate,
    restoreIfOwned(protectFile) {
      restoreOwned(protectFile);
    }
  };
}

function readAppConfigBytes(configPath: string): Buffer { try { return fs.readFileSync(configPath); } catch { return fail("MIGRATION_APP_CONFIG_WRITE_FAILED"); } }
function createAppConfigCandidate(original: Buffer): Buffer {
  let existing: Record<string, unknown> = {};
  try { const parsed = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, "")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>; } catch {}
  const gatewayPort = typeof existing.gatewayPort === "number" && Number.isInteger(existing.gatewayPort) && existing.gatewayPort >= 1 && existing.gatewayPort <= 65534 ? existing.gatewayPort : 12004;
  const language = typeof existing.language === "string" && ["en", "ru", "zh", "hi", "es", "fr", "ar"].includes(existing.language) ? existing.language : "en";
  return Buffer.from(JSON.stringify({ ...existing, version: 1, gatewayPort: FINAL_MIGRATION_PORT, language, setupComplete: true }, null, 2), "utf8");
}

/** Production entrypoint: no caller can redirect legacy or OpenCode paths. */
export async function runExplicitLegacyNvidiaMigration(options: ExplicitMigrationWorkflowOptions): Promise<{ state: Record<string, unknown>; code: string }> {
  return runMigrationWorkflow(options);
}
