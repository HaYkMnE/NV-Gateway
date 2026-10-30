import { emitMigrationWorkflowFailure, type MigrationPhaseAudit } from "./migration-phase-audit";

const KNOWN_PREPARED_LEGACY_SOURCE_FAILURES = new Set([
  "LEGACY_SOURCE_UNAVAILABLE",
  "LEGACY_SOURCE_NOT_REGULAR",
  "LEGACY_SOURCE_TOO_LARGE",
  "LEGACY_SOURCE_CHANGED_DURING_READ",
  "LEGACY_SOURCE_MALFORMED",
  "LEGACY_SOURCE_SHAPE",
  "LEGACY_UPSTREAM_SHAPE",
  "LEGACY_KEY_INVALID",
  "LEGACY_KEY_DUPLICATE",
  "LEGACY_SOURCE_CHANGED",
  "LEGACY_MIGRATION_IN_PROGRESS"
]);

export interface ExplicitLegacyMigrationCommandOptions<T> {
  run: () => Promise<T>;
  log: (level: string, event: string, data: Record<string, unknown>) => void;
  close: () => Promise<void> | void;
  audit?: MigrationPhaseAudit;
}

export type ExplicitLegacyMigrationCommandResult<T> =
  | { status: "completed"; result: T }
  | { status: "known_failure"; code: string };

function knownPreparedLegacySourceFailure(error: unknown): string | undefined {
  if (!(error instanceof Error) || !KNOWN_PREPARED_LEGACY_SOURCE_FAILURES.has(error.message)) return undefined;
  return error.message;
}

/**
 * Contains expected legacy-source validation failures at the explicit CLI
 * command boundary. All other failures deliberately retain fatal handling.
 */
export async function runExplicitLegacyMigrationCommand<T>(
  options: ExplicitLegacyMigrationCommandOptions<T>
): Promise<ExplicitLegacyMigrationCommandResult<T>> {
  try {
    return { status: "completed", result: await options.run() };
  } catch (error) {
    const code = knownPreparedLegacySourceFailure(error);
    if (!code) {
      emitMigrationWorkflowFailure(options.audit, error, { pid: process.pid });
      throw error;
    }
    emitMigrationWorkflowFailure(options.audit, error, { pid: process.pid, code });
    options.log("error", "explicit_legacy_migration_failed", { code });
    await options.close();
    return { status: "known_failure", code };
  }
}
