import { type ChildProcess, type SpawnOptions } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { createGatewaySpawnOptions, type GatewayRuntimePaths } from "./gateway-runtime";
import { createPrivateStateChannel } from "./private-state-channel";
import { redact } from "./redaction";
import { MAX_CHILD_KEYS, MAX_KEY_LENGTH, type ChildKeyProjection } from "./state-ownership";

export type GatewayState = "stopped" | "starting" | "running" | "error";

export interface GatewayStatus {
  state: GatewayState;
  port?: number;
  code?: "PORT_IN_USE" | "START_FAILED";
  message?: string;
}

export interface GatewayLifecycleOptions {
  executablePath: string;
  healthPollIntervalMs?: number;
  onStatusChange?: (status: GatewayStatus) => void;
  onLifecycleEvent?: (event: string, data: Record<string, unknown>) => void;
  runtimePaths: GatewayRuntimePaths;
  serverPath: string;
  spawnChild: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  startupTimeoutMs?: number;
  /** Graceful termination wait; production default is 3 seconds. */
  shutdownTimeoutMs?: number;
  /** Forced termination wait after graceful shutdown; production default is 3 seconds. */
  forcedShutdownTimeoutMs?: number;
  stdioLogPath?: string;
  workingDirectory?: string;
  afterOwnerRecordWrite?: (child: ChildProcess) => void | Promise<void>;
  initialState: unknown;
  persistState?: (state: ChildKeyProjection) => void;
  protectFile?: (filePath: string) => void;
  /** Opt-in, metadata-only callback used by explicit migration diagnostics. */
  onPreparedChildSpawn?: (phase: "requested" | "spawned", childPid?: number) => void;
}

interface BoundAttestation {
  attested: boolean;
  invalid: boolean;
}

const MAX_OUTPUT_LENGTH = 4_000;
const MAX_STDIO_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_STDIO_ROTATED_FILES = 3;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3_000;
const FORCED_SHUTDOWN_TIMEOUT_MS = 3_000;
const STATE_INVALID_MESSAGE = "Gateway lifecycle state is invalid.";
const MAX_GATEWAY_CREDENTIAL_LENGTH = 8_192;

export class GatewayLifecycle {
  private child: ChildProcess | null = null;
  private managedPort: number | null = null;
  private readonly executablePath: string;
  private readonly healthPollIntervalMs: number;
  private readonly onStatusChange?: (status: GatewayStatus) => void;
  private readonly onLifecycleEvent?: (event: string, data: Record<string, unknown>) => void;
  private readonly runtimePaths: GatewayRuntimePaths;
  private readonly serverPath: string;
  private readonly spawnChild: GatewayLifecycleOptions["spawnChild"];
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly forcedShutdownTimeoutMs: number;
  private readonly stdioLogPath: string;
  private readonly workingDirectory: string;
  private status: GatewayStatus = { state: "stopped" };
  private output = "";
  private operationQueue: Promise<unknown> = Promise.resolve();
  private stopRequestCount = 0;
  private readonly afterOwnerRecordWrite?: GatewayLifecycleOptions["afterOwnerRecordWrite"];
  private initialState: unknown;
  private initialStateRevision = 0;
  private readonly persistState: (state: ChildKeyProjection) => void;
  private readonly protectFile: (filePath: string) => void;
  private readonly onPreparedChildSpawn?: GatewayLifecycleOptions["onPreparedChildSpawn"];

  constructor(options: GatewayLifecycleOptions) {
    const initialState = cloneValidatedGatewayState(options.initialState);
    this.executablePath = options.executablePath;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? 100;
    this.onStatusChange = options.onStatusChange;
    this.onLifecycleEvent = options.onLifecycleEvent;
    this.runtimePaths = options.runtimePaths;
    this.serverPath = options.serverPath;
    this.spawnChild = options.spawnChild;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? GRACEFUL_SHUTDOWN_TIMEOUT_MS;
    this.forcedShutdownTimeoutMs = options.forcedShutdownTimeoutMs ?? FORCED_SHUTDOWN_TIMEOUT_MS;
    this.stdioLogPath = options.stdioLogPath ?? "";
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.afterOwnerRecordWrite = options.afterOwnerRecordWrite;
    this.assignInitialState(initialState);
    this.persistState = options.persistState ?? (() => {});
    this.protectFile = options.protectFile ?? (() => {});
    this.onPreparedChildSpawn = options.onPreparedChildSpawn;

    if (this.stdioLogPath) {
      fs.mkdirSync(path.dirname(this.stdioLogPath), { recursive: true });
      fs.closeSync(fs.openSync(this.stdioLogPath, "a", 0o600));
      this.protectFile(this.stdioLogPath);
    }
  }

