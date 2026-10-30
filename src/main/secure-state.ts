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
  // MIRROR SecureStore.persist (:171-183) rather than plain writeFileSync: an
  // exclusive "wx" create at 0o600 (so a concurrent process can never interpose
  // on, or read, a plaintext-mode temporary), an fsync before the rename (so a
  // crash cannot leave a truncated file in place), and a re-verify of the
  // bytes that actually landed.
  //
  // PER-CALL UNIQUE TEMP NAMES, and this is a correctness fix, not cosmetics.
  // The names used to be the FIXED `${statePath}.encrypted.tmp` and
  // `${statePath}.encrypted.bak`. With "wx" (exclusive create) a FIXED name
  // makes every SECOND migration throw EEXIST — MEASURED against the real
  // compiled module: migration #2 threw
  // `EEXIST ... keys.json.encrypted.bak` BEFORE the rename, leaving the active
  // path PLAINTEXT (activePathBytesReadableAsText: true) with the secret still
  // in the clear, and migration #3 then threw on the orphaned
  // `keys.json.encrypted.tmp`, stuck forever. SecureStore.persist already
  // solved this by stamping pid + Date.now() + random into each temporary name;
  // the same scheme is used here.
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const temporary = `${statePath}.${suffix}.encrypted.tmp`;
  const recovery = `${statePath}.${suffix}.encrypted.bak`;
  try {
    // ORDER IS THE SECURITY PROPERTY. The ENCRYPTED bytes reach the ACTIVE path
    // by a single rename FIRST (writeProtectedAtomically verifies before
    // returning, so the plaintext is only overwritten by a verified-encrypted
    // temporary). The .bak recovery copy is written and renamed AFTER, and
    // best-effort: a stale/orphaned .bak — or a failure writing one at all —
    // must never be able to block the migration or leave plaintext at the
    // active path.
    writeProtectedAtomically(temporary, encrypted, adapter);
    fs.renameSync(temporary, statePath);
  } finally {
    // The temporary is renamed away on success; on any failure it is removed so
    // it cannot become the orphan that blocked every later attempt.
    try { fs.unlinkSync(temporary); } catch {}
  }
  try {
    writeProtectedAtomically(recovery, encrypted, adapter);
    fs.renameSync(recovery, `${statePath}.encrypted.bak`);
  } catch {
    // Best-effort recovery copy: the primary migration already committed.
  } finally {
    try { fs.unlinkSync(recovery); } catch {}
  }
}

/**
 * Create `filePath` exclusively at 0o600, write `data`, fsync it, and verify
 * the bytes are decodable before returning. Throws on any failure — the caller
 * must treat that as "migration did not happen" rather than leaving a
 * half-written temporary behind.
 */
function writeProtectedAtomically(filePath: string, data: Buffer, adapter: EncryptionAdapter): void {
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  decodeEncryptedState(fs.readFileSync(filePath), adapter);
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

  /**
   * Sweep orphaned `.replace.bak` commit buffers left by the Windows replace
   * fallback in replaceFile() when its best-effort backup unlink was blocked
   * (EBUSY/EPERM from an AV/indexer handle). A buffer is deleted ONLY when its
   * destination LOADS (tryLoadState) — the commit landed and a good copy is on
   * disk, so the backup is pure residue. Mere existence is not enough: with the
   * destination (and its recovery file) corrupt, the buffer may be the only
   * good copy. A buffer whose destination is missing or unreadable is NEVER
   * deleted here, whatever its age: it is left for the candidate-recovery scan
   * in initialize(), and once that restores a loadable destination the buffer
   * is residue and goes on the next startup. Age is deliberately not consulted:
   * renameSync preserves the moved file's mtime, so mtime says when the state
   * was last written, not when the buffer was created, and the only buffers an
   * age rule could still delete are exactly the ones that must be kept.
   */
  private sweepReplaceBackups(dir: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const match = /^(.+)\.\d+\.\d+\.replace\.bak$/.exec(entry);
      if (!match) continue;
      const fullPath = path.join(dir, entry);
      try {
        if (!this.tryLoadState(path.join(dir, match[1]))) continue;
        fs.unlinkSync(fullPath);
      } catch {}
    }
  }

  initialize(): any {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    this.sweepReplaceBackups(dir);
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
    try {
      fs.renameSync(source, destination);
      // The commit rename has landed, so the new state is already durable.
      // Deleting the backup is cleanup, not commit: a blocked unlink (EBUSY/
      // EPERM from an AV or indexer holding the just-closed handle) must not
      // masquerade as a commit failure — persist() reporting failure here
      // would make the caller roll back in-memory state that reappears from
      // disk on the next restart. The orphaned .replace.bak is swept on the
      // next SecureStore startup (sweepReplaceBackups).
      try { fs.unlinkSync(backup); } catch {}
    }
    catch (replaceError) { try { if (!fs.existsSync(destination)) fs.renameSync(backup, destination); } catch {} throw replaceError; }
  }
}

// TODO(Electron 46): the SYNC safeStorage API (isEncryptionAvailable/encryptString/
// decryptString) is deprecated in Electron 45 and removed in 46. Fine on the pinned
// Electron 44; migrate to the async safeStorage API before bumping past 45.
export function createSafeStorageAdapter(safeStorage: { encryptString(value: string): Buffer; decryptString(value: Buffer): string; isEncryptionAvailable(): boolean }): EncryptionAdapter {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS key encryption is unavailable.");
  return { encrypt: (value) => safeStorage.encryptString(value.toString("utf8")), decrypt: (value) => Buffer.from(safeStorage.decryptString(value), "utf8") };
}
