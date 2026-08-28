# Contributing to NV-Gateway

Thank you for your interest in contributing to **NV-Gateway**! This document outlines our development workflows, coding conventions, testing standards, and pull request guidelines.

---

## 1. Code Style & Architecture

Our repository relies on modern JavaScript and web technologies:

- **Runtime & Modules**: Node.js 20+ with native ESM (`"type": "module"`).
- **Desktop Framework**: Electron 31 with strict process isolation (`contextIsolation: true`, `nodeIntegration: false`, CSP headers).
- **Frontend Stack**: React 18, Vite 5, Tailwind CSS, Zustand, i18next.
- **Language**: TypeScript 5.5 (strictly typed without implicit `any`).
- **Code Standards**:
  - Keep modules focused, modular, and single-responsibility.
  - Follow standard naming conventions: `PascalCase` for React components and types, `camelCase` for functions and variables.
  - Prefer immutable data patterns and modern `async`/`await` control flow.
  - Maintain absolute separation of concerns between Electron Main (secrets/lifecycle), Gateway (proxy/failover), and Renderer (HUD/UI).

---

## 2. Local Development & Testing Workflow

Before submitting changes, verify that your code compiles with zero errors and passes the full automated test suite.

### Setup & Build
```bash
# 1. Install dependencies
npm install

# 2. Compile TypeScript and build renderer bundle
npm run build

# 3. Start development environment
npm run dev
```

### Running Tests
```bash
# Run full automated test suite (511+ tests)
npm test

# Run individual test files
node --test tests/failover-policy.test.mjs
node --test tests/capability-registry.test.mjs
```

### Static Security & Packaging Audits
```bash
# Run complete packaging audit suite
npm run package:audit

# Individual smoke checks
npm run test:packaged-security     # Validates CSP, ASAR boundaries, and isolation
npm run test:packaged-credentials  # Scans for hardcoded keys and credential literals
npm run test:packaged-migration    # Tests safe configuration migration
npm run test:packaged-gateway-link # Verifies ESM dependency graph
```

---

## 3. Pull Request Guidelines

To ensure repository stability, security, and cleanliness:

1. **Branch Naming**: Use descriptive prefixes:
   - `feat/add-new-capability-probe`
   - `fix/upstream-stream-timeout`
   - `docs/update-agent-guidelines`
   - `perf/lru-rotation-cache`
2. **Commit Messages**: Follow Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
3. **No Secret Leakage**:
   - Never commit API keys, tokens, environment variables, or private test credentials.
   - Run `node scripts/shipping-credential-scan.mjs` before committing.
4. **Verification Evidence**:
   - Include exact commit SHAs and command execution outputs in your PR description.
   - Confirm that all 511 tests pass with zero failures or skipped suites.

---

## 4. Jules Autonomous AI Development Pipeline

In addition to human contributions, this repository supports a 4-agent autonomous development lifecycle powered by Jules AI agents:

- **1. Log Analyst**: Continuously scans telemetry and the codebase to identify technical debt, bugs, and performance optimization opportunities, opening actionable GitHub Issues with JSON handoffs.
- **2. Developer Agent**: Automatically picks up analyst issues, writes regression tests, implements minimal surgical code changes, and submits PRs.
- **3. Bug Hunter**: Acts as the gatekeeper, performing thorough regression analysis, verifying the **Two Clean Passes Rule** (2 independent successful test runs on unchanged commit trees), and vetting against JSON schemas.
- **4. Design Art Virtuoso**: Audits renderer and style modifications against the Cyberpunk Level-1 Design System (`docs/DESIGN_SYSTEM.md`).
- **5. Autonomous Merge Orchestrator**: Automatically squash-merges passing, approved Jules PRs while strictly preserving human-authored branch protection.

### Evidence Gate & PR Review Criteria
Whether submitted by human developers or AI agents, all Pull Requests must satisfy:
1. **Zero Secret Leakage**: Passed `scripts/shipping-credential-scan.mjs`.
2. **100% Test Suite Green**: All 511+ automated unit and integration tests passing.
3. **Exact Commit SHA Evidence**: Clear trace of commit SHA and reproduction verification.
4. **Architectural Isolation**: Strict preservation of process boundaries between Electron Main, Gateway, and Renderer.

Thank you for helping build NV-Gateway!
