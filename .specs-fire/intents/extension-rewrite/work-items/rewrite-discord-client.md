---
id: rewrite-discord-client
title: "Riscrivere DiscordClient"
intent: extension-rewrite
status: done
complexity: medium
mode: confirm
depends_on: []
created: "2026-03-10T03:45:00Z"
---

# Rewrite DiscordClient

## Objective

Clean rewrite of `discord-client.ts` with a single, robust message routing gate. Remove all incremental dedup patches.

## Acceptance Criteria

- [ ] Single `MessageCreate` listener
- [ ] No `seenMessageIds`, no `claimMessage`, no reaction-based claim
- [ ] Thread-starter detection robust and clear
- [ ] Zero duplicate processing
