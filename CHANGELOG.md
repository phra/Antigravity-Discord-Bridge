# Changelog

## [0.1.0] — 2026-02-26

### Added

- 🤖 Discord ↔ AI agent bridge via Chrome DevTools Protocol (CDP)
- ✅ Auto-accept: automatically clicks Accept / Run / Always Allow buttons (always-on when CDP is connected)
- 📋 Message queue: concurrent Discord messages are queued (up to 5) instead of rejected
- 🎨 Rich markdown formatting on Discord: code blocks with syntax highlighting, bold, italic, inline code, lists, blockquotes
- ⚙️ Settings GUI in the sidebar panel with tabbed interface (Chat / Settings)
- 📡 Live connection status indicators (Discord + CDP + Auto-Accept) with green/red dots
- 🧵 Reasoning threads on Discord for each processed message
- ✂️ Smart message splitting for Discord's 2000-character limit
- 🎨 VS Code theme integration for chat and settings panels
- 🔄 Reconnect command and button
- 🔇 Noise filtering: strips Antigravity UI chrome and auto-accept scan logs from responses
- 🔁 First-message retry: automatically retries if the agent doesn't start processing
- Auto-save settings with debounce
