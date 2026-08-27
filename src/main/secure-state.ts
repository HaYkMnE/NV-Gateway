import * as fs from "node:fs";
import * as path from "node:path";

export interface EncryptionAdapter { encrypt(plaintext: Buffer): Buffer; decrypt(ciphertext: Buffer): Buffer }
const MAGIC = Buffer.from("NVGW1\0", "ascii");

export function encodeEncryptedState(value: unknown, adapter: EncryptionAdapter): Buffer {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([MAGIC, adapter.encrypt(plaintext)]);
}

export function decodeEncryptedState(data: Buffer, adapter: EncryptionAdapter): unknown {
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid encrypted state format.");
  return JSON.parse(adapter.decrypt(data.subarray(MAGIC.length)).toString("utf8"));
}

export function migratePlaintextStateAtomically(statePath: string, adapter: EncryptionAdapter): void {
  if (!fs.existsSync(statePath)) return;
  const source = fs.readFileSync(statePath);
  if (source.subarray(0, MAGIC.length).equals(MAGIC)) return;
  const parsed = JSON.parse(source.toString("utf8"));
  if (!parsed || !Array.isArray(parsed.keys)) throw new Error("Legacy state is invalid; migration aborted.");
  const encrypted = encodeEncryptedState(parsed, adapter);
  decodeEncryptedState(encrypted, adapter);
  const temporary = `${statePath}.encrypted.tmp`;
  const recovery = `${statePath}.encrypted.bak`;
  fs.writeFileSync(temporary, encrypted);
  fs.writeFileSync(recovery, encrypted);
  fs.renameSync(temporary, statePath);
}

export type ProtectPath = (filePath: string) => void;
export type TransactionBoundary = "write-primary" | "fsync-primary" | "verify-primary" | "write-recovery" | "fsync-recovery" | "verify-recovery" | "replace-primary" | "replace-recovery";

export class SecureStore {
  readonly recoveryPath: string;
  constructor(private readonly statePath: string, private readonly adapter: EncryptionAdapter, private readonly protect: ProtectPath = () => {}, private readonly hooks: { boundary?(name: TransactionBoundary): void } = {}) {
    this.recoveryPath = `${statePath}.encrypted.bak`;
  }

  private tryLoadState(filePath: string): { state: any; isPlaintextLegacy: boolean } | null {
    try {
      if (!fs.existsSync(filePath)) return null;
      const source = fs.readFileSync(filePath);
      let state: any;
      let isPlaintextLegacy = false;
      if (source.subarray(0, MAGIC.length).equals(MAGIC)) {
        state = decodeEncryptedState(source, this.adapter);
      } else {
        state = JSON.parse(source.toString("utf8"));
        isPlaintextLegacy = true;
      }
      if (state && typeof state === "object" && Array.isArray(state.keys)) {
        return { state, isPlaintextLegacy };
      }
      return null;
    } catch {
      return null;
    }
  }

