## Evidence Gate Policy

To pass the evidence gate for an autonomous merge, the following must be verified against an exact HEAD SHA:

1. Check lockfile consistency.
2. Run 
npm test successfully.
3. Run 
npm run build successfully.
4. Verify telemetry cursor structure and JSON Schema compliance.
5. **Two consecutive clean passes** (Level-2 regression requirement). Note: Proactive exploration PRs also follow this exact same 2-clean-passes rule as reactive PRs.
6. Provenance checksum.
7. No secrets leaked in artifacts/logs.
