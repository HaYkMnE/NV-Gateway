import * as fs from "node:fs";
import * as path from "node:path";
import { createRuntimeAclProtector, type RuntimeAclProtector } from "./windows-acl";

export const MIGRATION_AUDIT_EVENT = "explicit_migration_phase" as const;
export const MIGRATION_AUDIT_PHASES = [
  "command_started",
  "source_validated",
  "recovery_prevalidated",
  "lifecycle_initializing",
  "child_spawn_requested",
  "child_spawned",
  "gateway_ready",
  "workflow_committed",
  "workflow_failed",
  "fatal_shutdown"
] as const;

export type MigrationAuditPhase = (typeof MIGRATION_AUDIT_PHASES)[number];
type MigrationAuditCode =
  | "LEGACY_SOURCE_UNAVAILABLE" | "LEGACY_SOURCE_NOT_REGULAR" | "LEGACY_SOURCE_TOO_LARGE"
  | "LEGACY_SOURCE_CHANGED_DURING_READ" | "LEGACY_SOURCE_MALFORMED" | "LEGACY_SOURCE_SHAPE"
  | "LEGACY_UPSTREAM_SHAPE" | "LEGACY_KEY_INVALID" | "LEGACY_KEY_DUPLICATE"
  | "LEGACY_SOURCE_CHANGED" | "LEGACY_MIGRATION_IN_PROGRESS" | "LEGACY_MIGRATION_LOCK_UNAVAILABLE"
  | "PORT_IN_USE" | "MIGRATION_CREDENTIALS_UNAVAILABLE" | "MIGRATION_GATEWAY_START_FAILED"
  | "MIGRATION_JOURNAL_RECOVERY_FAILED" | "MIGRATION_STATE_ROLLBACK_FAILED"
  | "MIGRATION_STATE_WRITE_FAILED" | "MIGRATION_APP_CONFIG_BACKUP_FAILED"
  | "MIGRATION_APP_CONFIG_WRITE_FAILED" | "MIGRATION_APP_CONFIG_ROLLBACK_FAILED"
  | "MIGRATION_CONFIG_CONCURRENT_MODIFICATION" | "MIGRATION_ROLLBACK_FAILED"
  | "MIGRATION_LIFECYCLE_INITIALIZATION_FAILED"
  | "MIGRATION_FAILED" | "OPENCODE_CONFIG_CONCURRENT_MODIFICATION"
  | "OPENCODE_CONFIG_MALFORMED" | "MIGRATED" | "ALREADY_MIGRATED";

const MIGRATION_AUDIT_CODES = new Set<MigrationAuditCode>([
  "LEGACY_SOURCE_UNAVAILABLE", "LEGACY_SOURCE_NOT_REGULAR", "LEGACY_SOURCE_TOO_LARGE",
  "LEGACY_SOURCE_CHANGED_DURING_READ", "LEGACY_SOURCE_MALFORMED", "LEGACY_SOURCE_SHAPE",
  "LEGACY_UPSTREAM_SHAPE", "LEGACY_KEY_INVALID", "LEGACY_KEY_DUPLICATE",
  "LEGACY_SOURCE_CHANGED", "LEGACY_MIGRATION_IN_PROGRESS", "LEGACY_MIGRATION_LOCK_UNAVAILABLE",
  "PORT_IN_USE", "MIGRATION_CREDENTIALS_UNAVAILABLE", "MIGRATION_GATEWAY_START_FAILED",
  "MIGRATION_JOURNAL_RECOVERY_FAILED", "MIGRATION_STATE_ROLLBACK_FAILED",
  "MIGRATION_STATE_WRITE_FAILED", "MIGRATION_APP_CONFIG_BACKUP_FAILED",
  "MIGRATION_APP_CONFIG_WRITE_FAILED", "MIGRATION_APP_CONFIG_ROLLBACK_FAILED",
  "MIGRATION_CONFIG_CONCURRENT_MODIFICATION", "MIGRATION_ROLLBACK_FAILED", "MIGRATION_LIFECYCLE_INITIALIZATION_FAILED", "MIGRATION_FAILED",
  "OPENCODE_CONFIG_CONCURRENT_MODIFICATION", "OPENCODE_CONFIG_MALFORMED", "MIGRATED", "ALREADY_MIGRATED"
]);
const MIGRATION_AUDIT_PHASE_SET = new Set<MigrationAuditPhase>(MIGRATION_AUDIT_PHASES);
let runtimeProtector: RuntimeAclProtector | undefined;
const BEST_EFFORT_RUNTIME_PROTECTION: RuntimeAclProtector = {
  protectDirectory(directoryPath) {
    try {
      runtimeProtector ??= createRuntimeAclProtector();
      runtimeProtector.protectDirectory(directoryPath);
    } catch { /* audit protection never changes migration behavior */ }
  },
  protectFile(filePath) {
    try {
      runtimeProtector ??= createRuntimeAclProtector();
      runtimeProtector.protectFile(filePath);
    } catch { /* audit protection never changes migration behavior */ }
  }
};

