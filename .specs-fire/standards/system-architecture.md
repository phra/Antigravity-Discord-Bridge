# System Architecture

## Overview

Antigravity Discord Bridge is a VS Code extension that creates a real-time bridge between a Discord channel and the Antigravity AI chat editor. Discord users send messages to a bot; the extension injects those messages into the Antigravity chat UI via Chrome DevTools Protocol (CDP), waits for the AI response, and posts it back to Discord threads.

## System Context

The extension runs inside the VS Code extension host and communicates with two external systems: Discord (via gateway WebSocket) and Antigravity (via CDP WebSocket on localhost).

### Context Diagram

```
Discord Users ──► Discord API ──► Extension Host ──► CDP ──► Antigravity Chat UI
                                       │
                                   WebView Panel
                                  (status display)
```

### Users

- **Discord Users**: Send messages to the monitored Discord channel to interact with the AI
- **VS Code User**: Developer running the extension, can see status in the sidebar panel

### External Systems

- **Discord API**: Gateway WebSocket + REST API for messages, threads, presence
- **Antigravity AI Chat**: Local chat editor accessible via CDP on a configured debugging port

## Architecture Pattern

**Pattern**: Event-driven pipeline with message queue
**Rationale**: Discord messages arrive asynchronously; CDP interactions are sequential (one message at a time). A queue ensures ordering while the processing pipeline handles one message end-to-end.

## Component Architecture

### Components

#### Extension (extension.ts)

- **Purpose**: Entry point, orchestration, lifecycle management
- **Responsibilities**: Activate/deactivate, connect Discord and CDP, route messages, manage queue, handle errors
- **Dependencies**: DiscordClient, CdpBridge, ChatPanelProvider

#### DiscordClient (discord-client.ts)

- **Purpose**: Discord bot wrapper
- **Responsibilities**: Connect to gateway, listen for messages, send responses, manage threads, set presence
- **Dependencies**: discord.js

#### CdpBridge (cdp-bridge.ts)

- **Purpose**: CDP WebSocket bridge to Antigravity
- **Responsibilities**: Connect to debugging port, inject messages, extract responses, create/switch conversations, auto-accept dialogs, detect busy state
- **Dependencies**: ws (WebSocket)

#### ChatPanelProvider (chat-panel.ts)

- **Purpose**: Sidebar WebView panel
- **Responsibilities**: Display connection status, show message history, render typing indicators
- **Dependencies**: vscode.WebviewViewProvider

#### Utils (utils.ts)

- **Purpose**: Shared utilities
- **Responsibilities**: Noise line detection, MCP noise filtering
- **Dependencies**: None

### Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│  VS Code Extension Host                                 │
│                                                         │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────┐  │
│  │ Discord  │───►│  Extension    │───►│  CdpBridge   │──┼──► Antigravity
│  │ Client   │◄───│  (orchestr.)  │◄───│              │  │    (CDP port)
│  └──────────┘    └───────┬───────┘    └──────────────┘  │
│       │                  │                              │
│       │           ┌──────┴──────┐                       │
│       │           │ ChatPanel   │                       │
│       ▼           │ (WebView)   │                       │
│  Discord API      └─────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

Messages flow from Discord → Extension → CDP → Antigravity, then responses flow back CDP → Extension → Discord.

```
1. Discord user posts message
2. DiscordClient emits onMessage event
3. Extension deduplicates, queues if busy
4. Extension takes pre-snapshot of chat
5. CdpBridge injects message into Antigravity editor
6. CdpBridge polls for completion (isBusy → false)
7. CdpBridge extracts response (diff or markdown)
8. Extension filters noise, formats response
9. DiscordClient sends response to thread
10. Extension updates conversation map
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Extension Host | VS Code API | Lifecycle, configuration, UI |
| Discord | discord.js 14 | Bot client, threads, presence |
| CDP Bridge | ws (WebSocket) | Chrome DevTools Protocol communication |
| Build | esbuild | Fast bundling to single JS file |
| Testing | Vitest | Unit tests |
| Language | TypeScript 5.5 | Type safety, strict mode |

## Non-Functional Requirements

### Performance

- **Message latency**: <500ms from Discord receipt to CDP injection
- **Response time**: Dependent on AI model; extension adds <1s overhead

### Security

- Bot token stored in VS Code settings (not in source)
- Singleton lock prevents duplicate bot connections
- No credentials logged to output channel

### Scalability

Single-user, single-instance architecture. Message queue (max 5) handles burst traffic. Not designed for multi-user concurrent access.

## Constraints

- CDP requires Antigravity to be launched with `--remote-debugging-port`
- One message processed at a time (sequential CDP interaction)
- Discord messages limited to 2000 characters per chunk
- Extension must run in the same VS Code instance as Antigravity

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| CDP over API | Chrome DevTools Protocol | Antigravity exposes no public API; CDP allows UI automation |
| Thread per conversation | Discord threads | Maps 1:1 to Antigravity conversations, keeps channel clean |
| Sequential processing | Message queue | CDP can only handle one interaction at a time |
| PID lock file | File-based singleton | Prevents duplicate Discord connections across extension hosts |

---
*Generated by specs.md - fabriqa.ai FIRE Flow*
