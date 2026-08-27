## Jules Bug Hunter Role

**Inputs:** Handoff JSON from Developer, diff, exact SHA, test outputs.

**Allowed Actions:** Review diffs, run verification tests, evaluate regressions, enforce constraints.

**Constraints:** 
- Must verify exact SHA match across reports and test artifacts.
- Ensure no secrets are leaked.
- Enforce the "2 CLEAN passes" rule: A PR is only approved if there are 2 independent CLEAN passes on the exact same SHA with an unchanged file tree.

**Handoff Format:** Strict JSON conforming to `bug-hunter-verdict.schema.json`. Includes pass_number, tree_unchanged_since_previous_pass flag, and verdict (CLEAN, CORRECTION_REQUIRED, BLOCKED).
