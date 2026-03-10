---
id: tests-verification
title: "Tests e verification"
intent: extension-rewrite
status: done
complexity: medium
mode: confirm
depends_on: [rewrite-discord-client, rewrite-cdp-bridge, rewrite-orchestrator]
created: "2026-03-10T03:45:00Z"
---

# Tests and Verification

## Objective

Unit tests for DiscordClient routing, CdpBridge operations, noise filtering. Integration tests with mock Discord + mock CDP.

## Acceptance Criteria

- [ ] `npm test` passes
- [ ] Coverage >70% on new modules
- [ ] No regressions in existing utils tests
