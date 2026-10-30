# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

## [1.0.0] - 2026-10-30

### Added

- First release of the clean open-source repository, github.com/HaYkMnE/NV-Gateway. It includes everything from the 0.x line.
- The app checks this repository for updates.
- Every release is built by GitHub Actions from this repository's source.

### Upgrading from 0.x

0.x installs check an old address and will not update automatically. Reinstall once with the one-line command from the install guide (INSTALL.md). Your settings and keys are kept.

## [0.2.0] - 2026-10-29

### Added

- NV Gateway is open source under the Apache License 2.0. The repository includes LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt, and the installer ships all three next to NV-Gateway.exe.
- You can read the full source, check that your keys stay on your PC, and build the app yourself (see Build from source in the README).
- The README, install guide, privacy page and website now live in this repository; the website is served from its docs folder.

### Changed

- Releases are built by GitHub Actions from this repository's public source, starting with this version. Older releases predate the public repository.
- Releases are now published in this repository, github.com/HaYkMnE/NV-Gateway. The app checks this repository for updates, and older installs keep updating automatically.
- The About link, "Open GitHub issue" and in-app feedback now open this public repository.
- The Z.ai and StepFun provider logos are replaced by text monograms ("Z", "SF").
- Every release carries one SHA256SUMS.txt that covers every file in the release.

## [0.1.4] - 2026-10-26

### Changed

- Electron 31 → 44.9.3 (supported release, Chromium/Node 24 security fixes), electron-builder 26.18.0, electron-updater 6.8.11.
- At small window heights (below 687 px), the sidebar keeps the menu and the gateway status always visible; the pet shrinks (robot 130×120) and the hint line hides.

### Fixed

