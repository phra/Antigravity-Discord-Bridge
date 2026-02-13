# Antigravity Discord Bridge


> **Bridge your VS Code AI chat with a Discord channel.** Messages from Discord are auto-processed by the Language Model in your IDE, and responses are sent back — all in real-time.

## Features

- 🤖 **Auto-processing** — Discord messages are automatically sent to the IDE Language Model (Gemini, Copilot, etc.) and responses are posted back
- 💬 **@discord participant** — Send messages to Discord directly from the VS Code chat panel
- 📺 **Sidebar chat panel** — Real-time mini-chat view in VS Code showing the Discord conversation
- ✂️ **Smart message splitting** — Automatically splits long responses to respect Discord's 2000-character limit
- 🎨 **VS Code theming** — Chat panel follows your IDE theme

## Quick Start

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → give it a name → **Create**
3. Go to **Bot** tab → click **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2** → **URL Generator**:
   - Select scopes: `bot`
   - Select permissions: `Send Messages`, `Read Message History`
   - Copy the generated URL and open it to invite the bot to your server
6. Right-click the target channel in Discord → **Copy Channel ID** (enable Developer Mode in Discord settings if needed)

### 2. Configure the Extension

Open VS Code Settings (`Ctrl+,` / `Cmd+,`) and set:

| Setting | Value |
|---------|-------|
| `antigravity-discord.botToken` | Your bot token from step 1 |
| `antigravity-discord.channelId` | The channel ID from step 1 |

The bot connects automatically. You should see **"Antigravity Discord Bridge: Connected!"** in VS Code.

### 3. Use It

**From Discord:**
Just type in the configured channel. The bot processes your message and replies automatically.

**From VS Code:**
Type `@discord your message` in the chat panel. The response appears in both IDE and Discord.

**Sidebar panel:**
Click the 💬 icon in the activity bar to see the conversation in real-time.

## How It Works

```
Discord User → message → Discord Channel
                              ↓
                    VS Code Extension (discord.js)
                              ↓
                    Language Model API (vscode.lm)
                              ↓
                    Response → Discord Channel + Sidebar Panel
```

The extension uses whatever Language Model is available in your IDE (Gemini, Copilot, etc.) via the `vscode.lm` API. No additional API keys needed beyond your existing IDE setup.

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Package as .vsix
npx vsce package
```

### Testing locally

1. Open this project in VS Code
2. Press `F5` to launch Extension Development Host
3. Configure bot token and channel ID in the dev instance
4. Send a message in Discord → see it processed

## Requirements

- VS Code 1.93.0+
- A Language Model provider (Gemini Code Assist, GitHub Copilot, etc.)
- A Discord bot token ([create one here](https://discord.com/developers/applications))

## License

[MIT](LICENSE)