  getStatus(): GatewayStatus {
    return { ...this.status };
  }

  /** True from a stop/retry request until its queued lifecycle transition settles. */
  isStopping(): boolean {
    return this.stopRequestCount > 0;
  }

  replaceInitialState(state: unknown): void {
    this.assignInitialState(cloneValidatedGatewayState(state));
  }

  /** Starts only this managed child with a caller-supplied in-memory state. */
  async startPrepared(state: unknown, port: number): Promise<GatewayStatus> {
    const preparedState = cloneValidatedGatewayState(state);
    return this.enqueue(async () => {
      const previous = this.initialState;
      const preparedRevision = this.assignInitialState(preparedState);
      const status = await this.startInternal(port, preparedState, true);
      if (status.state !== "running" && this.initialStateRevision === preparedRevision) this.assignInitialState(cloneValidatedGatewayState(previous));
      return status;
    });
  }

  async stopPrepared(): Promise<GatewayStatus> {
    return this.stop();
  }

  async start(port: number): Promise<GatewayStatus> {
    return this.enqueue(() => this.startInternal(port));
  }

  private async startInternal(port: number, initialState = this.initialState, preparedMigration = false): Promise<GatewayStatus> {
    if (!isCompleteGatewayState(initialState)) {
      return this.setStatus({ state: "error", code: "START_FAILED", port, message: STATE_INVALID_MESSAGE });
    }
    const conflict = await this.preflight(port);
    if (conflict) {
      return this.setStatus(conflict);
    }

    if (this.child) {
      return this.setStatus({
        state: "error",
        code: "START_FAILED",
        port,
        message: "Gateway is already managed by this application."
      });
    }

    this.output = "";
    this.setStatus({ state: "starting", port });
    const spawnOptions = createGatewaySpawnOptions(this.serverPath, this.runtimePaths, port);
    const ownerId = crypto.randomBytes(24).toString("hex");
    let child: ChildProcess;
    try {
      if (preparedMigration) try { this.onPreparedChildSpawn?.("requested"); } catch { /* diagnostics must not alter startup */ }
      child = this.spawnChild(this.executablePath, spawnOptions.args, {
        cwd: this.workingDirectory,
        env: spawnOptions.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true
      });
    } catch (error) {
      return this.setStatus({
        state: "error",
        code: "START_FAILED",
        port,
        message: this.withOutput(`Gateway child process error: ${error instanceof Error ? error.message : String(error)}`)
      });
    }
    this.child = child;
    if (preparedMigration) try { this.onPreparedChildSpawn?.("spawned", child.pid); } catch { /* diagnostics must not alter startup */ }
    this.managedPort = port;
    try {
      const privateChannel = createPrivateStateChannel({ initialState, persist: this.persistState });
      const boundAttestation = this.watchBoundAttestation(child, port, privateChannel, () => {
        void this.enqueue(() => this.handleProtocolViolation(child, port));
      });
      privateChannel.attach(child);
      this.captureOutput(child);

      const startupError = await this.waitForHealthOrFailure(child, port, privateChannel, boundAttestation);
      if (startupError) return this.failStartedChild(child, port, ownerId, startupError);

      const ownershipVerified = await this.verifyChildOwnership(child, port);
      if (!privateChannel.authenticated || !boundAttestation.attested || boundAttestation.invalid || !ownershipVerified || boundAttestation.invalid) {
        return this.failStartedChild(child, port, ownerId, {
          state: "error",
          code: "START_FAILED",
          port,
          message: this.withOutput("Gateway exited before startup could be verified.")
        });
      }

      this.writeOwnerRecord(child, port, ownerId);
      await this.afterOwnerRecordWrite?.(child);
      const recordedOwnershipVerified = await this.verifyChildOwnership(child, port);
      if (!privateChannel.authenticated || !boundAttestation.attested || boundAttestation.invalid || !recordedOwnershipVerified || boundAttestation.invalid) {
        return this.failStartedChild(child, port, ownerId, {
          state: "error",
          code: "START_FAILED",
          port,
          message: this.withOutput("Gateway exited before startup could be recorded.")
        });
      }
      return this.setStatus({ state: "running", port });
    } catch {
      return this.failStartedChild(child, port, ownerId, {
        state: "error",
        code: "START_FAILED",
        port,
        message: "Gateway startup could not be completed."
      });
    }
  }