- The silent per-user install (`/S /currentuser`) could crash in the installer (NSIS System.dll, electron-builder #10296), and a `/D=` path with spaces was cut at the space. Both are fixed by electron-builder 26 (verified 0 crashes in 40 sandboxed installs).

### Security

- js-yaml 4.3.2 (shipped with the updater; a CPU DoS fix); cookie encryption fuse turned on.

## [0.1.3] - 2026-10-26

### Added

- The pet stays alive while the window is focused: it changes activity every 18-30 s and makes small movements every 4-7 s. It rests only when the window has been unfocused for 60 s (deep rest after 180 s) and pauses fully when the window is hidden.
- A rotating caption under the pet shows what it is doing (40 captions in 7 languages). A quiet "click to support the gateway" line replaces the fixed "feed the pet" text.
- Clicking the pet shows a short joy reaction before the donation window opens, and the pet keeps moving behind the window.
- The pet gives random tips about real settings and features: 18 tips, recommendations about twice as often as settings, one every 4-6 minutes, never right after you type or click, at most 8 per session, with "don't show again". The tips switch in Settings turns them off.

### Changed

- Tip cards and thought bubbles now open to the right of the sidebar and stay inside the window, so they no longer cover the menu or the status block.
- Ambient sounds play every 60-90 s at the same volume as the pet's other sounds.
- The pet stops when the main window is hidden or minimized; it checks the app window, not only the page.

### Fixed

- A tip hidden before you could read it no longer counts toward the session limit; it is offered again later after its conditions are re-checked.

## [0.1.2] - 2026-10-25

### Added

- Kimi K3 is shown as accepting images.
- DeepSeek V4.1 Flash is in the model list, with a 1,048,576-token context and maximum output limit of 1,048,576 tokens. It is shown as accepting images; unverified string reasoning controls are not fabricated.
- Log lines for finished requests now include time to first byte, total time, and token count, so slow models are easier to diagnose.
- MiniMax M3.1 Flash: real limits (262,144 context, 65,536 output), image input, and reasoning effort low/medium/high/xhigh/max; a capability probe can narrow a curated mode list but never add modes to it (for example `none`, which upstream accepts without turning reasoning off).

### Changed

- The OpenCode snippet now includes model limits and reasoning variants when the app knows them, so a copied config does not silently lose them.
- The error-report dialog uses plural forms for its counts in all 7 languages.
- A renderer crash shows an error screen instead of a blank window, and several low-contrast labels were darkened to meet the accessibility contrast ratio.
- The release workflow requires an explicit tag and refuses to republish an existing version; the packaged app enforces the ASAR integrity fuses; the uninstaller removes the autostart entry.
- The README and AGENTS.md now say that the paired ports are `12000` and `12001` by default, and that the effective port is the one shown in the app, because the port can be changed and an existing install keeps its saved value.
- Kimi K3 was retired by NVIDIA on 2026-10-15 (upstream returns 410 Gone); the gateway keeps its profile, but the model is no longer served.

### Fixed

- A malformed URL or a request body that is not a JSON object now gets a `400` instead of taking the gateway process down.
- Requests without a JSON content type are parsed like any other, so the disabled-model check and the reasoning defaults always apply.
- Streamed chat, Anthropic and Responses requests now record token usage: the gateway asks the upstream for it (`include_usage`), and a client that explicitly sets `include_usage: false` is respected. When nothing is reported the count stays unknown rather than `0`.
- The gateway restarts automatically after an unexpected exit: at most 3 attempts with exponential backoff from 1 s to 30 s, a counter that resets after 60 s of stable uptime, and never after an operator stop.
- The Responses adapter rejects duplicate tool names with a `400`. Upstream error text echoed to a client is bounded and scrubbed on every route, including the non-2xx passthrough: every JSON leaf and key is checked and credential-named fields of any type are redacted. On the chat passthrough an OpenAI error envelope of up to 4 KiB keeps its `type` and `code`, and a larger body is bounded and flattened to a plain string message; on `/v1/responses` a clean OpenAI-shaped error passes through as is, and any other error is rebuilt as a standard OpenAI error object.
- A failed gateway shutdown now aborts the update install instead of continuing (`auto-update.ts`, `abortInstall`).
- The model catalog cache is kept when the upstream returns an empty list, so an empty answer no longer replaces a good cache.
- The reasoning controls advertised in `/v1/models` now match what the chat and Anthropic routes send: both use one resolver, and a probe can add reasoning knowledge but cannot switch off a model the registry knows reasons.
- Kimi K3 advertises "high" as its default reasoning effort, the same value the gateway sends when your app sets none.
- An app update keeps the "Launch at sign-in" entry; the installer removes it only on a real uninstall.
- CI checks that the build output and the packaged ASAR are fresh (`verify:build-freshness`, `verify:asar`), so a stale bundle cannot ship.
- GLM-5.3 no longer thinks for minutes on every request. When your app sends no reasoning effort, the gateway uses "high" instead of the model's slow "max" default, and turns on clear_thinking. Anything your app sets itself is kept. This also applies to Codex CLI and Claude Code.
- Kimi K3 now defaults to "high" reasoning effort for the same reason. Efforts your app sends are mapped to the three values the model accepts: low, high and max. This includes apps that use the Anthropic API, such as Claude Code and OpenCode.

## [0.1.1] - 2026-10-01

### Added

- The Endpoint screen has a "Works with any app" block: OpenAI and Anthropic base URLs, your API key, and the model ID, each with a copy button.
- Ready-made setup for 17 apps, including OpenCode, Claude Code, Codex CLI, Continue, Zed, Aider, Cline, GitHub Copilot, and Open WebUI. Cursor needs a paid plan and a public tunnel, because it can't reach this computer's localhost.
- Codex CLI now works with the gateway, including tool calls and file edits.
- The app checks for updates every 6 hours and shows what's new.

### Changed

- Model tags are grouped into 15 clear tags and collapsed by default.
- The pet uses much less CPU and GPU when idle. It rests after a few seconds and wakes up when you hover over it. The robot is also a bit smaller.
- The pet follows the Windows "reduce animations" setting but still blinks.
- Settings no longer has the "Reset to Defaults" button, which didn't reset anything.

### Fixed

- Clicking the pet opens the donation window again.
- Claude Code and other apps that add extra parts to the URL now connect.
- The OpenCode setup snippet now has the right format.
- Saving settings no longer erases your per-model settings.
- The model list in Settings loads without clicking Refresh.
- Ports reserved by Windows are no longer shown as free.
- Very large responses from the gateway no longer freeze the app.

## [0.1.0] - 2026-08-29

The first public release.