  initialize(): any {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const legacyBackup = `${this.statePath}.bak`;

    const primaryResult = this.tryLoadState(this.statePath);
    if (primaryResult) {
      if (primaryResult.isPlaintextLegacy) {
        this.persist(primaryResult.state);
      }
      if (fs.existsSync(legacyBackup)) {
        try {
          const backup = fs.readFileSync(legacyBackup);
          if (!backup.subarray(0, MAGIC.length).equals(MAGIC)) JSON.parse(backup.toString("utf8"));
          fs.unlinkSync(legacyBackup);
        } catch {}
      }
      return primaryResult.state;
    }

    const recoveryResult = this.tryLoadState(this.recoveryPath);
    if (recoveryResult) {
      this.persist(recoveryResult.state);
      if (fs.existsSync(legacyBackup)) {
        try { fs.unlinkSync(legacyBackup); } catch {}
      }
      return recoveryResult.state;
    }

    const baseName = path.basename(this.statePath);
    const candidates: { path: string; mtimeMs: number }[] = [];
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        if (fullPath === this.statePath || fullPath === this.recoveryPath) continue;
        if (entry.endsWith(".bak") && (entry.startsWith(`${baseName}.`) || entry === `${baseName}.bak`)) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile()) {
              candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
            }
          } catch {}
        }
      }
    } catch {}

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));

    for (const candidate of candidates) {
      const candidateResult = this.tryLoadState(candidate.path);
      if (candidateResult) {
        this.persist(candidateResult.state);
        if (fs.existsSync(legacyBackup)) {
          try { fs.unlinkSync(legacyBackup); } catch {}
        }
        return candidateResult.state;
      }
    }

    const timestamp = Date.now();
    if (fs.existsSync(this.statePath)) {
      try {
        const corruptPath = `${this.statePath}.corrupt.${timestamp}.bak`;
        fs.copyFileSync(this.statePath, corruptPath);
        this.protect(corruptPath);
      } catch {}
    }
    if (fs.existsSync(this.recoveryPath)) {
      try {
        const corruptPath = `${this.recoveryPath}.corrupt.${timestamp}.bak`;
        fs.copyFileSync(this.recoveryPath, corruptPath);
        this.protect(corruptPath);
      } catch {}
    }

    this.persist({ keys: [] });
    return { keys: [] };
  }

  persist(state: unknown): void {
    const encrypted = encodeEncryptedState(state, this.adapter);
    decodeEncryptedState(encrypted, this.adapter);
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const recoveryTemporary = `${this.recoveryPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { this.hooks.boundary?.("write-primary"); fs.writeFileSync(descriptor, encrypted); this.hooks.boundary?.("fsync-primary"); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      this.protect(temporary);
      this.hooks.boundary?.("verify-primary");
      decodeEncryptedState(fs.readFileSync(temporary), this.adapter);
      const recoveryDescriptor = fs.openSync(recoveryTemporary, "wx", 0o600);
      try { this.hooks.boundary?.("write-recovery"); fs.writeFileSync(recoveryDescriptor, encrypted); this.hooks.boundary?.("fsync-recovery"); fs.fsyncSync(recoveryDescriptor); } finally { fs.closeSync(recoveryDescriptor); }
      this.protect(recoveryTemporary);
      this.hooks.boundary?.("verify-recovery");
      decodeEncryptedState(fs.readFileSync(recoveryTemporary), this.adapter);
      this.hooks.boundary?.("replace-primary");
      replaceFile(temporary, this.statePath);
      this.protect(this.statePath);
      decodeEncryptedState(fs.readFileSync(this.statePath), this.adapter);
      this.hooks.boundary?.("replace-recovery");
      replaceFile(recoveryTemporary, this.recoveryPath);
      this.protect(this.recoveryPath);
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
      try { fs.unlinkSync(recoveryTemporary); } catch {}
    }
  }

  createVersionedBackup(label: string, protect: ProtectPath = this.protect, operationId?: string): string {
    if (!/^[a-z-]{1,32}$/.test(label)) throw new Error("Invalid backup label.");
    if (operationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error("Invalid migration operation ID.");
    const source = fs.readFileSync(this.statePath);
    decodeEncryptedState(source, this.adapter);
    const backupPath = operationId === undefined
      ? `${this.statePath}.${label}.v1.${Date.now()}.${Math.random().toString(16).slice(2)}.bak`
      : `${this.statePath}.${label}.v1.${operationId}.bak`;
    const descriptor = fs.openSync(backupPath, "wx", 0o600);
    try { protect(backupPath); fs.writeFileSync(descriptor, source); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    decodeEncryptedState(fs.readFileSync(backupPath), this.adapter);
    return backupPath;
  }

  restoreVersionedBackup(backupPath: string, protect: ProtectPath = this.protect): void {
    const source = fs.readFileSync(backupPath);
    decodeEncryptedState(source, this.adapter);
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.restore.tmp`;
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try { protect(temporary); fs.writeFileSync(descriptor, source); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    decodeEncryptedState(fs.readFileSync(temporary), this.adapter);
    replaceFile(temporary, this.statePath);
    protect(this.statePath);
    decodeEncryptedState(fs.readFileSync(this.statePath), this.adapter);
  }
}

function replaceFile(source: string, destination: string): void {
  try { fs.renameSync(source, destination); }
  catch (error: any) {
    if (process.platform !== "win32" || !fs.existsSync(destination)) throw error;
    const backup = `${destination}.${process.pid}.${Date.now()}.replace.bak`;
    fs.renameSync(destination, backup);
    try { fs.renameSync(source, destination); fs.unlinkSync(backup); }
    catch (replaceError) { try { if (!fs.existsSync(destination)) fs.renameSync(backup, destination); } catch {} throw replaceError; }
  }
}

export function createSafeStorageAdapter(safeStorage: { encryptString(value: string): Buffer; decryptString(value: Buffer): string; isEncryptionAvailable(): boolean }): EncryptionAdapter {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS key encryption is unavailable.");
  return { encrypt: (value) => safeStorage.encryptString(value.toString("utf8")), decrypt: (value) => Buffer.from(safeStorage.decryptString(value), "utf8") };
}
