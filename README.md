# NV-GATEWAY // NEURAL PROXY HUD

<div align="center">

```
   ███╗   ██╗██╗   ██╗   ██████╗  █████╗ ████████╗███████╗██╗    ██╗ █████╗ ██╗   ██╗
   ████╗  ██║██║   ██║  ██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝██║    ██║██╔══██╗╚██╗ ██╔╝
   ██╔██╗ ██║██║   ██║  ██║  ███╗███████║   ██║   █████╗  ██║ █╗ ██║███████║ ╚████╔╝ 
   ██║╚██╗██║╚██╗ ██╔╝  ██║   ██║██╔══██║   ██║   ██╔══╝  ██║███╗██║██╔══██║  ╚██╔╝  
   ██║ ╚████║ ╚████╔╝   ╚██████╔╝██║  ██║   ██║   ███████╗╚███╔███╔╝██║  ██║   ██║   
   ╚═╝  ╚═══╝  ╚═══╝     ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝ ╚══╝╚══╝ ╚═╝  ╚═╝   ╚═╝   
```

**Next-Gen Local AI Gateway & Desktop Control Deck for NVIDIA NGC / NIM Models**
*OpenAI and Anthropic Dual Gateway // Local Anthropic Messages Proxy // Claude Code with NVIDIA NIM*

