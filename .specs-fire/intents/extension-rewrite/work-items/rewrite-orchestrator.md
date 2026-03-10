---
id: rewrite-orchestrator
title: "Riscrivere Extension orchestrator"
intent: extension-rewrite
status: done
complexity: high
mode: validate
depends_on: [rewrite-discord-client, rewrite-cdp-bridge]
created: "2026-03-10T03:45:00Z"
---

# Rewrite Extension Orchestrator

## Objective

Clean state machine for message lifecycle. Robust single-instance enforcement. Queue management. Error recovery. No global mutable variables.

## Acceptance Criteria

- [ ] One message → one response, no race conditions
- [ ] Robust single-instance (beyond PID lock file)
- [ ] Error recovery from CDP disconnects
- [ ] Clean state transitions
