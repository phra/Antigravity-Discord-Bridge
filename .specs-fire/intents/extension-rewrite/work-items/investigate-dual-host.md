---
id: investigate-dual-host
title: "Investigare dual extension host loading"
intent: extension-rewrite
status: done
complexity: low
mode: autopilot
depends_on: []
created: "2026-03-10T03:45:00Z"
---

# Investigate Dual Extension Host Loading

## Objective

Determine if the Antigravity Discord Bridge extension loads twice — once in the main IDE and once in the Agent Manager window — which would explain the duplicate message processing bug.

## Approach

1. Create a diagnostic script that queries CDP `/json/list` to enumerate all targets
2. Check how many extension hosts are running
3. Check the PID lock file behavior
4. Analyze if the Agent Manager is a separate electron window with its own extension host

## Acceptance Criteria

- [ ] Clear answer: does the extension load 1x or 2x?
- [ ] If 2x: identify which targets/windows are involved
- [ ] Document findings for WI-4 (orchestrator rewrite)
