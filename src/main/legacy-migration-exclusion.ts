import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LEGACY_MIGRATION_EXCLUSION_LOCK_NAME = "legacy-nvidia-migration.lock";

export interface LegacyMigrationExclusionLock {
  release(): void;
}

/** Owner record written inside the lock directory. */
interface LockOwnerRecord {
  pid: number;
  host: string;
  /** Human-readable start time (diagnostics only). */
  startedAt: string;
  /** Numeric start time; the liveness/age authority. */
  startedAtMs: number;
  /**
   * Last time the OWNER proved it is still working (ms epoch). A pid number
   * alone cannot prove ownership: Windows recycles pids, so a live pid may
   * belong to an unrelated process. The heartbeat is what makes a recycled pid
   * detectable — an owner that stops refreshing it is judged stale by age.
   * Records from older builds may lack it; `startedAtMs` is then the fallback.
   */
  heartbeatAtMs: number;
  /** Random identity of this acquisition, used to prove we still own the path. */
  ownerId: string;
}

/**
 * What an existing lock looks like right now.
 *
 * `stale` carries the signature of the exact owner it was judged on, so a
 * reclaim can prove nothing changed between the verdict and the takeover.
 */
type LockState =
  | { kind: "missing" }
  | { kind: "foreign" }
  | { kind: "live" }
  | { kind: "stale"; signature: string };

const OWNER_FILE_NAME = "owner.json";
/** Single-writer claim that makes concurrent reclaims of one lock exclusive. */
const RECLAIM_FILE_NAME = "reclaim.json";

/**
 * Atomic-write scratch file for the owner record. It belongs to THIS module, so
 * a leftover from a crash between write and rename must not read as foreign
 * state (that would wedge the lock until an operator repaired the directory).
 */
const OWNER_TEMP_FILE_NAME = `${OWNER_FILE_NAME}.tmp`;

/** Lock artifacts this module may create, and therefore tolerate, in its own directory. */
const OWNED_ENTRY_NAMES = new Set([OWNER_FILE_NAME, RECLAIM_FILE_NAME, OWNER_TEMP_FILE_NAME]);

/**
 * A lock whose owner cannot be PROVEN alive (unreadable/missing record, or a
 * record from another host) is reclaimable only after this much time. Long
 * enough that a migration legitimately writing its record is never stolen,
 * short enough that a crashed migration does not block recovery for long.
 */
const STALE_LOCK_MS = 10 * 60 * 1000;

/**
 * How often a lock holder refreshes `heartbeatAtMs`. Must be well under
 * STALE_LOCK_MS so a live owner is never mistaken for a recycled pid.
 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** Attempts allowed for "inspect -> reclaim -> create" before failing honestly. */
const ACQUIRE_ATTEMPTS = 3;

function fail(code: string): never { throw new Error(code); }

function lockPath(userDataPath: string): string {
  return path.join(userDataPath, LEGACY_MIGRATION_EXCLUSION_LOCK_NAME);
}

function ownerPath(directoryPath: string): string {
  return path.join(directoryPath, OWNER_FILE_NAME);
}

function isPidAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    // Signal 0 performs the existence/permission check without delivering
    // anything. EPERM means the process exists but belongs to another user.
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function readOwnerRecord(directoryPath: string): LockOwnerRecord | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ownerPath(directoryPath), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Partial<LockOwnerRecord>;
    if (typeof record.ownerId !== "string" || record.ownerId.length < 16) return null;
    if (typeof record.host !== "string" || record.host.length === 0) return null;
    if (typeof record.startedAtMs !== "number" || !Number.isFinite(record.startedAtMs)) return null;
    return {
      pid: typeof record.pid === "number" ? record.pid : Number.NaN,
      host: record.host,
      startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date(record.startedAtMs).toISOString(),
      startedAtMs: record.startedAtMs,
      // Records written by older builds carry no heartbeat; their start time is
      // the best available proof, so it becomes the fallback beat.
      heartbeatAtMs: typeof record.heartbeatAtMs === "number" && Number.isFinite(record.heartbeatAtMs)
        ? record.heartbeatAtMs
        : record.startedAtMs,
      ownerId: record.ownerId
    };
  } catch {
    return null;
  }
}

/**
 * Replace the owner record ATOMICALLY (temp + rename). The record is rewritten
 * every heartbeat, so a crash mid-write must never leave a torn identity that
 * would read as an unowned lock.
 */
