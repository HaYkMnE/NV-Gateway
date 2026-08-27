## Telemetry Policy

1. Must read from %APPDATA%\NV-Gateway\logs.
2. **Opt-in only**. (Requires user confirmation).
3. Uses an **allowlist** for keys (no blacklisting).
4. Strip local paths, cookies, authorization headers, and query strings.
5. Maintain a **durable cursor** to prevent duplicate analysis.
6. Telemetry payload must pass redactor checks.
7. PLACEHOLDER-TELEMETRY-RECEIVER
8. PLACEHOLDER-TELEMETRY-ALLOWLIST
9. PLACEHOLDER-CURSOR-STORAGE-PATH
