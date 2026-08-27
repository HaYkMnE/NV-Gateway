import { runExplicitLegacyMigrationCommand, type ExplicitLegacyMigrationCommandResult } from "./explicit-legacy-migration-command";
import { emitMigrationWorkflowFailure, type MigrationPhaseAudit } from "./migration-phase-audit";

export interface ApplicationStartupOptions<TSource, TLifecycle, TResult> {
  explicitLegacyMigration: boolean;
  validateLegacySource: () => TSource;
  acquireLegacyMigrationLock: () => { release(): void | Promise<void> } | Promise<{ release(): void | Promise<void> }>;
  initializeLifecycle: () => TLifecycle | Promise<TLifecycle>;
  runMigration: (source: TSource, lifecycle: TLifecycle) => Promise<TResult>;
  startNormal: (lifecycle: TLifecycle) => Promise<void>;
  log: (level: string, event: string, data: Record<string, unknown>) => void;
  close: (exitCode: number) => Promise<void> | void;
  audit?: MigrationPhaseAudit;
}

export type ApplicationStartupResult<TResult> =
  | { status: "normal" }
  | ExplicitLegacyMigrationCommandResult<TResult>;

/**
 * Keeps opt-in source validation ahead of every app-owned runtime effect.
 * Unknown failures intentionally escape to the process fatal handler.
 */
export async function runApplicationStartup<TSource, TLifecycle, TResult>(
  options: ApplicationStartupOptions<TSource, TLifecycle, TResult>
): Promise<ApplicationStartupResult<TResult>> {
  if (!options.explicitLegacyMigration) {
    const lifecycle = await options.initializeLifecycle();
    await options.startNormal(lifecycle);
    return { status: "normal" };
  }

  let lifecycle: TLifecycle | undefined;
  const command = await runExplicitLegacyMigrationCommand({
    run: async () => {
      options.audit?.emit("command_started", { pid: process.pid });
      const source = options.validateLegacySource();
      options.audit?.emit("source_validated", { pid: process.pid });
      // Direct module tests may exercise the coordinator without the production
      // router. The production router always supplies the real exclusion lock.
        const lock = await (options.acquireLegacyMigrationLock?.() ?? { release: () => {} });
        try {
          options.audit?.emit("lifecycle_initializing", { pid: process.pid });
          try {
            lifecycle = await options.initializeLifecycle();
          } catch (error) {
            emitMigrationWorkflowFailure(options.audit, error, { pid: process.pid, code: "MIGRATION_LIFECYCLE_INITIALIZATION_FAILED" });
            throw error;
          }
          return await options.runMigration(source, lifecycle);
      } finally {
        await lock.release();
      }
    },
    log: options.log,
    close: () => options.close(1),
    audit: options.audit
  });
  if (command.status === "known_failure") return command;
  await options.startNormal(lifecycle as TLifecycle);
  return command;
}
