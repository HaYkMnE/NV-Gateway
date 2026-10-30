import {
  runApplicationStartup,
  type ApplicationStartupOptions,
  type ApplicationStartupResult
} from "./explicit-legacy-migration-startup";

export interface MainProcessApp {
  setName(name: string): void;
  whenReady(): Promise<unknown>;
}

export interface MainProcessStartupOptions<TSource, TLifecycle, TResult> {
  argv: readonly string[];
  app: MainProcessApp;
  configureSingleInstance: () => boolean;
  createApplicationStartupOptions: () => Omit<ApplicationStartupOptions<TSource, TLifecycle, TResult>, "explicitLegacyMigration" | "close" | "acquireLegacyMigrationLock">;
  acquireLegacyMigrationLock: () => { release(): void | Promise<void> } | Promise<{ release(): void | Promise<void> }>;
  close: (exitCode: number) => Promise<void> | void;
}

export type MainProcessStartupResult<TResult> =
  | ApplicationStartupResult<TResult>
  | { status: "single_instance" };

/**
 * Routes the Electron boot sequence. The explicit command bypasses regular
 * Electron lifecycle wiring until the fixed legacy source has been validated.
 */
export async function startMainProcess<TSource, TLifecycle, TResult>(
  options: MainProcessStartupOptions<TSource, TLifecycle, TResult>
): Promise<MainProcessStartupResult<TResult>> {
  const explicitLegacyMigration = options.argv.includes("--migrate-legacy-nvidia");
  const startupOptions = options.createApplicationStartupOptions();

  if (explicitLegacyMigration) {
    // Electron caches userData on the first app.getPath("userData") call, and
    // the explicit command resolves its exclusion lock from userData before the
    // lifecycle runs. Fix the product name once, before runApplicationStartup,
    // so the lock, state, and logs all land under %APPDATA%/NV-Gateway.
    options.app.setName("NV-Gateway");
    return runApplicationStartup({
      ...startupOptions,
      explicitLegacyMigration: true,
      acquireLegacyMigrationLock: options.acquireLegacyMigrationLock,
      initializeLifecycle: async () => {
        await options.app.whenReady();
        return startupOptions.initializeLifecycle();
      },
      close: options.close
    });
  }

  options.app.setName("NV-Gateway");
  if (!options.configureSingleInstance()) return { status: "single_instance" };
  await options.app.whenReady();
  return runApplicationStartup({
    ...startupOptions,
    explicitLegacyMigration: false,
    acquireLegacyMigrationLock: options.acquireLegacyMigrationLock,
    close: options.close
  });
}
