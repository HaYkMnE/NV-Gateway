# AI Agent Operational & Architectural Guidelines (AGENTS.md)

This document provides strict operational constraints, architectural invariants, and safety standards for any AI coding agent (Jules, OpenCode, Claude, Codex, Gemini, Cursor) reading or modifying the **NV-Gateway** codebase.

---

## 1. Core Architectural Invariants

The NV-Gateway system is split across three distinct operational layers:

```
[ Electron Main ]  ---(Private Authenticated IPC)--->  [ Gateway Child Process ]
        |                                                        |
(ContextBridge IPC)                                       (Local Loopback HTTP)
        v                                                        v
 [ React Renderer ]                                   [ External Clients / AI Tools ]
```

### A. Electron Main Process (`src/main/`)
- **Sole Owner of Secrets**: Electron Main owns Windows DPAPI (`safeStorage`) encryption and file persistence for `%APPDATA%\NV-Gateway\keys.json`.
- **Process Isolation**: Spawns the gateway child process with `ELECTRON_RUN_AS_NODE=1` and a strictly filtered environment (`createGatewaySpawnOptions`).
- **Paired-Port Attestation**: Enforces paired-port preflight. Only accepts child startup after verifying an authenticated challenge and a `ports:bound` attestation proving ownership of paired ports `P` and `P+1`.
- **Zero Raw Secrets to Renderer**: Renderer never receives decrypted NVIDIA API keys.

### B. Gateway Child Process (`src/gateway/`)
- **Pure Node.js Runtime**: Isolated server running on loopback (`127.0.0.1`).
- **Public Port (`12004`)**: OpenAI-compatible `/v1/chat/completions`, `/v1/models`, and Anthropic-compatible `/v1/messages`.
- **Admin Port (`12005`)**: Authenticated admin REST endpoints protected by DPAPI-generated local admin token.
- **Failover & Rotation**: LRU key selection, automated 429 quota/cooldown detection, 5xx transient backoffs, and stream-safe socket lifecycle.
- **Model Limits & Capabilities**: Dynamic capability probing (`capability-registry.mjs`, `capability-probe.mjs`, `model-limits.mjs`).

### C. React Renderer HUD (`src/renderer/`)
- **Zero Direct I/O**: Interacts with the backend strictly through `window.electronAPI` (`src/preload/index.ts`).
- **State Hydration**: Uses Zustand stores (`config.ts`, `models.ts`) and React Query for resilient UI updates.
- **Cyber Pet Engine**: State machine (`petEngine.ts`) driven by window focus, session storage, and VIP timers.

---

## 2. Strict Safety & Credential Constraints

1. **NO SECRET LEAKAGE**:
   - Never log, commit, or serialize raw API keys (e.g. `nvapi-...`), bearer tokens, or admin credentials.
   - All stdio, logging, and error pathways must pass through `redaction.mjs` (`setRuntimeSecrets`, `pathnameOnly`, query/fragment scrubbing).
2. **Deterministic Windows ACLs**:
   - Runtime directories and log files in `%APPDATA%\NV-Gateway\` receive best-effort DACL protection via `windows-acl-protector.ts`.
3. **Atomic File Transactions**:
   - State and config mutations (`keys.json`, `config.json`) must use atomic replace workflows (`write-file-atomic` style) and maintain `.bak` snapshots.
4. **No Unbounded Memory Buffers**:
   - Non-stream request/response bodies must use `createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES)` (max 10 MiB) to prevent OOM DOS attacks.

---

## 3. Level-1 Testing & Quality Standards

Every modification must preserve 100% pass rate across the full test suite (**511/511 tests passing**).

### Verification Commands:
```bash
# 1. Clean build verification
npm run build

# 2. Complete unit and integration test suite
npm test

