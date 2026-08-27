## Description

Please provide a clear summary of the changes introduced by this PR and the motivation behind them.

---

## Type of Change

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Documentation update
- [ ] Refactoring / Code quality improvement

---

## Verification Checklist

- [ ] **Build Verification**: Ran `npm run build` with zero errors.
- [ ] **Test Suite Verification**: Ran `node --test tests/*.test.mjs` with all tests passing.
- [ ] **No Secret Leakage**: Checked code, logs, and commit details to ensure no API keys, credentials, or secrets are exposed.
- [ ] **Exact SHA Evidence**: Included the exact commit SHA and build/test outputs as evidence below.
- [ ] **Jules AI Code Review Gate**: Ready for Jules AI Bug Hunter review (2 clean passes required).

---

## Evidence & Verification Log

```bash
# Paste execution log for verification command:
$ npm run build && node --test tests/*.test.mjs
```

**Commit SHA**: `<exact-commit-sha>`