function writeOwnerRecord(directoryPath: string, owner: LockOwnerRecord): void {
  const tempPath = path.join(directoryPath, OWNER_TEMP_FILE_NAME);
  fs.writeFileSync(tempPath, JSON.stringify(owner, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, ownerPath(directoryPath));
}

/** Heartbeat refresh interval; overridable for tests, clamped to a sane minimum. */
function heartbeatIntervalMs(): number {
  const raw = Number.parseInt(String(process.env.NV_GATEWAY_LEGACY_LOCK_HEARTBEAT_MS ?? ""), 10);
  return Number.isSafeInteger(raw) && raw >= 10 ? raw : HEARTBEAT_INTERVAL_MS;
}

/**
 * mtime of the owner record — the FILESYSTEM's clock — or null when unreadable.
 * Used as the age anchor when the record's OWN stamps are both in the future and
 * therefore cannot measure anything.
 */
function ownerRecordMtimeMs(directoryPath: string): number | null {
  try {
    return fs.lstatSync(ownerPath(directoryPath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Judge an existing lock. Ownership is proven by the HEARTBEAT, not by the pid
 * number: pids are recycled, so a live pid can belong to an unrelated process
 * (an 8h-old record naming a recycled live pid used to block recovery forever).
 *
 *   - dead local pid                      → stale immediately (proof of death)
 *   - live local pid + fresh heartbeat    → live (never stolen, however old)
 *   - live local pid + stale heartbeat    → stale (the pid is not our owner)
 *   - another host                        → age only
 *
 * Anything at the pathname that is not a lock directory we understand (a plain
 * file, unknown content) is `foreign`: it is never deleted, only reported.
 */
function observeLock(directoryPath: string, nowMs = Date.now()): LockState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directoryPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? { kind: "missing" } : { kind: "foreign" };
  }
  if (!stat.isDirectory()) return { kind: "foreign" };

  let entries: string[];
  try {
    entries = fs.readdirSync(directoryPath);
  } catch {
    return { kind: "foreign" };
  }
  if (entries.some((entry) => !OWNED_ENTRY_NAMES.has(entry))) return { kind: "foreign" };

  const record = entries.includes(OWNER_FILE_NAME) ? readOwnerRecord(directoryPath) : null;
  if (record) {
    // CLAMP. `now - heartbeat` goes NEGATIVE for a stamp in the future, and a
    // host whose clock runs ahead writes exactly that — the record then reads as
    // fresh for as long as the skew lasts (a +10y stamp froze the lock forever).
    // A stamp can never prove more than "as of now", and a stamp claiming the
    // FUTURE proves nothing at all, so it falls back to the record's own start
    // time; the age is then clamped so it is never negative.
    //
    // BOTH stamps in the future: the SAME skewed host wrote the start AND the
    // beat, so the start is not a usable fallback either — clamping it to `now`
    // made the age exactly 0 and wedged the lock FOREVER behind a live recycled
    // pid. Neither stamp can be believed, so the age comes from the filesystem's
    // own clock (owner.json's mtime, else the directory's), which a skewed writer
    // cannot forge and which a genuinely live owner keeps refreshing with every
    // heartbeat.
    let effectiveHeartbeat: number;
    if (record.heartbeatAtMs > nowMs && record.startedAtMs > nowMs) {
      effectiveHeartbeat = Math.min(ownerRecordMtimeMs(directoryPath) ?? stat.mtimeMs, nowMs);
    } else {
      const claimedHeartbeat = record.heartbeatAtMs > nowMs ? record.startedAtMs : record.heartbeatAtMs;
      effectiveHeartbeat = Math.min(claimedHeartbeat, nowMs);
    }
    if (record.host === os.hostname()) {
      // Proof of death: reclaim immediately, no waiting for a threshold.
      if (!isPidAlive(record.pid)) return { kind: "stale", signature: `owner:${record.ownerId}` };
      // A live pid proves nothing on its own. The owner refreshes its heartbeat
      // while it works; once that goes quiet past the stale threshold the pid
      // has been recycled by an unrelated process.
      return nowMs - effectiveHeartbeat > STALE_LOCK_MS
        ? { kind: "stale", signature: `owner:${record.ownerId}` }
        : { kind: "live" };
    }
    // A pid from another host says nothing here; fall back to age.
    return nowMs - effectiveHeartbeat > STALE_LOCK_MS
      ? { kind: "stale", signature: `owner:${record.ownerId}` }
      : { kind: "live" };
  }
  // No usable record. A FRESH directory may be a live migration that is still
  // writing its record, so only age can make it reclaimable. `mtimeMs` is
  // deliberately NOT part of the signature: writing the reclaim claim below
  // bumps the directory mtime, and a signature must survive that.
  return nowMs - stat.mtimeMs > STALE_LOCK_MS
    ? { kind: "stale", signature: `dir:${stat.dev}:${stat.ino}` }
    : { kind: "live" };
}

/**
 * Under the reclaim claim, confirm the verdict still describes THIS lock. Only
 * the identity is re-checked, never the age: the claim file we just created
 * bumps the directory mtime, which must not make the lock look fresh again.
 */
function stillStaleLock(directoryPath: string, judged: { signature: string }): boolean {
  const record = readOwnerRecord(directoryPath);
  if (record) return judged.signature === `owner:${record.ownerId}`;
  try {
    const stat = fs.lstatSync(directoryPath);
    return stat.isDirectory() && judged.signature === `dir:${stat.dev}:${stat.ino}`;
  } catch {
    return false;
  }
}

/**
 * A reclaim claim is stale when it is unreadable, older than the stale
 * threshold, or names a dead local pid.
 *
 * AGE WINS for the CLAIM file, regardless of liveness: unlike the main lock,
 * the claim covers a short critical section, so a claim still sitting there
 * after the threshold means its holder died or hung mid-takeover. Honouring
 * liveness here would let one hung process wedge every future reclaim forever
 * (the claim is never refreshed, so age is the only reliable signal). The main
 * lock keeps its heartbeat rule — an owner there is legitimately long-lived.
 */
function claimIsStale(claimPath: string, nowMs = Date.now()): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(claimPath);
  } catch {
    return true; // already gone: the next O_EXCL create settles it
  }
  let record: { pid?: unknown; host?: unknown; claimedAt?: unknown } | null = null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(claimPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as typeof record;
  } catch {
    record = null;
  }
  if (!record || typeof record.host !== "string" || typeof record.claimedAt !== "string") {
    return nowMs - stat.mtimeMs > STALE_LOCK_MS;
  }
  const claimedAtMs = Date.parse(record.claimedAt);
  // AGE WINS, before any liveness test (see the note above).
  if (!Number.isFinite(claimedAtMs)) return true;
  if (nowMs - claimedAtMs > STALE_LOCK_MS) return true;
  // Young claim: a live local holder is inside its critical section.
  return record.host === os.hostname() ? !isPidAlive(record.pid) : false;
}

/**
 * Take over a lock judged stale, without ever destroying foreign state.
 *
 * The `reclaim.json` claim is created with O_EXCL, so of any number of
 * processes that judged the same lock stale exactly ONE can enter the takeover
 * body; the rest report IN_PROGRESS. The winner re-judges the lock under its
 * claim (a rival may have finished in between) and only then replaces the dead
 * owner record. No directory is ever moved or removed here, so a successor's
 * fresh lock can never be clobbered.
 *
 * @returns "reclaimed" when this process now owns the lock, "retry" when the
 *   pathname vanished under us, "blocked" when the takeover is not safe.
 */
function reclaimStaleLock(directoryPath: string, judged: { signature: string }, owner: LockOwnerRecord): "reclaimed" | "retry" | "blocked" {
  const claimPath = path.join(directoryPath, RECLAIM_FILE_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(claimPath, JSON.stringify({ pid: process.pid, host: os.hostname(), claimedAt: new Date().toISOString() }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return "retry"; // the directory vanished: loop back to mkdir
      if (code !== "EEXIST" || attempt > 0) return "blocked";
      // A claim left by a reclaimer that crashed mid-takeover must not wedge
      // the lock forever. Removing it is idempotent and harmless: whoever wins
      // the next O_EXCL create is still the only one inside the takeover.
      if (!claimIsStale(claimPath)) return "blocked";
      try { fs.unlinkSync(claimPath); } catch { return "blocked"; }
    }
  }

  const abandon = (): "retry" | "blocked" => {
    try { fs.unlinkSync(claimPath); } catch { /* a stuck claim keeps the lock fail-closed */ }
    return "blocked";
  };

  // Under the claim, confirm the verdict still describes THIS lock: the owner
  // record may have been replaced by a live successor since it was read.
  if (!fs.existsSync(directoryPath)) {
    try { fs.unlinkSync(claimPath); } catch { /* gone with the directory */ }
    return "retry";
  }
  if (!stillStaleLock(directoryPath, judged)) return abandon();

  try {
    writeOwnerRecord(directoryPath, owner);
  } catch {
    return abandon();
  }
  try { fs.unlinkSync(claimPath); } catch { /* a leftover claim is cleaned by the owner's release */ }
  return "reclaimed";
}

/**
 * Serializes the whole explicit migration after source validation.
 *
 * The fixed pathname is an empty directory created atomically by mkdir, so
 * ownership is a namespace operation, never a read/compare/unlink of a marker.
 * Inside it lives an owner record (pid + start time + host + acquisition id):
 * without one, a lock left behind by a crashed migration blocked every later
 * attempt with LEGACY_MIGRATION_IN_PROGRESS forever. A lock whose owner is
 * provably dead (or unreadable past the stale threshold) is reclaimed through
 * an exclusive claim, so concurrent reclaimers can never both win.
 */
export function acquireLegacyMigrationExclusionLock(userDataPath: string): LegacyMigrationExclusionLock {
  const directoryPath = lockPath(userDataPath);
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
  } catch {
    fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
  }

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const ownerId = crypto.randomBytes(24).toString("hex");
    const startedAtMs = Date.now();
    const owner: LockOwnerRecord = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      heartbeatAtMs: startedAtMs,
      ownerId
    };
    try {
      fs.mkdirSync(directoryPath, 0o700);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
      const observed = observeLock(directoryPath);
      if (observed.kind === "missing") continue;
      if (observed.kind !== "stale") fail("LEGACY_MIGRATION_IN_PROGRESS");
      const outcome = reclaimStaleLock(directoryPath, observed, owner);
      if (outcome === "reclaimed") return lockHandle(directoryPath, ownerId);
      if (outcome === "retry") continue;
      fail("LEGACY_MIGRATION_IN_PROGRESS");
    }

    try {
      writeOwnerRecord(directoryPath, owner);
    } catch {
      // Never leave a record-less directory of our own making behind: it would
      // block every other migration until the stale threshold elapsed.
      try { fs.rmdirSync(directoryPath); } catch { /* ambiguous state stays fail-closed */ }
      fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
    }
    return lockHandle(directoryPath, ownerId);
  }
  fail("LEGACY_MIGRATION_IN_PROGRESS");
}