export interface MigrationPhaseAudit {
  emit(phase: MigrationAuditPhase, values?: Record<string, unknown>): void;
  setFilePath(filePath: string): void;
}

const RECORDED_FAILURES = new WeakSet<object>();

export function emitMigrationWorkflowFailure(audit: MigrationPhaseAudit | undefined, error: unknown, values: Record<string, unknown> = {}): void {
  if (error && typeof error === "object") {
    if (RECORDED_FAILURES.has(error)) return;
    RECORDED_FAILURES.add(error);
  }
  audit?.emit("workflow_failed", { ...values, code: migrationAuditCode(values.code) ?? migrationAuditCodeFromError(error) });
}

export function migrationAuditCode(value: unknown): MigrationAuditCode | undefined {
  return typeof value === "string" && MIGRATION_AUDIT_CODES.has(value as MigrationAuditCode)
    ? value as MigrationAuditCode
    : undefined;
}

export function migrationAuditCodeFromError(error: unknown): MigrationAuditCode | undefined {
  return error instanceof Error ? migrationAuditCode(error.message) : undefined;
}

/**
 * A deliberately isolated logger for opt-in migration phase diagnostics. It
 * records no caller-provided strings and any filesystem error is best-effort.
 */
export function createMigrationPhaseAudit(options: { filePath?: string; protector?: RuntimeAclProtector } = {}): MigrationPhaseAudit {
  let filePath = options.filePath;
  const pending: string[] = [];
  const protector = options.protector ?? BEST_EFFORT_RUNTIME_PROTECTION;

  const append = (line: string): boolean => {
    if (!filePath) return false;
    try {
      const directory = path.dirname(filePath);
      fs.mkdirSync(directory, { recursive: true });
      try { protector.protectDirectory(directory); } catch { /* best-effort audit protection */ }
      fs.closeSync(fs.openSync(filePath, "a", 0o600));
      try { protector.protectFile(filePath); } catch { /* best-effort audit protection */ }
      fs.appendFileSync(filePath, line, "utf8");
      return true;
    } catch {
      return false;
    }
  };

  return {
    emit(phase, values = {}) {
      if (typeof phase !== "string" || !MIGRATION_AUDIT_PHASE_SET.has(phase as MigrationAuditPhase)) return;
      const record: Record<string, string | number> = {
        timestamp: new Date().toISOString(),
        event: MIGRATION_AUDIT_EVENT,
        phase: phase as MigrationAuditPhase
      };
      const safeValues = values && typeof values === "object" ? values : {};
      const code = migrationAuditCode(readOwnDataValue(safeValues, "code"));
      if (code) record.code = code;
      const pid = readOwnDataValue(safeValues, "pid");
      const childPid = readOwnDataValue(safeValues, "childPid");
      if (isPositiveInteger(pid)) record.pid = pid;
      if (isPositiveInteger(childPid)) record.childPid = childPid;
      const line = `${JSON.stringify(record)}\n`;
      if (!append(line) && !filePath) pending.push(line);
    },
    setFilePath(nextFilePath) {
      if (filePath) return;
      filePath = nextFilePath;
      while (pending.length > 0) {
        const line = pending.shift() as string;
        if (!append(line)) break;
      }
    }
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function readOwnDataValue(value: object, field: "code" | "pid" | "childPid"): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor && descriptor.get === undefined && descriptor.set === undefined ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
