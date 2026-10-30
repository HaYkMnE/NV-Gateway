# Security Policy

NV Gateway stores NVIDIA API keys and runs a local API for AI tools. This file explains how to report a security problem, what is in scope, and how the app protects your keys. The code is open source, so every property below can be checked in this repository.

---

## 1. Supported Versions

| Version | Supported |
| :--- | :--- |
| Current release (the `version` in [`package.json`](../package.json)) | :white_check_mark: |
| Any older release | :x: |

Only the latest release receives fixes. Update through the app or from the [releases page](https://github.com/HaYkMnE/NV-Gateway/releases/latest).

---

## 2. Reporting a Vulnerability

Report security problems privately through GitHub private vulnerability reporting on this repository: open the [Security tab](https://github.com/HaYkMnE/NV-Gateway/security) and click **Report a vulnerability**, or go to `https://github.com/HaYkMnE/NV-Gateway/security/advisories/new`.

1. **Do not open a public GitHub issue**, and do not use the in-app Feedback. Both are public.
2. Include the NV Gateway version (shown in the app), your Windows version, the steps to reproduce, what you expected, and the affected component if you know it.
3. Never send real NVIDIA API keys or gateway tokens. Remove them from logs and use placeholders.
4. We aim to acknowledge reports as soon as possible and, once a report is assessed, to share a timeline for the fix. When the fix is released, you are credited in the release notes unless you prefer to stay anonymous.

---

## 3. Scope

In scope:

- the NV Gateway Windows app and its installer from the official releases page;
- the local API on `127.0.0.1` and the gateway and admin token checks;
- how the app stores keys and writes logs;
- the update check and the error-report upload;
- the source code, build scripts and release workflow in this repository.

Out of scope:

- NVIDIA's services, accounts and rate limits. Report those to NVIDIA.
- Third-party clients such as Claude Code, Cline or Cursor.
- The SmartScreen warning caused by the unsigned installer. This is known.
- Problems that need an attacker who already controls your Windows user account.
- Builds downloaded from anywhere other than the official releases page, and forks published under another name.

---

## 4. Security Architecture

### A. Windows DPAPI Encryption at Rest
- API keys, local gateway tokens, and admin credentials stored in `%APPDATA%\NV-Gateway\keys.json` are encrypted using the Windows Data Protection API (`safeStorage`).
- Decrypted keys are held in memory only within the isolated gateway child process and are never written to disk in plaintext.

### B. Loopback Network Boundary (`127.0.0.1`)
- Both the public gateway port (`12000`) and admin port (`12001`) bind strictly to `127.0.0.1`.
- Requests from external network interfaces are rejected at the operating system level.

### C. Paired-Port Ownership Challenge & IPC Attestation
- The Electron main process only accepts a gateway child process after:
  1. A mutual private IPC handshake using a cryptographically secure random challenge.
  2. A `ports:bound` attestation confirming that the child process successfully bound both the gateway and admin ports.
- Simple HTTP liveness checks are never accepted as proof of process ownership.

### D. Electron Process Isolation & Content Security Policy (CSP)
- The React renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
- Renderer IPC is constrained through a minimal `contextBridge` surface in `src/preload/index.ts`.
- Navigation, popups, and arbitrary new windows are strictly denied.
- CSP headers deny inline scripts and restrict resource loading.

### E. Zero Memory DOS (Bounded Response Buffers)
- Non-streaming upstream buffers default to 5 MiB (`DEFAULT_MAX` in `src/gateway/bounded-buffer.mjs`), configurable through `GATEWAY_MAX_BUFFERED_RESPONSE_BYTES` to any value between 1 KiB and 32 MiB.
- The LLM Stats strength-ranking fetch uses a tighter 4 MiB cap (`MAX_RESPONSE_BYTES` in `src/gateway/llm-stats-ranking.mjs`), and inbound `/v1` request payloads are capped at 5 MB (`MAX_PAYLOAD_SIZE` in `src/gateway/server.mjs`).
- Oversized responses fail safely with HTTP `502 Bad Gateway` rather than consuming excessive memory.

### F. Credential Redaction & Log Scrubbing
- All logging subsystems (`app.jsonl`, `gateway.jsonl`, `gateway-stdio.jsonl`, `migration-phase.jsonl`) pass outputs through `src/shared/redaction.mjs`.
- URL queries, authorization headers, bearer tokens, and NVIDIA API keys (`nvapi-...`) are recursively redacted prior to disk persistence.
- Windows ACL permissions are applied best-effort on runtime log directories to restrict access to the current OS user SID.
- Five test files under `tests/` contain obviously fake keys that are fed to the redactors to prove they work. Secret scanners will report them. Only those exact files are allowlisted in [`.gitleaks.toml`](../.gitleaks.toml); the rest of the repository is still scanned.

### G. Release Authenticity & Download Trust
- Release builds are **not code-signed** (no Authenticode certificate), so Windows SmartScreen may warn about an unknown publisher.
- All releases are built by GitHub Actions from this repository's source ([`.github/workflows/release.yml`](workflows/release.yml)).
- One public repository holds the code, the issues, the security advisories and the releases: `github.com/HaYkMnE/NV-Gateway`. It is also the update feed: `electron-builder.yml` bakes it into the packaged `app-update.yml`, and `scripts/packaging-env-guard.mjs` (`DEFAULT_RELEASE_REPOSITORY`) refuses to package a different one. Installs made before the rename from the old releases-repository name reach it through GitHub's repository redirect.
- Fetch release binaries only from `github.com/HaYkMnE/NV-Gateway/releases`, check them against the `SHA256SUMS.txt` attached to the same release, and treat copies hosted anywhere else as untrusted. The checksum comes from the same release, so it catches a damaged or altered download, not a compromised release. You can also build the app yourself; see [Build from source](../DEVELOPMENT.md#build-from-source).
