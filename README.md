# Antigravity Discord Bridge

> **Bridge your VS Code AI chat with a Discord channel.** Messages from Discord are auto-processed by the Language Model in your IDE, and responses are sent back — all in real-time.

## Features

- 🤖 **Auto-processing** — Discord messages are automatically sent to the IDE Language Model (Gemini, Copilot, etc.) and responses are posted back
- 🔧 **CDP Bridge** — Uses Chrome DevTools Protocol to interact with the Antigravity chat editor, injecting messages and extracting responses via DOM diffing
- ✅ **Auto-Accept** — Automatically clicks Accept / Run / Always Allow buttons during processing, with `scrollIntoView` for off-screen buttons
- ⚙️ **Settings GUI** — Tabbed sidebar panel with built-in settings form (Bot Token, Channel ID, Debug Port, Auto-Accept toggle)
- 📡 **Live Status** — Green/red connection indicators for Discord and CDP right in the sidebar
- ✂️ **Smart message splitting** — Automatically splits long responses to respect Discord's 2000-character limit
- 🎨 **VS Code theming** — Chat and settings panels follow your IDE theme

## Installation

### From VS Code Marketplace (coming soon)

Search for **"Antigravity Discord Bridge"** in the Extensions panel (`Ctrl+Shift+X`).

### From .vsix (Releases)

1. Download the latest `.vsix` from [Releases](https://github.com/phra/Antigravity-Discord-Bridge/releases)
2. In VS Code: `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → select the file

### From source

```bash
git clone https://github.com/phra/Antigravity-Discord-Bridge.git
cd Antigravity-Discord-Bridge
npm install
npm run compile
npm run package
```

Then install the generated `.vsix` file as described above.

## Quick Start

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name → **Create**
3. Go to **Bot** tab → click **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2** → **URL Generator**:
   - Select scopes: `bot`
   - Select permissions: `Send Messages`, `Read Message History`, `Create Public Threads`, `Send Messages in Threads`
   - Copy the generated URL and open it to invite the bot to your server
6. Right-click the target channel in Discord → **Copy Channel ID** (enable Developer Mode in Discord settings if needed)

### 2. Start Antigravity with Debugging

Launch Antigravity with the remote debugging port enabled:

```bash
antigravity --remote-debugging-port=9000
```

### 3. Configure the Extension

Open the **Discord** sidebar panel (click the Discord icon in the activity bar) and switch to the **⚙️ Settings** tab:

| Setting | Description | Default |
|---------|-------------|---------|
| **Bot Token** | Your Discord bot token | — |
| **Channel ID** | Target Discord channel ID | — |
| **Debug Port** | Antigravity `--remote-debugging-port` value | `9000` |
| **Auto-Accept** | Auto-click Accept/Run/Always Allow buttons | `true` |

Alternatively configure via VS Code Settings (`Ctrl+,`) → search `antigravity-discord`.

The bot connects automatically. You should see **"Antigravity Discord Bridge: Connected!"** and green status dots for Discord and CDP.

### 4. Use It

**From Discord:**
Just type in the configured channel. The bot processes your message with the AI agent and replies automatically.

**Sidebar panel:**
Click the Discord icon in the activity bar to see the conversation and manage settings.

## How It Works

```
Discord User → message → Discord Channel
                              ↓
                    VS Code Extension (discord.js)
                              ↓
                    CDP Bridge (Chrome DevTools Protocol)
                              ↓
                    Antigravity Chat Editor (DOM injection)
                              ↓
                    AI Agent processes message
                              ↓
                    CDP extracts response (snapshot diffing)
                              ↓
                    Response → Discord Channel + Sidebar Panel
```

The extension connects to Antigravity's debugging interface via CDP, finds the chat editor in the DOM, injects messages programmatically, and extracts AI responses by diffing page snapshots before and after processing.

**Auto-Accept** runs a CDP-injected interval during processing that finds and clicks confirmation buttons (Accept, Run, Always Allow), scrolling them into view if needed. It activates only during Discord message processing and stops automatically when done.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `antigravity-discord.botToken` | `string` | `""` | Discord Bot Token |
| `antigravity-discord.channelId` | `string` | `""` | Discord Channel ID to bridge |
| `antigravity-discord.debugPort` | `number` | `9000` | Antigravity remote debugging port |
| `antigravity-discord.autoAccept` | `boolean` | `true` | Auto-click Accept/Run/Always Allow during processing |

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Package as .vsix
npm run package
```

### Testing locally

1. Open this project in VS Code
2. Press `F5` to launch Extension Development Host
3. Start Antigravity with `--remote-debugging-port=9000`
4. Configure bot token and channel ID in the dev instance
5. Send a message in Discord → see it processed

## Requirements

- VS Code 1.93.0+
- Antigravity started with `--remote-debugging-port=9000`
- A Discord bot token ([create one here](https://discord.com/developers/applications))

## License

[MIT](LICENSE)
