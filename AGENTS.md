# AI Agent Operational & Architectural Guidelines (AGENTS.md)

This document provides strict operational constraints, architectural invariants, and safety standards for any AI coding agent (OpenCode, Claude, Codex, Gemini, Cursor, and others) reading or modifying the **NV-Gateway** codebase.

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
- **Public Port (`12000`, the default; the effective port is the one in the app config)**: OpenAI-compatible `/v1/chat/completions`, `/v1/models`, and Anthropic-compatible `/v1/messages`.
- **Admin Port (`12001`, the default; always `P+1`)**: Authenticated admin REST endpoints protected by DPAPI-generated local admin token.
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
   - Non-stream request/response bodies must use `createBoundedBuffer(MAX_BUFFERED_RESPONSE_BYTES)` to prevent OOM DOS attacks. The default cap is 5 MiB, configurable through `GATEWAY_MAX_BUFFERED_RESPONSE_BYTES` between 1 KiB and 32 MiB (`src/gateway/bounded-buffer.mjs`).

---

## 3. Level-1 Testing & Quality Standards

Every modification must preserve a 100% pass rate across the full test suite (all tests passing, zero failures). Run `npm test` to verify.

Packaged-output check: `tests/gateway-bundle-shipping.test.mjs` (line 108) inspects `dist/win-unpacked`; it passes after the 29.09 repack (`npm run package:dir`). Rebuild that output whenever bundled engine files change. The full suite must pass with 0 failures.

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

## 4. Review & Evidence Policies

1. **Evidence Gate**:
   - Every bug report, fix, and claim must be backed by exact commit SHAs, command outputs, and file references.
   - Claims without concrete proof are treated as unverified assumptions and rejected.
2. **Two Clean Passes**:
   - Before approving a change, run the full test suite (`npm test`) twice in a row on the same commit SHA; both runs must pass.
3. **Stop on Repeated Failure**:
   - Two consecutive CI failures or rejected PRs on the same change mean a human must investigate before more attempts.

---

## 5. Rules for Modifying Files

- **Never create ad-hoc mock files or bypasses in production code.**
- **Preserve type-safety**: Ensure `npm run build` succeeds with zero TypeScript errors across both `tsconfig.json` and `tsconfig.node.json`.
- **Localization**: If adding UI strings, define each key in all 7 locales (`en`, `ru`, `zh`, `es`, `hi`, `fr`, `ar`) in `src/renderer/i18n/resources.ts` with exact key parity. The i18n tests pin the shared contract in `tests/support/i18n-contract.mjs`; `EXPECTED_LOCALE_KEY_COUNT` there is the single source of truth for the key count, so read it instead of trusting any number written in documentation. Bump it in that file when adding keys, and add the lineage line the file asks for.
