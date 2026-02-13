import * as vscode from "vscode";

interface ChatMessage {
    role: "user" | "assistant" | "system";
    author: string;
    content: string;
    timestamp: string;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "antigravity-discord.chatView";

    private view?: vscode.WebviewView;
    private messages: ChatMessage[] = [];

    constructor(private readonly extensionUri: vscode.Uri) { }

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
</style>
</head>
<body>
    <div id="chat">
        <div id="empty">In attesa di messaggi Discord...</div>
    </div>
    <div id="typing"></div>
    <script>
        const vscode = acquireVsCodeApi();
        const chat = document.getElementById('chat');
        const typing = document.getElementById('typing');
        const empty = document.getElementById('empty');
        let hasMessages = false;

        function escapeHtml(s) {
            const div = document.createElement('div');
            div.textContent = s;
            return div.innerHTML;
        }

        function formatContent(text) {
            // Basic markdown: code blocks, inline code, bold, italic
            let html = escapeHtml(text);
            // Code blocks
            html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
            // Inline code
            html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
            // Bold
            html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
            // Italic
            html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
            // Newlines
            html = html.replace(/\\n/g, '<br>');
            return html;
        }

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
        });
    </script>
</body>
</html>`;
    }
}
