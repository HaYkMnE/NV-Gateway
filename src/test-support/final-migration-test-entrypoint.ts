/**
 * Fixture-only migration runner. Production code never imports this module and
 * electron-builder excludes the complete test-support tree from app.asar.
 */
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { checkPorts } from "../main/port-scanner";
import { prepareLegacyNvidiaMigrationForTests } from "./legacy-nvidia-migration";
import { prepareAppConfigMigrationWrite } from "./migration-app-config";
import { migrationLockPath, reconcileMigrationLockForTests, rollbackOpenCodeConfigs, syncOpenCodeConfigs, type MigrationLockOwner } from "./opencode-jsonc-sync";
import { editOpenCodeJsonc } from "./opencode-jsonc-sync";
import { validateOpenCodeConfigForMigration } from "../main/opencode-config-migration-validation";
import type { GatewayRuntimePaths } from "../main/gateway-runtime";
import type { SecureStore } from "../main/secure-state";
import type { MigrationLifecycle } from "../main/final-migration-workflow";

function fail(code: string): never { throw new Error(code); }
function code(error: unknown): string { return error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "MIGRATION_FAILED"; }

export interface TestMigrationWorkflowOptions {
  runtime: GatewayRuntimePaths;
  store: SecureStore;
  state: Record<string, unknown>;
  protectFile: (filePath: string) => void;
  lifecycle: MigrationLifecycle;
  checkPorts?: typeof checkPorts;
  syncHooks?: Parameters<typeof syncOpenCodeConfigs>[0]["hooks"];
  sourcePath: string;
  configPaths: string[];
  afterAppConfigWrite?: () => void;
  crashAfterVerified?: () => void;
  crashAfterAppConfigWrite?: () => void;
}

function digest(value: Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function lockOwner(value: unknown): MigrationLockOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  const owner = value as Record<string, unknown>;
  if (owner.version !== 1 || typeof owner.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.operationId) || typeof owner.instanceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.instanceId) || !Number.isInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.lockPath !== "string") fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  return owner as unknown as MigrationLockOwner;
}
function appConfigBackup(value: unknown, configPath: string, operationId: string): { backup: string; original: Buffer; candidate: Buffer; originalHash: string; candidateHash: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.backup !== "string" || typeof metadata.originalHash !== "string" || typeof metadata.candidateHash !== "string" || !/^[a-f0-9]{64}$/.test(metadata.originalHash) || !/^[a-f0-9]{64}$/.test(metadata.candidateHash) || metadata.backup !== `${configPath}.nvgw-migration.${operationId}.app-config.bak`) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  let original: Buffer; try { original = fs.readFileSync(metadata.backup); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  const prepared = prepareAppConfigMigrationWrite(configPath, { gatewayPort: 12004, setupComplete: true }, original);
  if (digest(original) !== metadata.originalHash || digest(prepared.candidate) !== metadata.candidateHash) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  return { backup: metadata.backup, original, candidate: prepared.candidate, originalHash: metadata.originalHash, candidateHash: metadata.candidateHash };
}
function createAppConfigBackup(configPath: string, original: Buffer, candidate: Buffer, operationId: string, protectFile: (filePath: string) => void) {
  const backup = `${configPath}.nvgw-migration.${operationId}.app-config.bak`;
  try { const descriptor = fs.openSync(backup, "wx", 0o600); try { protectFile(backup); fs.writeFileSync(descriptor, original); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } if (!fs.readFileSync(backup).equals(original)) fail("MIGRATION_APP_CONFIG_BACKUP_FAILED"); } catch (error) { if (error instanceof Error && error.message === "MIGRATION_APP_CONFIG_BACKUP_FAILED") throw error; fail("MIGRATION_APP_CONFIG_BACKUP_FAILED"); }
  return { backup, original, candidate, originalHash: digest(original), candidateHash: digest(candidate) };
}

