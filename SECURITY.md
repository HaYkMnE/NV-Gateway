# Security Policy

The **NV-Gateway** team takes security, privacy, and credential safety seriously. Because NV-Gateway manages sensitive NVIDIA API keys and serves as a local reverse proxy for AI coding agents, our architecture enforces strict defense-in-depth security principles.

---

## 1. Supported Versions

| Version | Supported |
| :--- | :--- |
| `0.1.0` (Latest / Active) | :white_check_mark: |
| `< 0.1.0` (Legacy / Deprecated) | :x: |

---

## 2. Threat Model & Security Architecture

NV-Gateway is engineered to protect user credentials and system integrity against local and upstream attack vectors:

### A. Windows DPAPI Encryption at Rest
- API keys, local gateway tokens, and admin credentials stored in `%APPDATA%\NV-Gateway\keys.json` are encrypted using the Windows Data Protection API (`safeStorage`).
- Decrypted keys are held in memory only within the isolated gateway child process and are never written to disk in plaintext.

### B. Loopback Network Boundary (`127.0.0.1`)
- Both the public gateway port (`12004`) and admin port (`12005`) bind strictly to `127.0.0.1`.
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
- Non-streaming upstream buffers are strictly capped at 10 MiB (`resolveMaxBufferedResponseBytes()`) using `createBoundedBuffer`.
- Oversized responses fail safely with HTTP `502 Bad Gateway` rather than consuming excessive memory.

### F. Credential Redaction & Log Scrubbing
- All logging subsystems (`app.jsonl`, `gateway.jsonl`, `gateway-stdio.jsonl`, `migration-phase.jsonl`) pass outputs through `src/shared/redaction.mjs`.
- URL queries, authorization headers, bearer tokens, and NVIDIA API keys (`nvapi-...`) are recursively redacted prior to disk persistence.
- Windows ACL permissions are applied best-effort on runtime log directories to restrict access to the current OS user SID.

### G. Release Authenticity & Download Trust
- Release builds are currently **not code-signed** (no Authenticode certificate); Windows SmartScreen may warn about an unknown publisher on first launch.
- The trust model is HTTPS delivery plus the publishing GitHub account `HaYkMnE` — fetch releases **only** from `github.com/HaYkMnE/NV-Gateway/releases` and treat copies hosted anywhere else as untrusted.

---

## 3. Reporting a Vulnerability

If you discover a potential security vulnerability in NV-Gateway:

1. **Do NOT open a public GitHub issue.**
2. Send a detailed report describing the vulnerability, proof-of-concept steps, and affected components to the project maintainers via GitHub Private Vulnerability Reporting (enabled on this repository).
3. We will acknowledge receipt of your report within 48 hours and provide a timeline for triage and remediation.
4. Once a fix is verified and released, you will be credited in our release notes (unless you prefer to remain anonymous).
