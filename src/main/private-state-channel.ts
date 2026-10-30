import { isChildKeyProjection, type ChildKeyProjection } from "./state-ownership";

interface ChildIpc {
  connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  send?(message: unknown, callback?: (error: Error | null) => void): unknown;
}

interface DurablePersistContext {
  requestId: string;
  revision: number;
}

const readDurablePersistContext = (value: any): DurablePersistContext | null =>
  typeof value?.requestId === "string"
    && value.requestId.length > 0
    && Number.isSafeInteger(value?.revision)
    && value.revision >= 1
    ? { requestId: value.requestId, revision: value.revision }
    : null;

/** Projections are plain JSON trees; structural identity is a JSON-string compare. */
function sameProjection(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

// Codes whose rejection can only have been issued BEFORE any disk write.
// Everything else that escapes options.persist() becomes PERSIST_WRITE_FAILED:
// an fs-level throw (EBUSY/EPERM/ENOSPC/ENOENT…) may already have replaced the
// primary file, so "thrown from persist" must never masquerade as "nothing
// committed". Receiving code at the wrong revision happens before persist and
// never reaches this catch.
const PRE_PERSIST_REJECTION_CODES = new Set(["MIGRATION_IN_PROGRESS"]);

export function createPrivateStateChannel(options: { initialState: unknown; persist(state: ChildKeyProjection, context?: { durable: boolean }): void | Promise<void> }) {
  let authenticated = false;
  let initializationSent = false;
  let initializationConfirmed = false;
  let failed = false;
  let challenge: string | null = null;
  // Revision ledger for durable (admin mutation) persists: the child owns the
  // counter and issues strictly sequential revisions, so the main process only
  // has to REFUSE anything but exactly lastPersistedRevision + 1 — or an
  // IDENTICAL replay of lastPersistedRevision itself (an ack that was lost in
  // transit must be re-acknowledged without a second write). A rejected or
  // failed revision never advances the ledger, so a retry of the same logical
  // revision stays legal.
  let lastPersistedRevision = 0;
  let lastPersistedProjection: ChildKeyProjection | null = null;

  const sendMessage = (child: ChildIpc, message: Record<string, unknown>) => {
    try {
      if (typeof child.send !== "function") return;
      child.send(message, () => { /* delivery failure is terminal-only */ });
    } catch { /* channel closed mid-write */ }
  };

  const handleDurablePersist = async (child: ChildIpc, value: { state: ChildKeyProjection; requestId: string; revision: number }) => {
    const { requestId, revision } = value;
    const rejectDurable = (error: string, code?: string) => {
      // The ledger position always rides along: on an ack-loss the child's own
      // counter is stale, and this is the only way it can learn where the main
      // side actually stands and heal instead of deadlocking every later
      // mutation. `code` carries the retry-later classification (e.g.
      // MIGRATION_IN_PROGRESS) or the possibly-committed marker
      // (PERSIST_WRITE_FAILED) so the child routes reconcile work honestly.
      sendMessage(child, {
        type: "state:persist:rejected",
        requestId,
        revision,
        error,
        lastPersistedRevision,
        ...(typeof code === "string" && code.length > 0 ? { code } : {})
      });
    };
    if (revision === lastPersistedRevision
      && lastPersistedProjection !== null
      && sameProjection(value.state, lastPersistedProjection)) {
      // Idempotent replay: this exact projection already landed on disk (its
      // ack was lost in transit). Re-acknowledge WITHOUT writing again — the
      // ledger stays put, the child's in-memory state already matches disk.
      sendMessage(child, { type: "state:persist:ack", requestId, revision });
      return;
    }
    if (revision !== lastPersistedRevision + 1) {
      rejectDurable(`Stale or skipped persistence revision: expected ${lastPersistedRevision + 1}, got ${revision}.`);
      return;
    }
    try {
      // The durability flag rides along so the persistence owner can refuse a
      // durable ack during windows where only an in-memory merge would absorb
      // the write (e.g. an in-flight migration buffer) — see index.ts.
      await options.persist(value.state, { durable: true });
    } catch (error) {
      // The projection write ITSELF failed. Between SecureStore's
      // replace-primary and replace-recovery the disk may already hold the
      // mutated projection, so this rejection must NOT masquerade as
      // "nothing committed": only a code proven to originate BEFORE any disk
      // write (the allowlist) survives verbatim; every other throw is
      // classified PERSIST_WRITE_FAILED so the child reconciles.
      const explicitCode = typeof (error as unknown as { code?: unknown })?.code === "string"
        ? (error as unknown as { code: string }).code
        : undefined;
      rejectDurable(
        error instanceof Error && error.message ? error.message : "State persistence failed.",
        explicitCode !== undefined && PRE_PERSIST_REJECTION_CODES.has(explicitCode) ? explicitCode : "PERSIST_WRITE_FAILED"
      );
      return;
    }
    lastPersistedRevision = revision;
    lastPersistedProjection = value.state;
    sendMessage(child, { type: "state:persist:ack", requestId, revision });
  };

  return {
    get authenticated() { return authenticated; },
    get initializationSent() { return initializationSent; },
    get initializationConfirmed() { return initializationConfirmed; },
    get failed() { return failed; },
    get challenge() { return challenge; },
    attach(child: ChildIpc) {
      let attached = true;
      const onMessage = (value: any) => {
        if (!attached || failed) return;
        if (!authenticated) {
          if (value?.type !== "ready" || typeof value.challenge !== "string" || value.challenge.length < 24 || value.challenge.length > 256) return;
          authenticated = true;
          challenge = value.challenge;
          initializationSent = true;
          let callbackHandled = false;
          const onSend = (error: Error | null) => {
            if (callbackHandled) return;
            callbackHandled = true;
            if (!error) {
              initializationConfirmed = true;
              return;
            }
            authenticated = false;
            initializationSent = false;
            initializationConfirmed = false;
            challenge = null;
            failed = true;
          };
          try {
            if (typeof child.send !== "function") throw new Error("IPC channel is unavailable.");
            child.send({ type: "state:init", challenge: value.challenge, state: options.initialState }, onSend);
          } catch {
            onSend(new Error("IPC state initialization failed."));
          }
          return;
        }
        if (value?.type === "state:persist" && isChildKeyProjection(value.state)) {
          const durable = readDurablePersistContext(value);
          if (durable) {
            // Durable: acknowledge (or reject) only after persistence SETTLES.
            // The await must not block the message listener; failures are
            // reported back through the rejection message inside the handler.
            void handleDurablePersist(child, { state: value.state, requestId: durable.requestId, revision: durable.revision }).catch(() => { /* rejections are surfaced via state:persist:rejected */ });
            return;
          }
          // Legacy fire-and-forget save. The recorded durable projection MUST
          // follow whatever actually lands on disk: an ack-loss rollback
          // re-persists the pre-mutation state through this path, and if the
          // recorded projection stayed at the committed revision's projection,
          // the idempotent re-ack rule above would lie about what is durable.
          // Legacy writes never advance the revision ledger; they only refresh
          // the recorded projection — and only on SUCCESS.
          try {
            const settled = options.persist(value.state, { durable: false });
            if (settled && typeof (settled as Promise<void>).then === "function") {
              (settled as Promise<void>).then(() => { lastPersistedProjection = value.state; }, () => { /* logged by the persistence owner */ });
            } else {
              lastPersistedProjection = value.state;
            }
          } catch { /* a background save failure is logged by the persistence owner */ }
        }
      };
      child.on("message", onMessage);
      return () => {
        if (!attached) return;
        attached = false;
        child.removeListener("message", onMessage);
      };
    }
  };
}
