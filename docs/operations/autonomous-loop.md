# Autonomous Loop Operations

## Overview
The Jules autonomous loop (Phase 1) is designed to operate in a **report-only** mode.

## Kill Switch
To disable the autonomous loop, set the repository variable AUTONOMOUS_LOOP_ENABLED to alse.

## Circuit Breaker
Halts operations if:
- 3 consecutive correction failures occur.
- A BLOCKED verdict is issued by the Bug Hunter.

## Telemetry
Data is collected from %APPDATA%\NV-Gateway\logs **strictly** via an opt-in mechanism and filtered through an allowlist.

