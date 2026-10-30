# Developing NV Gateway

This page is for building and changing NV Gateway. For using the app, see the [README](README.md). Read [AGENTS.md](AGENTS.md) before you change runtime, security, packaging or localisation code.

## Build from source

You need Windows, Git and Node.js 22.12 or later (`engines.node` in [`package.json`](package.json) is `>=22.12.0`).

```powershell
git clone https://github.com/HaYkMnE/NV-Gateway.git
cd NV-Gateway
npm ci
npx install-electron --no

# Build the Electron app and gateway bundle
npm run build

# Run the test suite (npm test runs npm run build first)
npm test

# In terminal 1, start the Vite renderer
npm run dev

# In terminal 2, start Electron
npm start
```

To build the unpacked app and run every packaged audit, set the release owner for your shell first. The packaging guard stops if `NVGW_GH_OWNER` is missing.

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

With the same variable set, `npm run build:portable` creates `dist/NV-Gateway <version>.exe` and `npm run build:release` creates the installer `dist/NV-Gateway-Setup-<version>.exe`. `<version>` is the `version` field in [`package.json`](package.json).

Where things live: `src/main/` (Electron main process: key storage, tray, updates), `src/preload/` (the IPC bridge), `src/renderer/` (the React interface), `src/gateway/` (the local API), `scripts/` (build and release checks), `tests/` and `docs/` (the website, served by GitHub Pages).

## Example config: OpenCode

The app's **Endpoint** screen writes this block for you. The model id below is only an example config; use any id from `GET /v1/models`. In `%USERPROFILE%\.config\opencode\opencode.json`:

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
        }
      }
    }
  }
}
```

## Local API reference

NV Gateway binds two paired loopback ports (`P` and `P+1`, default `12000` and `12001`). The effective port is the one shown in the app: the port can be changed in Settings, and an existing install keeps the port it already saved. Codex CLI uses `POST /v1/responses` on the same port.

| Endpoint | Port | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| `POST /v1/chat/completions` | `12000` | Gateway Bearer Token | OpenAI chat completions with streaming and failover |
| `POST /v1/messages` | `12000` | Gateway Bearer Token | Anthropic Messages API (Claude Code, Anthropic SDKs) |
| `GET /v1/models` | `12000` | Gateway Bearer Token | NVIDIA catalogue with limits and reasoning details |
| `GET /v1/models/cached` | `12000` | Gateway Bearer Token | Cached model list without an upstream fetch |
| `POST /v1/models/refresh` | `12000` | Admin Token | Model re-discovery; the response excludes models you turned off |
| `GET /health` | `12000` | Public | Health probe (`200` when ready, `503` while starting) |
| `GET /admin/keys` | `12001` | Admin Token | Key status, error counts and accessible models |
| `POST /admin/keys` | `12001` | Admin Token | Add an NVIDIA API key |
| `DELETE /admin/keys/:id` | `12001` | Admin Token | Remove a key |
| `PATCH /admin/keys/:id` | `12001` | Admin Token | Update a key (for example, turn it back on) |
| `POST /admin/keys/reorder` | `12001` | Admin Token | Reorder the key list |
| `GET /admin/state` | `12001` | Admin Token | Gateway and key-pool state |
| `POST /admin/validate` | `12001` | Admin Token | Check a key with NVIDIA |
| `POST /admin/catalog/sync` | `12001` | Admin Token | Re-sync the NVIDIA catalogue |
| `POST /admin/models/refresh` | `12001` | Admin Token | Admin-port model re-discovery used by the app |
| `GET /admin/logs` | `12001` | Admin Token | Recent request events, with secrets removed |

## Contributing and security

Read [CONTRIBUTING.md](.github/CONTRIBUTING.md) before you open a pull request. Report vulnerabilities privately, as described in [SECURITY.md](.github/SECURITY.md).
