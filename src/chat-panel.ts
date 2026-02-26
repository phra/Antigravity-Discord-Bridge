import * as vscode from "vscode";

interface ChatMessage {
    role: "user" | "assistant" | "system";
    author: string;
    content: string;
    timestamp: string;
}

interface SettingsData {
    botToken: string;
    channelId: string;
    debugPort: number;
    autoAccept: boolean;
}

interface StatusData {
    discord: boolean;
    cdp: boolean;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "antigravity-discord.chatView";

    private view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];
    private statusCallback?: () => StatusData;

    constructor(private readonly extensionUri: vscode.Uri) { }

    /**
     * Register a callback that returns current connection status.
     */
    onStatusRequest(callback: () => StatusData): void {
        this.statusCallback = callback;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        webviewView.webview.html = this.getHtml();

        // Replay existing messages
        for (const msg of this.messages) {
            webviewView.webview.postMessage({ type: "message", data: msg });
        }

        // Handle messages FROM the webview
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case "getSettings": {
                    const config = vscode.workspace.getConfiguration("antigravity-discord");
                    const settings: SettingsData = {
                        botToken: config.get<string>("botToken", ""),
                        channelId: config.get<string>("channelId", ""),
                        debugPort: config.get<number>("debugPort", 9000),
                        autoAccept: config.get<boolean>("autoAccept", true),
                    };
                    webviewView.webview.postMessage({ type: "settings", data: settings });
                    break;
                }
                case "saveSetting": {
                    const { key, value } = message.data as { key: string; value: unknown };
                    const config = vscode.workspace.getConfiguration("antigravity-discord");
                    await config.update(key, value, vscode.ConfigurationTarget.Global);
                    break;
                }
                case "getStatus": {
                    const status = this.statusCallback?.() || { discord: false, cdp: false };
                    webviewView.webview.postMessage({ type: "status", data: status });
                    break;
                }
                case "reconnect": {
                    vscode.commands.executeCommand("antigravity-discord.reconnect");
                    break;
                }
            }
        });

        // Send initial status
        if (this.statusCallback) {
            const status = this.statusCallback();
            webviewView.webview.postMessage({ type: "status", data: status });
        }
    }

    /**
     * Add a message to the chat panel.
     */
    addMessage(
        role: "user" | "assistant" | "system",
        author: string,
        content: string
    ): void {
        const msg: ChatMessage = {
            role,
            author,
            content,
            timestamp: new Date().toLocaleTimeString(),
        };
        this.messages.push(msg);

        if (this.view) {
            this.view.webview.postMessage({ type: "message", data: msg });
            this.view.show?.(true);
        }
    }

    /**
     * Show a typing indicator.
     */
    setTyping(author: string, typing: boolean): void {
        if (this.view) {
            this.view.webview.postMessage({
                type: "typing",
                data: { author, typing },
            });
        }
    }

    /**
     * Push updated connection status to the webview.
     */
    updateStatus(status: StatusData): void {
        if (this.view) {
            this.view.webview.postMessage({ type: "status", data: status });
        }
    }

    private getHtml(): string {
        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
    }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }

    /* ── Status bar ── */
    #status-bar {
        display: flex;
        gap: 10px;
        padding: 6px 10px;
        background: var(--vscode-sideBarSectionHeader-background);
        border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
        font-size: 0.8em;
        align-items: center;
    }
    .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        display: inline-block;
        margin-right: 4px;
    }
    .status-dot.on { background: #3fb950; }
    .status-dot.off { background: #f85149; }
    .status-item {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    /* ── Tabs ── */
    #tabs {
        display: flex;
        border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-sideBarSectionHeader-border, #333));
    }
    .tab {
        flex: 1;
        padding: 8px 12px;
        text-align: center;
        cursor: pointer;
        font-size: 0.85em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        border-bottom: 2px solid transparent;
        transition: all 0.15s;
        background: none;
        border-top: none;
        border-left: none;
        border-right: none;
    }
    .tab:hover {
        color: var(--vscode-foreground);
        background: var(--vscode-list-hoverBackground);
    }
    .tab.active {
        color: var(--vscode-foreground);
        border-bottom-color: var(--vscode-focusBorder);
    }

    /* ── Panels ── */
    .panel {
        display: none;
        flex: 1;
        overflow-y: auto;
    }
    .panel.active {
        display: flex;
        flex-direction: column;
    }

    /* ── Chat panel ── */
    #chat {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .msg {
        max-width: 90%;
        padding: 8px 12px;
        border-radius: 12px;
        word-wrap: break-word;
        line-height: 1.4;
    }
    .msg.user {
        align-self: flex-start;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-bottom-left-radius: 4px;
    }
    .msg.assistant {
        align-self: flex-end;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-bottom-right-radius: 4px;
    }
    .msg.system {
        align-self: center;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        font-size: 0.9em;
    }
    .msg .author {
        font-weight: bold;
        font-size: 0.85em;
        margin-bottom: 2px;
        opacity: 0.8;
    }
    .msg .time {
        font-size: 0.75em;
        opacity: 0.5;
        margin-top: 4px;
    }
    .msg pre {
        background: rgba(0,0,0,0.2);
        padding: 6px 8px;
        border-radius: 6px;
        overflow-x: auto;
        margin: 4px 0;
        font-size: 0.9em;
    }
    .msg code {
        background: rgba(0,0,0,0.15);
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 0.9em;
    }
    .msg pre code {
        background: transparent;
        padding: 0;
    }
    #typing {
        padding: 4px 12px;
        font-style: italic;
        color: var(--vscode-descriptionForeground);
        font-size: 0.85em;
        min-height: 20px;
    }
    #empty {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--vscode-descriptionForeground);
        font-style: italic;
    }

    /* ── Settings panel ── */
    #settings-panel {
        padding: 12px;
        gap: 16px;
    }
    .setting-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }
    .setting-group label {
        font-weight: 600;
        font-size: 0.85em;
        color: var(--vscode-foreground);
    }
    .setting-group .description {
        font-size: 0.8em;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 4px;
    }
    .setting-group input[type="text"],
    .setting-group input[type="number"],
    .setting-group input[type="password"] {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--vscode-input-border, #444);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border-radius: 4px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        outline: none;
    }
    .setting-group input:focus {
        border-color: var(--vscode-focusBorder);
    }
    .toggle-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 0;
    }
    .toggle-row .toggle-info {
        flex: 1;
    }
    /* Toggle switch */
    .toggle-switch {
        position: relative;
        width: 36px;
        height: 20px;
        flex-shrink: 0;
    }
    .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
    }
    .toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background: var(--vscode-input-border, #555);
        border-radius: 20px;
        transition: 0.2s;
    }
    .toggle-slider:before {
        content: "";
        position: absolute;
        height: 14px;
        width: 14px;
        left: 3px;
        bottom: 3px;
        background: var(--vscode-foreground);
        border-radius: 50%;
        transition: 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider {
        background: var(--vscode-button-background);
    }
    .toggle-switch input:checked + .toggle-slider:before {
        transform: translateX(16px);
    }

    .btn {
        padding: 6px 14px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        font-weight: 600;
        transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .btn-row {
        display: flex;
        gap: 8px;
        margin-top: 4px;
    }
    .saved-indicator {
        font-size: 0.8em;
        color: #3fb950;
        opacity: 0;
        transition: opacity 0.3s;
        margin-left: 8px;
    }
    .saved-indicator.show {
        opacity: 1;
    }
</style>
</head>
<body>
    <!-- Status bar -->
    <div id="status-bar">
        <div class="status-item">
            <span class="status-dot off" id="discord-dot"></span>
            <span>Discord</span>
        </div>
        <div class="status-item">
            <span class="status-dot off" id="cdp-dot"></span>
            <span>CDP</span>
        </div>
    </div>

    <!-- Tabs -->
    <div id="tabs">
        <button class="tab active" data-tab="chat-panel">💬 Chat</button>
        <button class="tab" data-tab="settings-panel">⚙️ Settings</button>
    </div>

    <!-- Chat panel -->
    <div id="chat-panel" class="panel active">
        <div id="chat">
            <div id="empty">In attesa di messaggi Discord...</div>
        </div>
        <div id="typing"></div>
    </div>

    <!-- Settings panel -->
    <div id="settings-panel" class="panel">
        <div class="setting-group">
            <label for="s-token">Bot Token</label>
            <div class="description">Discord bot token</div>
            <input type="password" id="s-token" placeholder="paste token here..." />
        </div>

        <div class="setting-group">
            <label for="s-channel">Channel ID</label>
            <div class="description">Discord channel to bridge</div>
            <input type="text" id="s-channel" placeholder="e.g. 123456789012345678" />
        </div>

        <div class="setting-group">
            <label for="s-port">Debug Port</label>
            <div class="description">Antigravity --remote-debugging-port</div>
            <input type="number" id="s-port" min="1" max="65535" />
        </div>

        <div class="setting-group">
            <div class="toggle-row">
                <div class="toggle-info">
                    <label>Auto-Accept</label>
                    <div class="description">Auto-click Accept / Run / Always Allow</div>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="s-autoaccept" />
                    <span class="toggle-slider"></span>
                </label>
            </div>
        </div>

        <div class="btn-row">
            <button class="btn btn-primary" id="btn-reconnect">🔄 Reconnect</button>
            <span class="saved-indicator" id="saved-msg">✓ Saved</span>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const typing = document.getElementById('typing');
        const empty = document.getElementById('empty');
        let hasMessages = false;

        // ── Tab switching ──
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab).classList.add('active');

                // Load settings when switching to settings tab
                if (tab.dataset.tab === 'settings-panel') {
                    vscode.postMessage({ type: 'getSettings' });
                    vscode.postMessage({ type: 'getStatus' });
                }
            });
        });

        // ── Settings fields ──
        const tokenInput = document.getElementById('s-token');
        const channelInput = document.getElementById('s-channel');
        const portInput = document.getElementById('s-port');
        const autoAcceptInput = document.getElementById('s-autoaccept');
        const savedMsg = document.getElementById('saved-msg');

        function flashSaved() {
            savedMsg.classList.add('show');
            setTimeout(() => savedMsg.classList.remove('show'), 1500);
        }

        function saveSetting(key, value) {
            vscode.postMessage({ type: 'saveSetting', data: { key, value } });
            flashSaved();
        }

        // Auto-save on change (with debounce for text inputs)
        let saveTimers = {};
        function debounceSave(key, value, delay = 800) {
            clearTimeout(saveTimers[key]);
            saveTimers[key] = setTimeout(() => saveSetting(key, value), delay);
        }

        tokenInput.addEventListener('input', () => debounceSave('botToken', tokenInput.value));
        channelInput.addEventListener('input', () => debounceSave('channelId', channelInput.value));
        portInput.addEventListener('input', () => debounceSave('debugPort', parseInt(portInput.value) || 9000));
        autoAcceptInput.addEventListener('change', () => saveSetting('autoAccept', autoAcceptInput.checked));

        // Reconnect button
        document.getElementById('btn-reconnect').addEventListener('click', () => {
            vscode.postMessage({ type: 'reconnect' });
        });

        // ── Chat helpers ──
        function escapeHtml(s) {
            const div = document.createElement('div');
            div.textContent = s;
            return div.innerHTML;
        }

        function formatContent(text) {
            let html = escapeHtml(text);
            html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
            html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
            html = html.replace(/\\n/g, '<br>');
            return html;
        }

        // ── Message handler ──
        window.addEventListener('message', event => {
            const { type, data } = event.data;

            if (type === 'message') {
                if (!hasMessages) {
                    empty.remove();
                    hasMessages = true;
                }

                const div = document.createElement('div');
                div.className = 'msg ' + data.role;

                let inner = '';
                if (data.role !== 'system') {
                    inner += '<div class="author">' + escapeHtml(data.author) + '</div>';
                }
                inner += '<div class="content">' + formatContent(data.content) + '</div>';
                inner += '<div class="time">' + escapeHtml(data.timestamp) + '</div>';

                div.innerHTML = inner;
                chat.appendChild(div);
                chat.scrollTop = chat.scrollHeight;
            }

            if (type === 'typing') {
                if (data.typing) {
                    typing.textContent = data.author + ' sta scrivendo...';
                } else {
                    typing.textContent = '';
                }
            }

            if (type === 'settings') {
                tokenInput.value = data.botToken || '';
                channelInput.value = data.channelId || '';
                portInput.value = data.debugPort || 9000;
                autoAcceptInput.checked = data.autoAccept !== false;
            }

            if (type === 'status') {
                document.getElementById('discord-dot').className =
                    'status-dot ' + (data.discord ? 'on' : 'off');
                document.getElementById('cdp-dot').className =
                    'status-dot ' + (data.cdp ? 'on' : 'off');
            }
        });

        // Request initial status
        vscode.postMessage({ type: 'getStatus' });
    </script>
</body>
</html>`;
    }
}
