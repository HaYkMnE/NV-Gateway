## Circuit Breaker Policy

An autonomous loop will be **HALTED** if:

1. Limit of failed corrections reached (3 strikes).
2. Verdict is BLOCKED.
3. Checksums or exact SHA mismatches.
4. The AUTONOMOUS_LOOP_ENABLED is set to \false.
5. The payload size exceeds the limit.