function recoverIncompleteJournal(options: TestMigrationWorkflowOptions): { backups?: string[]; lockOwner?: MigrationLockOwner; appConfig?: ReturnType<typeof appConfigBackup>; rollbackAndVerify(): Record<string, unknown> } | undefined {
  const journal = options.state.migrationJournal;
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return undefined;
  const value = journal as Record<string, unknown>;
  if (value.phase === "committed") return undefined;
  if (value.version !== 1 || !["state_prepared", "gateway_ready", "opencode_lock_prepared", "opencode_backup_prepared", "opencode_replaced_verified", "app_config_backup_prepared"].includes(String(value.phase)) || typeof value.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId) || typeof value.stateBackup !== "string") fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  if (value.stateBackup !== `${options.runtime.statePath}.pre-migration.v1.${value.operationId}.bak`) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  try { if (!fs.statSync(value.stateBackup).isFile()) fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  let backups: string[] | undefined; let owner: MigrationLockOwner | undefined; let appConfig;
  if (["opencode_lock_prepared", "opencode_backup_prepared", "opencode_replaced_verified", "app_config_backup_prepared"].includes(String(value.phase))) {
    owner = lockOwner(value.opencodeLock);
    if (owner.operationId !== value.operationId) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
    if (owner.lockPath !== migrationLockPath(options.runtime.statePath, owner.operationId, owner.instanceId)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
  }
  if (["opencode_backup_prepared", "opencode_replaced_verified", "app_config_backup_prepared"].includes(String(value.phase))) {
    if (!Array.isArray(value.opencodeBackups) || !Array.isArray(value.opencodeOriginalHashes) || value.opencodeBackups.length !== options.configPaths.length || value.opencodeOriginalHashes.length !== options.configPaths.length) fail("MIGRATION_JOURNAL_RECOVERY_FAILED");
    backups = value.opencodeBackups as string[];
    try { for (let index = 0; index < backups.length; index++) { const expected = path.join(path.dirname(options.configPaths[index]), `.${path.basename(options.configPaths[index])}.nvgw-migration.${value.operationId}.bak`); const backup = fs.readFileSync(backups[index]); if (backups[index] !== expected || typeof value.opencodeOriginalHashes[index] !== "string" || !/^[a-f0-9]{64}$/.test(value.opencodeOriginalHashes[index]) || crypto.createHash("sha256").update(backup).digest("hex") !== value.opencodeOriginalHashes[index]) fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); validateOpenCodeConfigForMigration(backup); } } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  }
  if (value.phase === "app_config_backup_prepared") {
    appConfig = appConfigBackup(value.appConfigBackup, options.runtime.configPath, value.operationId);
    try { const current = fs.readFileSync(options.runtime.configPath); if (!current.equals(appConfig.original) && !current.equals(appConfig.candidate)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); } catch (error) { if (error instanceof Error && error.message === "MIGRATION_JOURNAL_RECOVERY_FAILED") throw error; fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  }
  return { backups, lockOwner: owner, appConfig, rollbackAndVerify() { try { options.store.restoreVersionedBackup(value.stateBackup as string, options.protectFile); const restored = options.store.initialize?.(); if (!restored || typeof restored !== "object" || Array.isArray(restored) || (restored as Record<string, unknown>).migrationJournal !== undefined) fail("MIGRATION_STATE_ROLLBACK_FAILED"); return restored as Record<string, unknown>; } catch { fail("MIGRATION_STATE_ROLLBACK_FAILED"); } } };
}

export async function runLegacyNvidiaMigrationForTests(options: TestMigrationWorkflowOptions): Promise<{ state: Record<string, unknown>; code: string }> {
  const recovery = recoverIncompleteJournal(options);
  if (recovery?.lockOwner) try { reconcileMigrationLockForTests({ owner: recovery.lockOwner }); } catch { fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  const portCheck = options.checkPorts ?? checkPorts;
  const occupied = await portCheck([12004, 12005]);
  if (occupied[12004] || occupied[12005]) fail("PORT_IN_USE");
  const prepared = prepareLegacyNvidiaMigrationForTests({ sourcePath: options.sourcePath, store: options.store, state: options.state, protectFile: options.protectFile });
  if (prepared.result.code === "ALREADY_MIGRATED" && options.state.migrationJournal && (options.state.migrationJournal as Record<string, unknown>).phase === "committed") return { state: options.state, code: prepared.result.code };
  const credentials = prepared.state.credentials as Record<string, unknown> | undefined;
  if (!credentials || typeof credentials.gatewayToken !== "string") fail("MIGRATION_CREDENTIALS_UNAVAILABLE");
  if (recovery?.backups) try { for (let index = 0; index < options.configPaths.length; index++) { const original = fs.readFileSync(recovery.backups[index]); const current = fs.readFileSync(options.configPaths[index]); const candidate = Buffer.from(editOpenCodeJsonc(validateOpenCodeConfigForMigration(original).source, credentials.gatewayToken, "http://127.0.0.1:12004/v1")); validateOpenCodeConfigForMigration(current); if (!current.equals(original) && !current.equals(candidate)) fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); } } catch (error) { if (error instanceof Error && error.message === "MIGRATION_JOURNAL_RECOVERY_FAILED") throw error; fail("MIGRATION_JOURNAL_RECOVERY_FAILED"); }
  const appConfig = prepareAppConfigMigrationWrite(options.runtime.configPath, { gatewayPort: 12004, setupComplete: true }, recovery?.appConfig?.original);
  let state = options.state;
  let gatewayStarted = false;
  let backups = recovery?.backups;
  let owner = recovery?.lockOwner;
  let durableAppConfig = recovery?.appConfig;
  let appWriteAttempted = false;
  let openCodeVerified = Boolean(recovery?.appConfig);
  try {
    const status = await options.lifecycle.startPrepared(prepared.state, 12004);
    if (status.state !== "running" || status.port !== 12004) fail("MIGRATION_GATEWAY_START_FAILED");
    gatewayStarted = true;
    state = prepared.commit();
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "gateway_ready" } };
    options.store.persist(state);
    const operationId = (state.migrationJournal as Record<string, unknown>).operationId as string; const instanceId = crypto.randomUUID();
    owner = { version: 1, operationId, instanceId, pid: process.pid, lockPath: migrationLockPath(options.runtime.statePath, operationId, instanceId) };
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "opencode_lock_prepared", opencodeLock: owner } };
    options.store.persist(state);
    backups = syncOpenCodeConfigs({
      configPaths: options.configPaths,
      gatewayToken: credentials.gatewayToken,
      port: 12004,
      protectFile: options.protectFile,
      lockOwner: owner,
      priorBackups: recovery?.backups,
      hooks: {
        ...options.syncHooks,
        afterBackups: (created) => {
          const originalHashes = created.map((backup) => crypto.createHash("sha256").update(fs.readFileSync(backup)).digest("hex"));
          state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "opencode_backup_prepared", opencodeBackups: created, opencodeOriginalHashes: originalHashes } };
          options.store.persist(state);
          options.syncHooks?.afterBackups?.(created);
        },
        afterVerified: () => {
          openCodeVerified = true;
          state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "opencode_replaced_verified" } };
          options.store.persist(state);
          options.syncHooks?.afterVerified?.();
        }
      }
    }).backups;
    openCodeVerified = true;
    if (options.crashAfterVerified) options.crashAfterVerified();
    durableAppConfig ??= createAppConfigBackup(options.runtime.configPath, appConfig.original, appConfig.candidate, (state.migrationJournal as Record<string, unknown>).operationId as string, options.protectFile);
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "app_config_backup_prepared", appConfigBackup: { backup: durableAppConfig.backup, originalHash: durableAppConfig.originalHash, candidateHash: durableAppConfig.candidateHash } } };
    options.store.persist(state);
    appWriteAttempted = true;
    appConfig.writeIfCurrent(options.protectFile, { afterReplaceBeforeVerify: options.afterAppConfigWrite });
    options.crashAfterAppConfigWrite?.();
    state = { ...state, migrationJournal: { ...(state.migrationJournal as Record<string, unknown>), phase: "committed", opencodeBackups: backups } };
    state = options.lifecycle.commitPreparedState?.(state) ?? state;
    options.store.persist(state);
    return { state, code: prepared.result.code };
  } catch (error) {
    if (error instanceof Error && error.message === "TEST_SIMULATED_CRASH") throw error;
    let compensationFailed = code(error) === "MIGRATION_APP_CONFIG_ROLLBACK_FAILED";
    let openCodeConcurrent = code(error) === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION";
    let appConfigConcurrent = false;
    if (appWriteAttempted || recovery?.appConfig) try { appConfig.restoreIfOwned(options.protectFile); } catch (rollbackError) { compensationFailed = true; appConfigConcurrent ||= rollbackError instanceof Error && rollbackError.message === "MIGRATION_CONFIG_CONCURRENT_MODIFICATION"; }
    if (openCodeVerified && backups) try { rollbackOpenCodeConfigs({ configPaths: options.configPaths, backups, gatewayToken: credentials.gatewayToken, port: 12004, protectFile: options.protectFile }); } catch (rollbackError) { compensationFailed = true; openCodeConcurrent ||= rollbackError instanceof Error && rollbackError.message === "OPENCODE_CONFIG_CONCURRENT_MODIFICATION"; }
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