[![Release](https://img.shields.io/badge/Release-v0.1.0-00FF66?style=for-the-badge&logo=github&logoColor=black)](https://github.com/HaYkMnE/NV-Gateway/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-00E5FF?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-31-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://electronjs.org/)
[![Anthropic Compatible](https://img.shields.io/badge/Anthropic-Messages%20API%20%2F%20Claude%20Code-D97706?style=for-the-badge&logo=anthropic&logoColor=white)](https://docs.anthropic.com)
[![NVIDIA NIM](https://img.shields.io/badge/NVIDIA-NGC%20%2F%20NIM-76B900?style=for-the-badge&logo=nvidia&logoColor=white)](https://build.nvidia.com)
[![Tests](https://img.shields.io/badge/Tests-passing-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white)](tests/)

</div>

---

## Bottom Line Up Front (BLUF)

**NV-Gateway** is a high-performance, local **OpenAI and Anthropic dual gateway** and desktop HUD running on `127.0.0.1:12000`. It functions as a native **Local Anthropic Messages Proxy** and **NVIDIA NGC Anthropic API adapter**, allowing tools that only speak Anthropic (such as **Claude Code CLI**, Claude Desktop, and Anthropic SDKs) to seamlessly drive **100+ NVIDIA NGC / NIM models** with zero extra middleware while simultaneously serving standard OpenAI `/v1/chat/completions`. It features intelligent multi-key LRU pooling, automated reasoning/thinking capability discovery, **zero rate limits failover** (`429` cooldowns & retries), Windows DPAPI encryption at rest, and zero mandatory telemetry.

Whether you're running **Claude Code (`claude-code` CLI)**, autonomous coding swarms (OpenCode, Cline, Cursor, Aider), or interactive chat agents, NV-Gateway delivers **zero rate limits failover**, filters out dead keys (`401`/`403`), discovers model-specific reasoning controls (thinking budgets), and injects context window metadata on the fly.

> 🤖 For AI agents & crawlers: [llms.txt](llms.txt) · [AGENTS.md](AGENTS.md)

---

## Why NV-Gateway?

**Short answer:** other gateways (LiteLLM, one-api, new-api) are *servers* you deploy, configure, and babysit. NV-Gateway is a **Windows desktop app**: one installer, system tray, done — and every AI coding tool on your machine gets a single local super-endpoint for **100+ NVIDIA NGC/NIM models**.

### What You Get After Downloading

- **One installer, zero DevOps** — 1-click setup, tray app, first-run wizard. No Docker, no Python env, no YAML.
- **OpenAI and Anthropic dual gateway** — `http://127.0.0.1:12000/v1` (and `http://127.0.0.1:12000` as `ANTHROPIC_BASE_URL`) speaks OpenAI (`/chat/completions`) and Anthropic (`/v1/messages`) natively. **Claude Code**, OpenCode, Cline, Cursor, Aider, Continue, Windsurf, OpenClaw: point, and go.
- **Claude Code with NVIDIA NIM** — Drop-in replace Anthropic endpoints for Anthropic's official `claude-code` CLI and run 100+ NVIDIA NIM models (GLM-5, Llama 3.3 70B, DeepSeek-R1, Qwen 2.5, Nemotron, Mistral) with full tool-calling and streaming support without proxy servers or Docker.
- **All your keys behave like one** — paste your NVIDIA keys into the GUI once; LRU rotation, dead-key quarantine (`401/403`), and `429` cooldowns are automatic with **zero rate limits failover**.
- **Runs that don't die mid-task** — automatic failover to the next key keeps long agent sessions alive through quota exhaustion.
- **Models, auto-tuned** — reasoning levels (`none → max`) and context/output limits are discovered and injected into `/v1/models`, so your tool stops truncating prompts.
- **Private by default** — keys encrypted with Windows DPAPI, loopback-only listener, zero mandatory telemetry.
- **A HUD you'll actually enjoy** — live diagnostics, key health, model explorer, and a cyber pet that reacts to your gateway's state.

### NV-Gateway vs Typical Alternatives

| | **NV-Gateway** | **LiteLLM / one-api / new-api** | **Direct NIM (no gateway)** |
| --- | --- | --- | --- |
| What it is | Windows desktop app (GUI + built-in local gateway) | Server you self-host (Python/Docker, config files; some ship a web dashboard) | Nothing — your tool calls `integrate.api.nvidia.com` itself |
| Setup | 1-click installer | Deploy + configure + keep a service running | One API key from build.nvidia.com |
| Key pooling | GUI-managed key pool (up to 1,000 keys), automatic LRU rotation | Single key or config-defined pools | One key |
| 429s & dead keys | Automatic zero rate limits failover + cooldown, requests don't drop | Depends on your config; built for hosted infra | The request fails — you handle it |
| Protocols | **OpenAI and Anthropic dual gateway** out of the box (native `/v1/messages` facade for Claude Code) | OpenAI-compatible core; Anthropic support varies by product/config | OpenAI-compatible only |
| Model metadata | Context/output limits + reasoning levels injected into `/v1/models` | Varies | Raw catalog |
| Best for | A developer on Windows who wants Claude Code and every local AI tool on 100+ NVIDIA models in minutes | Teams running shared, self-hosted LLM infrastructure | One-off tests |

> Free and open-source (MIT). The only account you need is your NVIDIA NGC API key(s).

---

## System Architecture

```
                                  +----------------------------------------------------+
                                  |                 AI Coding Agents                   |
                                  |Claude Code / OpenCode / Cline / Cursor / Aider / ..|
                                  +-------------------------+--------------------------+
                                                            |
                                      OpenAI / Anthropic REST & SSE Streams
                                      Base URL: http://127.0.0.1:12000 (/v1)
                                                            |
                                                            v
+---------------------------------------------------------------------------------------------------------------+
| NV-GATEWAY LOCAL RUNTIME                                                                                      |
|                                                                                                               |
|  +---------------------------------------+                 +-----------------------------------------------+  |
|  |       ELECTRON MAIN PROCESS           |                 |            GATEWAY CHILD PROCESS              |  |
|  |                                       |                 |                                               |  |
|  |  - DPAPI safeStorage (keys.json)      |                 |  - Port 12000: Public OpenAI/Anthropic Facade |  |
|  |  - System Tray Management             |  Private IPC    |  - Port 12001: Local Admin REST API           |  |
|  |  - Auto-Update Coordinator (offered)  +<===============>+  - LRU Key Rotation & Failover Engine         |  |
|  |  - Paired-Port Ownership Guard        |  Challenge Auth |  - Dynamic Reasoning & Capability Discovery   |  |
|  |  - JSONL App Logger (5MB rotation)    |                 |  - Model Limits Injection (Context/Output)    |  |
|  +-------------------+-------------------+                 +-----------------------+-----------------------+  |
|                      |                                                             |                          |
|         ContextBridge IPC (Zero-Secret UI)                                         | Outbound HTTPS           |
|                      v                                                             | (One-off connections,    |
|  +---------------------------------------+                                         |  Attribution headers)    |
|  |        REACT DESKTOP HUD              |                                         |                          |
|  |                                       |                                         |                          |
|  |  - Real-Time Live Diagnostics & Logs  |                                         |                          |
|  |  - Model Explorer & Performance Tuning|                                         |                          |
|  |  - Key Management Deck                |                                         |                          |
|  |  - Cyber Pet Companion (State Machine)|                                         |                          |
|  +---------------------------------------+                                         |                          |
+------------------------------------------------------------------------------------|--------------------------+
                                                                                      |
                                                                                      v
                                                                    +-----------------------------------+
                                                                    |      NVIDIA NGC / NIM API         |
                                                                    |  (integrate.api.nvidia.com)       |
                                                                    |  100+ Models (GLM, LLaMA, Qwen...) |
                                                                    +-----------------------------------+
```

---

## Repository Map

Start with [`package.json`](package.json) for supported commands, then follow the runtime boundary from [`src/main/index.ts`](src/main/index.ts) through [`src/preload/index.ts`](src/preload/index.ts) to [`src/renderer/App.tsx`](src/renderer/App.tsx). In development the main process starts the separate gateway from [`src/gateway/server.mjs`](src/gateway/server.mjs); packaged builds start its generated `build/gateway/server.mjs` bundle from inside `app.asar`. Read [`AGENTS.md`](AGENTS.md) before changing runtime, security, packaging, or localization behavior.

| Area | Purpose and flow | Start here and known limits |
| --- | --- | --- |
| [`.github/workflows/`](.github/workflows/) | Runs Windows CI, packaged audits, releases, and the preserved Jules automation definitions. | Start with [`test.yml`](.github/workflows/test.yml) and [`release.yml`](.github/workflows/release.yml). The shipped product jobs target Windows and Node 20; the autonomous jobs run only when `vars.AUTONOMOUS_LOOP_ENABLED == 'true'`. |
| [`src/main/`](src/main/) | Electron's privileged process owns app startup, windows and tray, DPAPI-backed state, gateway lifecycle, updates, and validated IPC. | [`index.ts`](src/main/index.ts) is the process entry point. Keep upstream NVIDIA keys and native I/O here; expose renderer capabilities only through validated IPC. The local gateway token is intentionally returned to the Endpoint view for client configuration. |
| [`src/preload/`](src/preload/) | Exposes the narrow `window.electronAPI` context bridge used by the sandboxed renderer. | [`index.ts`](src/preload/index.ts) is the preload entry point. Add renderer-to-main capabilities through validated IPC rather than direct Node or Electron access. |
| [`src/renderer/`](src/renderer/) | Contains the React HUD, routes, views, stores, components, cyber pet, styles, and provider assets. [`i18n/config.ts`](src/renderer/i18n/config.ts) applies language and document direction, while [`i18n/resources.ts`](src/renderer/i18n/resources.ts) holds UI strings. | [`index.html`](src/renderer/index.html) loads [`index.tsx`](src/renderer/index.tsx), which mounts [`App.tsx`](src/renderer/App.tsx). `App.tsx` and [`lib/modal-context.ts`](src/renderer/lib/modal-context.ts) coordinate one app-level modal; backend access must stay behind `window.electronAPI`. |
| [`src/gateway/`](src/gateway/) | Implements the isolated Node.js OpenAI/Anthropic gateway, public and admin routes, key rotation, failover, model discovery, limits, validation, and logging. | [`server.mjs`](src/gateway/server.mjs) is the child-process entry point. It binds loopback ports and is bundled into generated `build/gateway/` for packaging. |
| [`src/test-support/`](src/test-support/) | Provides compiled adapters and entry points for migration and configuration tests. | Start with [`final-migration-test-entrypoint.ts`](src/test-support/final-migration-test-entrypoint.ts). This directory is test-only and `electron-builder.yml` excludes it from the packaged app. |
| [`scripts/`](scripts/) | Holds gateway bundling, package hardening, release guards, credential/security audits, and evidence utilities invoked by package scripts and workflows. | Start with [`build-gateway-bundle.mjs`](scripts/build-gateway-bundle.mjs) for gateway output and [`run-electron-builder.mjs`](scripts/run-electron-builder.mjs) for packaging. Some scripts require packaged output or release environment variables; use the matching `package.json` script. |
| [`tests/`](tests/) | Contains Node test-runner unit, integration, regression, security, and packaged-output checks. | `npm test` is the package-script entry point and runs `npm run build` first through `pretest`. Packaged assertions need `dist/win-unpacked`, which `npm run package:dir` creates before running `npm run package:audit`. |
| [`build/assets/`](build/assets/) | Stores the committed canonical application and tray icon sources and rasters consumed by packaging. | Follow [`ICONS.md`](build/assets/ICONS.md). Tray assets also have a development mirror under `src/renderer/assets/`; tray-icon changes must keep the documented mirror and stopped-icon fallback in sync. |
| Primary configuration | [`package.json`](package.json) defines Electron's generated main entry, dependencies, and supported dev/build/test/package commands; [`package-lock.json`](package-lock.json) locks dependencies. [`tsconfig.json`](tsconfig.json) checks the renderer, while [`tsconfig.node.json`](tsconfig.node.json) emits main, preload, and test-support code. [`vite.config.ts`](vite.config.ts) builds and serves the renderer. [`electron-builder.yml`](electron-builder.yml) defines Windows packaging. [`tailwind.config.js`](tailwind.config.js) and [`postcss.config.js`](postcss.config.js) define renderer CSS processing. | Use these files as the source of truth instead of inferred defaults. Vite writes renderer output under `build/renderer`; Electron Builder writes distributable output under `dist/`. |
| Generated output | `build/` is a mixed tree: [`build/assets/`](build/assets/) is committed, while compiled `build/src/`, `build/renderer/`, `build/gateway/`, and generated Vite config output are ignored. `dist/` is ignored and contains Electron Builder's unpacked app and installer/portable artifacts. | Do not edit generated paths by hand or treat `build/` and `dist/` as interchangeable: `build/` stages compiled application input, while `dist/` holds packaged distribution output. |

### Current verified behavior

The renderer applies RTL layout for Arabic while keeping technical values such as ports, URLs, tokens, commands, and logs in LTR flow. After startup commits the running state, an unexpected gateway child exit reports a runtime-exit status and the Retry action remains available; an exit before that commitment remains a startup failure. One app-level modal arbiter uses request/session identity so stale asynchronous work cannot replace or close the current dialog. Dialog close controls use context-specific localized labels, and successful Endpoint copies announce through a dedicated polite live region while copy failures remain alerts.

---

## Key Features

### 1. Multi-Key Rotation & Zero Rate Limits Failover
- **Intelligent LRU Selection**: Rotates across your NVIDIA API keys automatically — from a single key to a pool of up to 1,000.
- **Failover Engine**:
  - `401 / 403`: Immediately disables the invalid key.
  - `429 (Quota Exceeded)`: Identifies account-level quota exhaustion and places key in cooldown.
  - `429 (Rate Limit)`: Applies backoff according to `Retry-After` header (capped to max 20s) and attempts the next available key immediately without blocking.
  - `5xx / Socket Timeouts`: Backs off transient server errors and retries the request seamlessly on another key.

### 2. Automatic Reasoning & Thinking Discovery
- Dynamically probes and discovers native reasoning parameters for advanced models:
  - **Z-AI GLM (GLM-4 / GLM-5)**: Discovers and injects `reasoning_effort` (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and `chat_template_kwargs.enable_thinking`.
  - **DeepSeek (R1 / V3)**: Auto-negotiates thinking token streams and structured outputs.
  - **Qwen & Nemotron**: Automatically enriches capabilities and configures reasoning budgets.

### 3. Model Limits & Metadata Enrichment
- Injects real context window (`context_length`) and completion limit (`max_tokens`, `max_completion_tokens`) metadata directly into `/v1/models` responses.
- Allows AI coding tools to optimize prompts without truncation errors.

### 4. OpenAI and Anthropic Dual Gateway (Native Translation Facade)
- **OpenAI Compatible**: `/v1/chat/completions`, `/v1/models`.
- **Local Anthropic Messages Proxy & NVIDIA NGC Anthropic API Adapter**: Native `/v1/messages` translation facade that translates Anthropic Messages schema (tool/function calling, multi-turn conversations, multi-part prompt blocks, system prompts, thinking/reasoning parameters, and SSE event streaming) directly to NVIDIA NGC backends. Enables **Claude Code with NVIDIA NIM**, Anthropic SDKs, and Claude Desktop to use 100+ models with zero extra middleware or translation servers.

### 5. Windows DPAPI Encryption at Rest
- API keys and administrative tokens are encrypted on disk via Windows Data Protection API (`safeStorage`).
- Decrypted secrets are never written to disk and remain strictly inside authenticated inter-process communication.

### 6. Interactive Cyber Pet Companion
- An interactive HUD companion (`Mascot` / `Hacker`) powered by an autonomous state machine.
- Reacts to window focus, errors, VIP status, and gateway activity with attention-driven behaviors and cyber SFX.

### 7. 100% Offline Core & Privacy Guarantee
- The gateway core runs 100% locally on loopback (`127.0.0.1`).
- Zero mandatory telemetry or tracking. Diagnostic error reporting is strictly opt-in and user-triggered via Cloudflare workers with full credential redaction.

---

## Quick Start

### Option A: 1-Click Installer (Windows)
 1. Download `NV-Gateway-Setup-0.1.0.exe` from [GitHub Releases](https://github.com/HaYkMnE/NV-Gateway/releases).
2. Launch the installer (installs per-user to `%LOCALAPPDATA%\Programs\NV-Gateway`).
3. Follow the first-run wizard to add your NVIDIA API keys and select your local port (default: `12000`).
4. Close the window to minimize to the System Tray.

### Option B: Build from Source

```bash
# Clone the repository
git clone https://github.com/HaYkMnE/NV-Gateway.git
cd nv-gateway

# Install dependencies
npm install

# Build the Electron app and gateway bundle
npm run build

# In terminal 1, start the Vite renderer
npm run dev

# In terminal 2, start Electron
npm start

# Or build the portable executable
npm run build:portable
```

The portable binary is created in `dist/NV-Gateway 0.1.0.exe`.

---

## AI Coding Agent Integrations

Point your favorite AI coding assistant to NV-Gateway:

Copy the generated **Gateway Token** from the app's **Endpoint** screen; the placeholder `<gateway-token>` below is not a working credential.

### 1. Claude Code (`claude-code` CLI)

Run Anthropic's official **Claude Code** CLI powered by 100+ NVIDIA NIM models with zero extra middleware. NV-Gateway acts as a native **Local Anthropic Messages Proxy** and **NVIDIA NGC Anthropic API adapter**, translating Anthropic `/v1/messages` schema (multi-turn conversations, tool calling, thinking/reasoning blocks, and SSE streaming) directly to NVIDIA NGC backends. Claude Code must send the generated gateway token as a Bearer credential, so use the auth-token variable shown below rather than the API-key variable:

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:12000"
$env:ANTHROPIC_AUTH_TOKEN = "<gateway-token>"
claude --model z-ai/glm-5.2
```

Bash/Zsh:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:12000"
export ANTHROPIC_AUTH_TOKEN="<gateway-token>"
claude --model meta/llama-3.3-70b-instruct
```

> **How it works:** Anthropic clients targeting `http://127.0.0.1:12000` (or `http://127.0.0.1:12000/v1`) send standard Anthropic Messages payloads. NV-Gateway translates the requests on the fly, executes them against your NVIDIA NIM key pool with **zero rate limits failover**, and translates the streaming responses back to Anthropic SSE events. You can target any model in the catalog, including `deepseek-ai/deepseek-r1`, `qwen/qwen2.5-coder-32b-instruct`, and `nvidia/llama-3.1-nemotron-70b-instruct`.

---

### 2. OpenCode
In `%USERPROFILE%\.config\opencode\opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "nvidia-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NV-Gateway",
      "options": {
        "baseURL": "http://127.0.0.1:12000/v1",
        "apiKey": "<gateway-token>"
      },
      "models": {
        "z-ai/glm-5.2": {
          "name": "GLM-5.2"
        },
        "meta/llama-3.3-70b-instruct": {
          "name": "Llama 3.3 70B Instruct"
        }
      }
    }
  }
}
```

*Note: You can also use the automatic migration command: `NV-Gateway.exe --migrate-legacy-nvidia`.*

---

### 3. Cline / Roo Code (VS Code Extension)
1. Open Cline Settings (`Ctrl+,` -> search `Cline` or click gear icon).
2. Set **API Provider** to `OpenAI Compatible`.
3. Set **Base URL** to `http://127.0.0.1:12000/v1`.
4. Set **API Key** to the generated Gateway Token copied from the app's **Endpoint** screen.
5. Select or type your desired model ID, for example:
   - `z-ai/glm-5.2`
   - `meta/llama-3.3-70b-instruct`
   - `deepseek-ai/deepseek-r1`
   - `nvidia/nemotron-4-340b-instruct`

---

### 4. Cursor
1. Go to **Cursor Settings** -> **Models** -> **OpenAI API Key**.
2. Enable custom OpenAI API base URL: `http://127.0.0.1:12000/v1`.
3. Set the custom API key to the generated Gateway Token copied from the app's **Endpoint** screen.
4. Add model names matching NVIDIA NGC catalog identifiers.

---

### 5. Aider
Run Aider directly from your terminal:

PowerShell:

```powershell
$env:OPENAI_API_BASE = "http://127.0.0.1:12000/v1"
$env:OPENAI_API_KEY  = "<gateway-token>"
aider --model openai/z-ai/glm-5.2
```

Bash/Zsh:

```bash
export OPENAI_API_BASE="http://127.0.0.1:12000/v1"
export OPENAI_API_KEY="<gateway-token>"
aider --model openai/meta/llama-3.3-70b-instruct
```

---

### 6. Continue (VS Code / JetBrains)
In `%USERPROFILE%\.continue\config.yaml` (current Continue versions use YAML):

```yaml
name: NV-Gateway
version: 1.0.0
schema: v1
models:
  - name: NVIDIA GLM-5.2 (NV-Gateway)
    provider: openai
    model: z-ai/glm-5.2
    apiBase: http://127.0.0.1:12000/v1
    apiKey: <gateway-token>
  - name: Llama 3.3 70B (NV-Gateway)
    provider: openai
    model: meta/llama-3.3-70b-instruct
    apiBase: http://127.0.0.1:12000/v1
    apiKey: <gateway-token>
```

---

### 7. Windsurf / OpenClaw
Set Provider to `OpenAI` with:
- **Base URL**: `http://127.0.0.1:12000/v1`
- **API Key**: the generated Gateway Token copied from the app's **Endpoint** screen

---

## Troubleshooting

### Windows SmartScreen ("Unknown Publisher")
When running the installer, Windows may show a prompt stating "Windows protected your PC" or "Unknown Publisher". This warning appears because NV-Gateway is not signed with a commercial Extended Validation (EV) code-signing certificate. There is no certificate, and none will be purchased. The installer is safe and contains no malware. To proceed:
1. Click **More info** on the SmartScreen prompt.
2. Click **Run anyway**.

### Antivirus Alerts
Some antivirus scanners may flag the executable or block background components for the same reason (absence of a commercial code-signing certificate). If your antivirus software flags NV-Gateway:
1. Verify that you downloaded the file from the official [GitHub Releases](https://github.com/HaYkMnE/NV-Gateway/releases) page.
2. Add an exception or allow the application in your antivirus settings.

### Windows 11 System Tray Icon
On Windows 11, new system tray icons are placed in the hidden overflow flyout behind the upward arrow (`^`) near the taskbar clock. The application cannot move itself to the visible taskbar due to Windows restrictions.
1. Click the **`^`** arrow next to the clock in the Windows taskbar.
2. Locate the NV-Gateway icon.
3. Drag the icon out of the flyout and onto the visible taskbar.

---

## API Endpoints Reference

NV-Gateway binds two paired loopback ports (`P` and `P+1`, default `12000` and `12001`):

| Endpoint | Port | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `POST /v1/chat/completions` | `12000` | Gateway Bearer Token | OpenAI chat completions with streaming SSE & failover |
| `POST /v1/messages` | `12000` | Gateway Bearer Token | Anthropic Messages API translation facade (Claude Code CLI, Anthropic SDKs, Claude Desktop) |
| `GET /v1/models` | `12000` | Gateway Bearer Token | Enriched NGC catalog with limits & reasoning specs |
| `GET /health` | `12000` | Public | Process health and readiness probe (`200` when ready, `503` while starting) |
| `GET /admin/keys` | `12001` | Admin Token | Key status, error counts, and accessible models |
| `POST /admin/keys` | `12001` | Admin Token | Add a new NVIDIA API key with fire-and-forget probe |
| `DELETE /admin/keys/:id` | `12001` | Admin Token | Remove a managed key |
| `POST /admin/models/refresh`| `12001` | Admin Token | Trigger NGC model re-discovery |
| `GET /admin/logs` | `12001` | Admin Token | Fetch sanitized recent request events |

---

## Runtime Storage & Log Structure

All runtime state is stored in `%APPDATA%\NV-Gateway\`:

```
%APPDATA%\NV-Gateway\
├── config.json                            # Non-secret user settings (ports, language, UI theme)
├── keys.json                              # DPAPI-encrypted key state and local credentials
├── keys.json.encrypted.bak                # Encrypted recovery snapshot
├── legacy-nvidia-migration.lock/          # Cooperative atomic migration exclusion lock
└── logs\
    ├── app.jsonl                          # Main Electron lifecycle and update logs
    ├── gateway.jsonl                      # Upstream request metrics, status, duration
    ├── gateway-stdio.jsonl                # Child process stdio stream
    └── migration-phase.jsonl              # Allowlisted migration phase telemetry
```

*Log rotation*: Logs automatically rotate at **5 MiB**, retaining up to 3 archives (`*.1.jsonl` to `*.3.jsonl`).

---

## Verification & Testing

NV-Gateway maintains a strict zero-regression testing standard. The automated test suite covers runtime security, ACL protection, ASAR scans, key failover, and protocol translation, and must pass with zero failures:

```bash
# Run full suite
npm test
```

To build the unpacked app and run every packaged audit, set the public releases repository owner for your shell.

PowerShell:

```powershell
$env:NVGW_GH_OWNER = "HaYkMnE"
npm run package:dir
```

Bash/Zsh:

```bash
export NVGW_GH_OWNER="HaYkMnE"
npm run package:dir
```

---

## Support & Donations

If NV-Gateway empowers your workflow, support ongoing development:

### Cryptocurrency Wallets

| Network | Asset | Address |
| :--- | :--- | :--- |
| **Bitcoin** | `BTC` (Native SegWit) | `bc1qmle5479683zdggfd0d3qfzm08dcff3dd8zufw5` |
| **Ethereum / BSC** | `ETH` / `BNB` / `USDT` | `0xEf3Ab19B35d770293107c1e54d8a6d5f1c6d00bA` |
| **Solana** | `SOL` / `USDC` | `2r7bD3n3yoRPCPg1bjDaJ7nxcE7oMwJy5cRVu5XsrZgG` |
| **TRON** | `TRX` / `USDT` (TRC-20) | `TPoeenevUvRwcTfXmCFweGVSbH37hiZpmr` |
| **TON** | `TON` / `NOT` | `UQCirhEjqFkjA8CAQcypCkFOBSOUooNKBTVHgiBikDRUhBGZ` |

### Web & Creator Platforms
- **Patreon**: [patreon.com/c/HaYkMnE](https://www.patreon.com/c/HaYkMnE)
- **Ko-fi**: [ko-fi.com/haykmne](https://ko-fi.com/haykmne)
- **Tribute (Telegram)**: [t.me/tribute/app](https://t.me/tribute/app?startapp=ep_7qt3bDGDd36LHQg4oAifvcqXhzifEM9RF0TMtb54EZbJQOdZX0)

---

## Contributing

We welcome contributions! Please review [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) before submitting pull requests. All contributions must pass the full automated test suite with zero failures and adhere to strict credential-redaction policies.

---

## Security

For vulnerability disclosures and details on our credential redaction architecture, refer to [SECURITY.md](SECURITY.md).

---

## License

This project is licensed under the [MIT License](LICENSE) &copy; 2026 HaYkMnE.
