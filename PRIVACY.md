# NV Gateway privacy

This page lists every place NV Gateway connects to, what it sends, when, and how to turn it off. It describes version 1.0.0. NV Gateway is open source, so you can check every item against the code in this repository.

## Summary

- Your prompts go to NVIDIA only.
- Your NVIDIA keys go to NVIDIA only. They are never sent to the author.
- NV Gateway has no telemetry or analytics.
- Two services besides NVIDIA and GitHub can be contacted: `api.zeroeval.com` for model rankings (on by default, can be turned off) and the author's error-report service (only when you click **Send**).

## What stays on your PC

- The gateway listens on `127.0.0.1` only (API port 12000, admin port 12001 by default). Other machines on your network cannot reach it.
- Local apps need the gateway token to use the API.
- Your NVIDIA keys are stored encrypted with Windows DPAPI in `%APPDATA%\NV-Gateway\keys.json`. If Windows encryption is unavailable, the app refuses to save keys rather than store them in plain text.
- Logs are stored in `%APPDATA%\NV-Gateway\logs`. Keys and tokens are removed from logs before they are written.

## Where NV Gateway connects

### NVIDIA: `integrate.api.nvidia.com`

| What is sent | When | Turn it off |
|---|---|---|
| The prompts your tool sends, with one of your keys | Every request from your tool | Not possible. This is what the app is for |
| A model-list request, without a key | At gateway start, then every 24 h | Not possible |
| A model-list request, with one of your keys | When your tool calls `GET /v1/models` | Not possible |
| A fixed test prompt (`ok`), with one of your keys, to check model capabilities | In the background after the model list loads | Set the environment variable `GATEWAY_CAPABILITY_PROBE_DISABLE=1` |
| The key you are adding, to check that it works | Only when you add a key | Runs only when you add a key |

### NVIDIA: `api.ngc.nvidia.com`

| What is sent | When | Turn it off |
|---|---|---|
| A request for public catalogue data, without a key | At start, then when the 24 h cache expires | Not possible |

### GitHub: `HaYkMnE/NV-Gateway`

| What is sent | When | Turn it off |
|---|---|---|
| An update check | At start and every 6 h | The check is automatic. Nothing downloads or installs unless you accept the update |

### Model rankings: `api.zeroeval.com` (LLM Stats)

| What is sent | When | Turn it off |
|---|---|---|
| A plain request with no key and no model IDs. Matching happens on your PC. The service sees your IP address | When the Models, Endpoint or Settings view loads the model list, at most once per 24 h. **On by default** | Settings → **Model ranking (LLM Stats)**. While it is off, the app sends no request to `api.zeroeval.com`. The change applies without a restart |

### Error reports: `nv-gateway-reports.nvgw-sys.workers.dev` (Cloudflare)

| What is sent | When | Turn it off |
|---|---|---|
| The redacted error list and the app version. Your IP address is visible to the service | Only when you click **Send** in the error-report dialog | Don't click Send. Nothing is sent otherwise |

### Links you click

Links in the app (for example GitHub or the donation page) open in your browser only when you click them.

## Your responsibilities

You are responsible for using your keys in line with NVIDIA's terms. NVIDIA's own privacy policy applies to the requests NV Gateway sends to NVIDIA on your behalf.

## Contact

Questions about this page: [open an issue](https://github.com/HaYkMnE/NV-Gateway/issues).
