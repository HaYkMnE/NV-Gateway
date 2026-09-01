# Autonomous Loop Operations (Architecture Reference — Disabled)

> **Status: DISABLED**. The Jules autonomous loop is disabled and was never connected to production. This document describes the planned operational architecture only. Do not enable or attempt to wire it.

## Overview
The Jules autonomous loop (Phase 1) is designed to operate in a **report-only** mode when enabled.

## Kill Switch
The autonomous loop is disabled by default. To keep it disabled, ensure the repository variable `AUTONOMOUS_LOOP_ENABLED` is set to `false` (or left unset).

## Circuit Breaker
Halts operations if:
- 3 consecutive correction failures occur.
- A BLOCKED verdict is issued by the Bug Hunter.

## Telemetry
Data is collected from `%APPDATA%\NV-Gateway\logs` **strictly** via an opt-in mechanism and filtered through an allowlist.

