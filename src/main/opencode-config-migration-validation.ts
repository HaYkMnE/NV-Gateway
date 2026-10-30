import { decodeStrictUtf8OpenCodeConfig } from "./opencode-config-decoding";
import { locateOpenCodeJsoncTargets, type OpenCodeJsoncTarget } from "./opencode-jsonc-targets";

export interface ValidatedOpenCodeConfigForMigration {
  source: string;
  targets: { apiKey: OpenCodeJsoncTarget; baseURL: OpenCodeJsoncTarget };
}

/** Validates immutable migration input without changing its original bytes. */
export function validateOpenCodeConfigForMigration(buffer: Buffer): ValidatedOpenCodeConfigForMigration {
  const source = decodeStrictUtf8OpenCodeConfig(buffer);
  return { source, targets: locateOpenCodeJsoncTargets(source) };
}