  async retry(port: number): Promise<GatewayStatus> {
    return this.enqueueStopping(() => this.retryInternal(port));
  }

  private async retryInternal(port: number): Promise<GatewayStatus> {
    if (this.child && this.managedPort !== port) {
      const conflict = await this.preflight(port);
      if (conflict) return this.setStatus(conflict);
    }
    await this.stopInternal();
    return this.startInternal(port);
  }

  async stop(): Promise<GatewayStatus> {
    return this.enqueueStopping(() => this.stopInternal());
  }

  private async stopInternal(): Promise<GatewayStatus> {
    const child = this.child;
    if (child && !await this.stopChild(child)) {
      return this.setStatus({
        state: "error",
        code: "START_FAILED",
        port: this.managedPort ?? undefined,
        message: "Managed gateway child shutdown could not be confirmed."
      });
    }
    if (child && this.child === child) this.child = null;
    this.managedPort = null;
    if (child) this.clearOwnerRecordForChild(child, this.status.port ?? 0);
    else this.clearOwnerRecord();
    return this.setStatus({ state: "stopped" });
  }

  /**
   * Attempt to reclaim a gateway port that is held by a stale (orphaned)
   * process from a previous crash.  Probes /health on the port; if the
   * listener does not respond or does not return 200 we look up the PID
   * that holds the port and terminate it.  Returns true if the port was
   * reclaimed.
   */
  async reclaimOrphanedPort(port: number): Promise<boolean> {
    // Safe default: without independently verified PID, command-line,
    // creation-time, port ownership, and token identity proof, never kill.
    return false;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueStopping<T>(operation: () => Promise<T>): Promise<T> {
    this.stopRequestCount += 1;
    return this.enqueue(operation).finally(() => {
      this.stopRequestCount -= 1;
    });
  }

  private assignInitialState(state: Record<string, unknown>): number {
    this.initialState = state;
    this.initialStateRevision += 1;
    return this.initialStateRevision;
  }

  private writeOwnerRecord(child: ChildProcess, port: number, ownerId: string): void {
    if (!child.pid) return;
    const record = { pid: child.pid, ownerIdHash: crypto.createHash("sha256").update(ownerId).digest("hex"), executablePath: this.executablePath, serverPath: this.serverPath, createdAt: new Date().toISOString(), gatewayPort: port, adminPort: port + 1 };
    const temporaryPath = `${this.runtimePaths.ownerPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(record, null, 2), "utf8");
    this.protectFile(temporaryPath);
    fs.renameSync(temporaryPath, this.runtimePaths.ownerPath);
    this.protectFile(this.runtimePaths.ownerPath);
  }

  private clearOwnerRecord(): void {
    try { fs.unlinkSync(this.runtimePaths.ownerPath); } catch {}
  }

  private clearOwnerRecordFor(child: ChildProcess, port: number, ownerId: string): void {
    const ownerIdHash = crypto.createHash("sha256").update(ownerId).digest("hex");
    for (const filePath of [this.runtimePaths.ownerPath, `${this.runtimePaths.ownerPath}.tmp`]) {
      try {
        const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (record.pid === child.pid && record.gatewayPort === port && record.ownerIdHash === ownerIdHash) fs.unlinkSync(filePath);
      } catch {}
    }
  }

  private async verifyChildOwnership(child: ChildProcess, port: number): Promise<boolean> {
    return this.child === child && child.exitCode === null && !child.killed && await requestHealth(port);
  }

  private async failStartedChild(child: ChildProcess, port: number, ownerId: string, status: GatewayStatus): Promise<GatewayStatus> {
    const stopped = await this.stopChild(child);
    if (stopped) {
      this.clearOwnerRecordFor(child, port, ownerId);
      if (this.child === child) this.child = null;
      if (this.managedPort === port) this.managedPort = null;
      return this.setStatus(status);
    }
    this.retainFailedChildUntilExit(child, port, ownerId);
    this.onLifecycleEvent?.("gateway_lifecycle_cleanup_failed", { operation: "stop_child" });
    return this.setStatus({
      state: "error",
      code: "START_FAILED",
      port,
      message: "Gateway startup failed and managed child shutdown could not be confirmed."
    });
  }

  private retainFailedChildUntilExit(child: ChildProcess, port: number, ownerId: string): void {
    child.once("exit", () => {
      this.clearOwnerRecordFor(child, port, ownerId);
      if (this.child === child) this.child = null;
      if (this.managedPort === port) this.managedPort = null;
    });
  }

  private watchBoundAttestation(child: ChildProcess, port: number, channel: { authenticated: boolean; initializationSent: boolean; challenge: string | null }, onInvalid: () => void): BoundAttestation {
    const result: BoundAttestation = { attested: false, invalid: false };
    const invalidate = () => {
      if (result.invalid) return;
      result.invalid = true;
      onInvalid();
    };
    child.on("message", (message: unknown) => {
      const value = strictBoundAttestation(message);
      if (value === null) {
        if (isBoundAttestationCandidate(message)) invalidate();
        return;
      }
      if (result.attested || !channel.authenticated || !channel.initializationSent) { invalidate(); return; }
      if (typeof value.challenge !== "string" || value.challenge !== channel.challenge) { invalidate(); return; }
      if (!Number.isSafeInteger(value.gatewayPort) || !Number.isSafeInteger(value.adminPort) || value.gatewayPort !== port || value.adminPort !== port + 1) { invalidate(); return; }
      result.attested = true;
    });
    return result;
  }

private async preflight(port: number): Promise<GatewayStatus | null> {
    if (!Number.isInteger(port) || port < 1 || port > 65534) {
      return {
        state: "error",
        code: "START_FAILED",
        message: "Gateway port must be an integer between 1 and 65534."
      };
    }
    const [gatewayPort, admin] = await Promise.all([probePort(port), probePort(port + 1)]);

    if (gatewayPort.inUse) {
      // The port might be held by a stale orphaned process from a previous
      // crash.  Try to reclaim it before reporting PORT_IN_USE.
      const reclaimed = await this.reclaimOrphanedPort(port);
      if (!reclaimed) {
        return {
          state: "error",
          code: "PORT_IN_USE",
          port,
          message: `Gateway port ${port} is already in use.`
        };
      }
      // Port reclaimed from stale process — continue with admin check.
    }

    const adminPort = port + 1;
    if (admin.inUse) {
      const reclaimed = await this.reclaimOrphanedPort(adminPort);
      if (!reclaimed) {
        return {
          state: "error",
          code: "PORT_IN_USE",
          port: adminPort,
          message: `Admin port ${adminPort} is already in use.`
        };
      }
    }

    if (gatewayPort.error || admin.error) {
      return {
        state: "error",
        code: "START_FAILED",
        port: gatewayPort.error ? port : adminPort,
        message: `Could not verify ${gatewayPort.error ? "gateway" : "admin"} port availability: ${(gatewayPort.error ?? admin.error)?.message ?? "unknown error"}`
      };
    }

    return null;
  }

  private captureOutput(child: ChildProcess): void {
    const append = (chunk: Buffer | string) => {
      const text = String(redact(chunk.toString())).slice(0, MAX_OUTPUT_LENGTH);
      this.output = `${this.output}${text}`.slice(-MAX_OUTPUT_LENGTH);
      this.appendToStdioLog(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
  }

  private appendToStdioLog(text: string): void {
    if (!this.stdioLogPath || !text) return;

    const entry = {
      timestamp: new Date().toISOString(),
      text: text
    };
    const line = JSON.stringify(entry) + "\n";

    try {
      this.rotateStdioLogIfNeeded();
      fs.appendFileSync(this.stdioLogPath, line, "utf8");
    } catch {
      // Best-effort: silently drop if we cannot write
    }
  }

  private rotateStdioLogIfNeeded(): void {
    try {
      const stat = fs.statSync(this.stdioLogPath);
      if (stat.size < MAX_STDIO_FILE_SIZE) return;
    } catch {
      return;
    }

    const baseName = this.stdioLogPath.replace(/\.jsonl$/, "");

    // Remove oldest rotation first
    const oldestPath = `${baseName}.${MAX_STDIO_ROTATED_FILES}.jsonl`;
    try { fs.unlinkSync(oldestPath); } catch { /* ignore */ }

    // Shift: i=2 moves .1 -> .2, i=1 moves current -> .1
    for (let i = MAX_STDIO_ROTATED_FILES; i >= 1; i--) {
      const oldPath = i === 1 ? this.stdioLogPath : `${baseName}.${i - 1}.jsonl`;
      const newPath = `${baseName}.${i}.jsonl`;
      try { fs.renameSync(oldPath, newPath); this.protectFile(newPath); } catch { /* ignore */ }
    }
  }

  private async waitForHealthOrFailure(child: ChildProcess, port: number, channel: { authenticated: boolean }, boundAttestation: BoundAttestation): Promise<GatewayStatus | null> {
    let childFailure: string | null = null;
    const onError = (error: Error) => { childFailure = `Gateway child process error: ${error.message}`; };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      childFailure = `Gateway exited during startup${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`;
      if (this.child === child) this.child = null;
    };
    child.once("error", onError);
    child.once("exit", onExit);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline && !childFailure) {
      if (boundAttestation.invalid) {
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        return {
          state: "error",
          code: "START_FAILED",
          port,
          message: this.withOutput("Gateway exited before startup could be verified.")
        };
      }
      if (channel.authenticated && boundAttestation.attested && !boundAttestation.invalid && await requestHealth(port) && await requestAdminHealth(port + 1)) {
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        this.registerRuntimeEvents(child, port);
        return null;
      }
      await delay(this.healthPollIntervalMs);
    }

    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
    return {
      state: "error",
      code: "START_FAILED",
      port,
      message: this.withOutput(childFailure ?? "Gateway did not pass its health check before startup timed out.")
    };
  }

  private registerRuntimeEvents(child: ChildProcess, port: number): void {
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.managedPort = null;
      this.clearOwnerRecordForChild(child, port);
      this.setStatus({ state: "error", code: "START_FAILED", port, message: this.withOutput(`Gateway child process error: ${error.message}`) });
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.managedPort = null;
      this.clearOwnerRecordForChild(child, port);
      this.setStatus({
        state: "error",
        code: "START_FAILED",
        port,
        message: this.withOutput(`Gateway exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`)
      });
    });
  }

  private async handleProtocolViolation(child: ChildProcess, port: number): Promise<void> {
    if (this.child !== child || this.status.state === "starting") return;
    const stopped = await this.stopChild(child);
    if (stopped) {
      this.clearOwnerRecordForChild(child, port);
      if (this.child === child) this.child = null;
      if (this.managedPort === port) this.managedPort = null;
      this.setStatus({ state: "error", code: "START_FAILED", port, message: "Gateway lifecycle protocol violation." });
      return;
    }
    this.retainFailedChildUntilExit(child, port, "");
    this.onLifecycleEvent?.("gateway_lifecycle_cleanup_failed", { operation: "stop_child" });
    this.setStatus({ state: "error", code: "START_FAILED", port, message: "Gateway lifecycle protocol violation; managed child shutdown could not be confirmed." });
  }

  private clearOwnerRecordForChild(child: ChildProcess, port: number): void {
    try {
      const record = JSON.parse(fs.readFileSync(this.runtimePaths.ownerPath, "utf8"));
      if (record.pid === child.pid && record.gatewayPort === port) this.clearOwnerRecord();
    } catch {}
  }

  /**
   * On Windows, ChildProcess#kill sends a supported termination signal but
   * `killed` only confirms signal delivery. A successful stop requires `exit`.
   * Wait 3 seconds for SIGTERM, then 3 more seconds for SIGKILL by default.
   */
  private async stopChild(child: ChildProcess): Promise<boolean> {
    if (child.exitCode !== null) return true;
    if (!child.killed) {
      try { child.kill("SIGTERM"); } catch {}
    }
    if (await this.waitForChildExit(child, this.shutdownTimeoutMs)) return true;
    try { child.kill("SIGKILL"); } catch {}
    return this.waitForChildExit(child, this.forcedShutdownTimeoutMs);
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
      child.once("exit", onExit);
      if (child.exitCode !== null) finish(true);
    });
  }

  private setStatus(status: GatewayStatus): GatewayStatus {
    const safeStatus = sanitizeGatewayStatus(status);
    this.status = safeStatus;
    this.onStatusChange?.({ ...safeStatus });
    this.onLifecycleEvent?.("gateway_lifecycle", {
      state: safeStatus.state,
      port: safeStatus.port ?? null,
      code: safeStatus.code ?? null,
      message: safeStatus.message ?? null
    });
    return { ...safeStatus };
  }

  private withOutput(message: string): string { return String(redact(message)).slice(0, MAX_OUTPUT_LENGTH); }
}

function cloneValidatedGatewayState(value: unknown): Record<string, unknown> {
  if (!isCompleteGatewayState(value)) throw new Error(STATE_INVALID_MESSAGE);
  try {
    return structuredClone(value);
  } catch {
    throw new Error(STATE_INVALID_MESSAGE);
  }
}

function isCompleteGatewayState(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = value as Record<string, unknown>;
    const credentials = state.credentials;
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return false;
    const tokens = credentials as Record<string, unknown>;
    if (Object.keys(tokens).length !== 2
      || !isGatewayCredential(tokens.gatewayToken)
      || !isGatewayCredential(tokens.adminToken)) return false;
    return Array.isArray(state.keys)
      && state.keys.length <= MAX_CHILD_KEYS
      && state.keys.every(isGatewayInitialKeyRecord);
  } catch {
    return false;
  }
}

function isGatewayCredential(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_GATEWAY_CREDENTIAL_LENGTH
    && value === value.trim();
}

function isGatewayInitialKeyRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const material = typeof record.key === "string" ? record.key : record.apiKey;
  return typeof material === "string" && material.length > 0 && material.length <= MAX_KEY_LENGTH;
}

function sanitizeGatewayStatus(status: GatewayStatus): GatewayStatus {
  return {
    state: status.state,
    ...(status.port === undefined ? {} : { port: status.port }),
    ...(status.code === undefined ? {} : { code: status.code }),
    ...(status.message === undefined ? {} : { message: String(redact(status.message)).slice(0, MAX_OUTPUT_LENGTH) })
  };
}

async function probePort(port: number): Promise<{ inUse: boolean; error?: Error }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"
      ? { inUse: true }
      : { inUse: false, error }));
    server.once("listening", () => server.close(() => resolve({ inUse: false })));
    server.listen(port, "127.0.0.1");
  });
}

async function requestHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({
      host: "127.0.0.1",
      port,
      path: "/health",
      timeout: 500,
      agent: false  // prevent keep-alive socket pooling that could hold the event loop
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function requestAdminHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 500, agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 404));
    });
    request.once("error", () => resolve(false));
    request.once("timeout", () => { request.destroy(); resolve(false); });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const BOUND_ATTESTATION_FIELDS = ["type", "challenge", "gatewayPort", "adminPort"] as const;

function isBoundAttestationCandidate(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  try {
    const type = Object.getOwnPropertyDescriptor(message, "type");
    return type?.get === undefined && type?.set === undefined && type.value === "ports:bound";
  } catch {
    return false;
  }
}

function strictBoundAttestation(message: unknown): Record<(typeof BOUND_ATTESTATION_FIELDS)[number], unknown> | null {
  if (!isBoundAttestationCandidate(message)) return null;
  try {
    if (Object.getPrototypeOf(message) !== Object.prototype || Object.getOwnPropertySymbols(message).length !== 0) return null;
    const fields = Object.getOwnPropertyNames(message);
    if (fields.length !== BOUND_ATTESTATION_FIELDS.length || !fields.every((field) => BOUND_ATTESTATION_FIELDS.includes(field as (typeof BOUND_ATTESTATION_FIELDS)[number]))) return null;
    const result = {} as Record<(typeof BOUND_ATTESTATION_FIELDS)[number], unknown>;
    for (const field of BOUND_ATTESTATION_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(message, field);
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) return null;
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

