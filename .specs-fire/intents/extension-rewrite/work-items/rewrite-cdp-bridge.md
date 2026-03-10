---
id: rewrite-cdp-bridge
title: "Riscrivere CdpBridge"
intent: extension-rewrite
status: done
complexity: medium
mode: confirm
depends_on: []
created: "2026-03-10T03:45:00Z"
---

# Rewrite CdpBridge

## Objective

Clean rewrite of `cdp-bridge.ts`. Separate connection from editor discovery. Make CDP operations atomic and testable.

## Acceptance Criteria

- [ ] Clean connect/disconnect lifecycle
- [ ] sendMessage and waitForResponse are deterministic
- [ ] Fallback chains removed or simplified
- [ ] Response extraction without noise leak
