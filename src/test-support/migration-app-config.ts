import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { AppConfigState } from "../main/gateway-runtime";

function fail(code: string): never { throw new Error(code); }
function readCurrent(filePath: string): Buffer { try { return fs.readFileSync(filePath); } catch { return fail("MIGRATION_APP_CONFIG_WRITE_FAILED"); } }
interface FileSnapshot { content: Buffer; size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
interface AppConfigWriteHooks { beforeTemporaryCreate?: (filePath: string) => void; afterCandidateVerifiedBeforeReplace?: (filePath: string) => void }
function snapshot(filePath: string): FileSnapshot {
  const before = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  const after = fs.statSync(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
  return { content, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, ino: after.ino, dev: after.dev };
}
function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean { return left.content.equals(right.content) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.dev === right.dev; }
function writeProtectedExclusive(filePath: string, content: Buffer, protectFile: (filePath: string) => void): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try { protectFile(filePath); fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function removeTemporaryIfOwned(filePath: string, expected: Buffer): void { try { if (fs.readFileSync(filePath).equals(expected)) fs.unlinkSync(filePath); } catch {} }

function candidate(original: Buffer, update: Partial<AppConfigState>): Buffer {
  let existing: Record<string, unknown> = {};
  try { const parsed = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, "")); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>; } catch {}
  const current: AppConfigState = {
    gatewayPort: typeof existing.gatewayPort === "number" && Number.isInteger(existing.gatewayPort) && existing.gatewayPort >= 1 && existing.gatewayPort <= 65534 ? existing.gatewayPort : 12004,
    language: typeof existing.language === "string" && ["en", "ru", "zh", "hi", "es", "fr", "ar"].includes(existing.language) ? existing.language as any : "en",
    setupComplete: existing.setupComplete === true,
    performanceMode: existing.performanceMode === "night" || existing.performanceMode === "auto" || existing.performanceMode === "day" ? existing.performanceMode : "day",
    perModelSettings: (existing.perModelSettings && typeof existing.perModelSettings === "object" && !Array.isArray(existing.perModelSettings)) ? existing.perModelSettings as Record<string, any> : {},
    disabledModels: Array.isArray(existing.disabledModels) ? existing.disabledModels.filter((m): m is string => typeof m === "string") : []
  };
  const next = { ...current, ...update };
  if (!Number.isInteger(next.gatewayPort) || next.gatewayPort < 1 || next.gatewayPort > 65534 || (!["en", "ru", "zh", "hi", "es", "fr", "ar"].includes(next.language)) || (next.performanceMode !== "day" && next.performanceMode !== "night" && next.performanceMode !== "auto")) fail("MIGRATION_APP_CONFIG_WRITE_FAILED");
  return Buffer.from(JSON.stringify({ ...existing, version: 1, ...next }, null, 2), "utf8");
}

export function prepareAppConfigMigrationWrite(configPath: string, update: Partial<AppConfigState>, baseline?: Buffer) {
  const original = baseline ?? readCurrent(configPath);
  const written = candidate(original, update);
  const same = (value: Buffer, expected: Buffer) => value.equals(expected);
  const retainProtectedRecovery = (protectFile: (filePath: string) => void): void => {
    const recovery = `${configPath}.migration-rollback-recovery.${crypto.randomUUID()}.bak`;
    let retained = false;
    try { const descriptor = fs.openSync(recovery, "wx", 0o600); try { protectFile(recovery); fs.writeFileSync(descriptor, original); fs.fsyncSync(descriptor); retained = true; } finally { fs.closeSync(descriptor); } } finally { if (!retained) try { fs.unlinkSync(recovery); } catch {} }
  };
  const restoreOwned = (protectFile: (filePath: string) => void): void => {
    const temporary = `${configPath}.migration-rollback.${crypto.randomUUID()}.tmp`;
    try {
      const beforeReplacement = snapshot(configPath);
      if (same(beforeReplacement.content, original)) return;
      if (!same(beforeReplacement.content, written)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      writeProtectedExclusive(temporary, original, protectFile);
      if (!same(readCurrent(temporary), original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      if (!same(readCurrent(temporary), original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      fs.renameSync(temporary, configPath); protectFile(configPath);
      if (!same(readCurrent(configPath), original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
    } catch (error) {
      if (error instanceof Error && error.message === "MIGRATION_CONFIG_CONCURRENT_MODIFICATION") throw error;
      try { if (same(readCurrent(configPath), original)) retainProtectedRecovery(protectFile); } catch {}
      fail("MIGRATION_APP_CONFIG_ROLLBACK_FAILED");
    } finally { removeTemporaryIfOwned(temporary, original); }
  };
  return {
    original,
    candidate: written,
    writeIfCurrent(protectFile: (filePath: string) => void, hooks?: AppConfigWriteHooks & { afterReplaceBeforeVerify?: () => void }): void {
      const temporary = `${configPath}.migration-write.${crypto.randomUUID()}.tmp`;
      let replaced = false;
      try {
        const beforeReplacement = snapshot(configPath);
        if (same(beforeReplacement.content, written)) { hooks?.afterReplaceBeforeVerify?.(); if (!same(readCurrent(configPath), written)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION"); return; }
        if (!same(beforeReplacement.content, original)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        hooks?.beforeTemporaryCreate?.(temporary);
        writeProtectedExclusive(temporary, written, protectFile);
        if (!same(readCurrent(temporary), written)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        hooks?.afterCandidateVerifiedBeforeReplace?.(temporary);
        if (!same(readCurrent(temporary), written)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        if (!sameSnapshot(beforeReplacement, snapshot(configPath))) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
        replaced = true; fs.renameSync(temporary, configPath); protectFile(configPath);
        hooks?.afterReplaceBeforeVerify?.();
        if (!same(readCurrent(configPath), written)) fail("MIGRATION_CONFIG_CONCURRENT_MODIFICATION");
      } catch (error) {
        if (replaced) {
          try { restoreOwned(protectFile); } catch (restoreError) {
            if (restoreError instanceof Error && restoreError.message === "MIGRATION_CONFIG_CONCURRENT_MODIFICATION") throw restoreError;
            fail("MIGRATION_APP_CONFIG_ROLLBACK_FAILED");
          }
        }
        if (error instanceof Error && /^MIGRATION_(?:CONFIG_CONCURRENT_MODIFICATION|APP_CONFIG_WRITE_FAILED)$/.test(error.message)) throw error;
        fail("MIGRATION_APP_CONFIG_WRITE_FAILED");
      } finally { removeTemporaryIfOwned(temporary, written); }
    },
    restoreIfOwned(protectFile: (filePath: string) => void): void { restoreOwned(protectFile); }
  };
}