# 3. Security, ASAR, and credential audit suite
npm run package:audit
```

### Static Audit Checks:
- `shipping-credential-scan.mjs`: Scans the entire codebase and packaging manifest for accidental credential literals.
- `packaged-security-smoke.mjs`: Validates ASAR integrity, context isolation, and CSP rules.
- `packaged-gateway-link-smoke.mjs`: Verifies ESM link graph and module boundaries.
- `packaged-migration-smoke.mjs`: Validates legacy configuration migration isolation.

---

## 4. Jules Autonomous 4-Agent Pipeline & Architecture

This repository is equipped with a complete, closed-loop autonomous software engineering pipeline powered by Google Labs Jules agents (using Gemini 3.1 Pro):

```
+-----------------------------------------------------------------------------------+
|                            1. LOG ANALYST (The Brain)                             |
|  - Triggers via cron (hourly) or manual dispatch (`autonomous-analysis.yml`)      |
|  - Stage 1: Inspects telemetry-bundle.json for 5xx errors, timeouts, exceptions   |
|  - Stage 2: Proactively audits codebase for tech debt, bugs, performance flaws   |
|  - Emits JSON handoff adhering to .jules/schemas/analyst-to-developer.schema.json |
|  - Opens tracked GitHub Issue with session name and handoff payload               |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                             2. DEVELOPER (The Hands)                              |
|  - Triggers reactively on opened Issues (`autonomous-developer.yml`)              |
|  - Reads role instructions (`.jules/roles/developer.md`) and Issue description    |
|  - Implements surgical changes + regression test under `tests/`                   |
|  - Verifies local build (`npm run build`) and test suite (`npm test`)             |
|  - Formats handoff matching .jules/schemas/developer-to-bug-hunter.schema.json   |
|  - Creates Pull Request titled `feat(jules): ...` or `fix(jules): ...`            |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                           3. BUG HUNTER (The Gatekeeper)                          |
|  - Triggers on Pull Request events (`autonomous-change.yml`)                      |
|  - Reads PR diff, test results, and `.jules/roles/bug-hunter.md`                  |
|  - Executes 2 Clean Passes verification rule on unchanged commit tree             |
|  - Emits verdict adhering to .jules/schemas/bug-hunter-verdict.schema.json        |
|  - Approves PR or requests changes via GitHub review comments                     |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                        4. DESIGN ART VIRTUOSO (UI Specialist)                     |
|  - Invoked for renderer / visual changes (`.jules/roles/design-art-virtuoso.md`)  |
|  - Enforces Cyberpunk HUD design system compliance (`docs/DESIGN_SYSTEM.md`)      |
|  - Validates layout balance, responsive density, CSS animations, and i18n         |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                    5. AUTONOMOUS MERGE & QUOTA MANAGEMENT                         |
|  - `autonomous-merge.yml`: Squash-merges approved `jules-*` PRs passing all gates |
|  - `autonomous-quota-reset.yml`: Tracks daily limits (`.jules/state/quota-state`) |
|    and auto-resets quota counters at 00:00 UTC rollover                           |
+-----------------------------------------------------------------------------------+
```

### Key Autonomous Policies:
1. **Evidence Gate (`.jules/policy/evidence-gate.md`)**:
   - Every bug report, fix, and claim must be backed by exact commit SHAs, command outputs, and file references.
   - Claims without concrete proof are classified as unverified assumptions and rejected.
2. **Circuit Breaker (`.jules/policy/circuit-breaker.md`)**:
   - Two consecutive CI failures or rejected PRs immediately pause autonomous dispatch until human investigation.
   - Flapping changes (reverting recent commits) are blocked automatically.
3. **The 2 Clean Passes Rule (`.jules/scripts/verify-clean-passes.ts`)**:
   - Bug Hunter requires **two independent, sequential passing test runs** (`npm test`) on an identical commit SHA before granting approval.
4. **Telemetry & Minimization (`.jules/scripts/collect-minimized-logs.ts`)**:
   - Telemetry logs are strictly sanitized, deduplicated, and minimized into `telemetry-bundle.json` without leaking secrets, tokens, or PII.

---

## 5. Rules for Modifying Files

- **Never create ad-hoc mock files or bypasses in production code.**
- **Preserve type-safety**: Ensure `npm run build` succeeds with zero TypeScript errors across both `tsconfig.json` and `tsconfig.node.json`.
- **Localization**: If adding UI strings, define entries in both English (`src/renderer/i18n/resources.ts` -> `en`) and Russian (`ru`).