function lockHandle(directoryPath: string, ownerId: string): LegacyMigrationExclusionLock {
  let released = false;

  // Prove ownership CONTINUOUSLY, not once at acquisition: the heartbeat is what
  // lets a later process tell "the real owner is still working" from "this pid
  // was recycled by an unrelated process". It never rewrites the identity and it
  // stops the moment this handle releases, so it cannot resurrect a stale lock.
  const heartbeat = setInterval(() => {
    if (released) return;
    try {
      const current = readOwnerRecord(directoryPath);
      // A successor may already own the path; never clobber its record.
      if (!current || current.ownerId !== ownerId) return;
      // While the record still names US we are the true owner, so KEEP BEATING —
      // the mere PRESENCE of reclaim.json is not evidence against us. The old
      // unconditional early-return froze a live owner's heartbeat, and after
      // STALE_LOCK_MS a rival reclaimed a lock whose owner was ALIVE: the
      // owner's release() then failed with LEGACY_MIGRATION_LOCK_UNAVAILABLE and
      // two migrations ran at once. A claim is only ever a critical section over
      // an owner that already went quiet, so a beat from a provable owner must be
      // honoured. A claim that is NOT ours is judged by AGE alone in
      // claimIsStale(), which is what lets a leftover from a crashed/hung
      // reclaimer stop blocking once it is older than STALE_LOCK_MS.
      writeOwnerRecord(directoryPath, { ...current, heartbeatAtMs: Date.now() });
    } catch {
      // Best effort: a failed beat only ages the record, it never corrupts it.
    }
  }, heartbeatIntervalMs());
  // Never keep the process alive just for the heartbeat.
  heartbeat.unref?.();

  const stopHeartbeat = (): void => {
    try { clearInterval(heartbeat); } catch { /* already stopped */ }
  };

  return {
    release() {
      if (released) return;
      // Make this handle terminal before touching the fixed pathname. If the
      // removal fails and an operator later repairs the path, this old handle
      // must not be able to remove a successor's directory on a retry.
      released = true;
      stopHeartbeat();
      const record = readOwnerRecord(directoryPath);
      if (!record || record.ownerId !== ownerId) fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
      let entries: string[];
      try {
        entries = fs.readdirSync(directoryPath);
      } catch {
        fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
      }
      // Only a directory holding OUR record (plus this module's own claim and
      // atomic-write artifacts) may be touched; anything else is ambiguous state.
      if (entries.some((entry) => !OWNED_ENTRY_NAMES.has(entry))) {
        // This handle is terminal, so it must stop CLAIMING ownership even
        // though it cannot remove the directory: the leftover is then judged by
        // age, never by our pid, and an operator repair stays possible.
        try { fs.unlinkSync(ownerPath(directoryPath)); } catch { /* leave it fail-closed */ }
        fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
      }
      try {
        fs.unlinkSync(ownerPath(directoryPath));
        fs.rmSync(path.join(directoryPath, RECLAIM_FILE_NAME), { force: true });
        fs.rmSync(path.join(directoryPath, OWNER_TEMP_FILE_NAME), { force: true });
        fs.rmdirSync(directoryPath);
      } catch {
        fail("LEGACY_MIGRATION_LOCK_UNAVAILABLE");
      }
    }
  };
}
