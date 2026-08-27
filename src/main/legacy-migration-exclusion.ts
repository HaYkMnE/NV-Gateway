import * as fs from "node:fs";
import * as path from "node:path";

export const LEGACY_MIGRATION_EXCLUSION_LOCK_NAME = "legacy-nvidia-migration.lock";

export interface LegacyMigrationExclusionLock {
  release(): void;
}

function fail(code: string): never { throw new Error(code); }

function lockPath(userDataPath: string): string {
  return path.join(userDataPath, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
}

/**
 * Serializes the whole explicit migration after source validation. The fixed
 * pathname is an empty directory created atomically by mkdir and removed by
 * rmdir. It deliberately has no marker file: read/compare/unlink cannot
 * establish ownership of a pathname that another process may replace.
 */
export function acquireLegacyMigrationExclusionLock(userDataPath: string): LegacyMigrationExclusionLock {
  const directoryPath = lockPath(userDataPath);
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(directoryPath, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") fail("LEGACY_MIGRATION_IN_PROGRESS");
    fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
  }

  let released = false;
  return {
    release() {
      if (released) return;
      // Make this handle terminal before touching the fixed pathname. If rmdir
      // fails and an operator later repairs the path, this old handle must not
      // be able to remove a successor's directory on a retry.
      released = true;
      try { fs.rmdirSync(directoryPath); } catch { fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE"); }
    }
  };
}
