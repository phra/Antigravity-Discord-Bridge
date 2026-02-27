import * as vscode from "vscode";
import { DiscordClient, DiscordMessage } from "./discord-client.js";
import { ChatPanelProvider } from "./chat-panel.js";
import { CdpBridge } from "./cdp-bridge.js";
import { isMcpNoise } from "./utils.js";

let discordClient: DiscordClient | null = null;
let cdpBridge: CdpBridge | null = null;
let chatPanel: ChatPanelProvider;
let outputChannel: vscode.OutputChannel;
let processing = false;
const messageQueue: DiscordMessage[] = [];
const MAX_QUEUE_SIZE = 5;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel("Antigravity Discord");

    // Register the WebView chat panel in the sidebar
    chatPanel = new ChatPanelProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatPanelProvider.viewType,
            chatPanel
        )
    );

    // Provide connection status to the panel
    chatPanel.onStatusRequest(() => ({
        discord: discordClient?.isConnected() ?? false,
        cdp: cdpBridge?.isConnected() ?? false,
        autoAccept: cdpBridge?.isAutoAcceptRunning() ?? false,
    }));

    // Try to connect Discord on activation
    connectDiscord().catch((err) => {
        outputChannel.appendLine(`[Extension] Discord connect failed: ${err}`);
        outputChannel.show(true);
    });

    // Try to connect to CDP on activation
    connectCdp().catch((err) => {
        outputChannel.appendLine(`[Extension] CDP connect failed: ${err}`);
    });

    // Reconnect when settings change
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (
                e.affectsConfiguration("antigravity-discord.botToken") ||
                e.affectsConfiguration("antigravity-discord.channelId")
            ) {
                connectDiscord().catch((err) => {
                    outputChannel.appendLine(`[Extension] Reconnect failed: ${err}`);
                });
            }
            if (e.affectsConfiguration("antigravity-discord.debugPort")) {
                connectCdp().catch((err) => {
                    outputChannel.appendLine(`[Extension] CDP reconnect failed: ${err}`);
                });
            }
        })
    );

    // Command to manually reconnect
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "antigravity-discord.reconnect",
            () => {
                connectDiscord().catch((err) => {
                    outputChannel.appendLine(`[Extension] Manual reconnect failed: ${err}`);
                    outputChannel.show(true);
                });
                connectCdp().catch((err) => {
                    outputChannel.appendLine(`[Extension] Manual CDP reconnect failed: ${err}`);
                });
            }
        )
    );

    outputChannel.appendLine("[Extension] Antigravity Discord Bridge activated");
    outputChannel.show(true);
}

export function deactivate() {
    if (discordClient) {
        discordClient.disconnect();
        discordClient = null;
    }
    if (cdpBridge) {
        cdpBridge.disconnect();
        cdpBridge = null;
    }
}

/**
 * Connect to CDP (Chrome DevTools Protocol) for chat interaction.
 */
async function connectCdp(): Promise<void> {
    const config = vscode.workspace.getConfiguration("antigravity-discord");
    const port = config.get<number>("debugPort", 9000);

    outputChannel.appendLine(`[Extension] Connecting to CDP on port ${port}...`);

    if (cdpBridge) {
        cdpBridge.disconnect();
    }

    cdpBridge = new CdpBridge(port, outputChannel);

    try {
        await cdpBridge.connect();
        outputChannel.appendLine("[Extension] CDP bridge ready");

        // Start auto-accept immediately if enabled
        const autoAcceptEnabled = config.get<boolean>("autoAccept", true);
        if (autoAcceptEnabled) {
            try {
                await cdpBridge.startAutoAccept();
                outputChannel.appendLine("[Extension] Auto-accept started (always-on mode)");
            } catch (err) {
                outputChannel.appendLine(`[Extension] Auto-accept start failed: ${err}`);
            }
        }
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Extension] CDP failed: ${errorMsg}`);
        cdpBridge = null;
    }
    pushStatus();
}

/**
 * Connect (or reconnect) to Discord using settings.
 */
async function connectDiscord(): Promise<void> {
    const config = vscode.workspace.getConfiguration("antigravity-discord");
    const token = config.get<string>("botToken", "");
    const channelId = config.get<string>("channelId", "");

    outputChannel.appendLine(
        `[Extension] connectDiscord called. Token: ${token ? "set (" + token.substring(0, 5) + "...)" : "EMPTY"}, Channel: ${channelId || "EMPTY"}`
    );

    if (!token || !channelId) {
        outputChannel.appendLine(
            "[Extension] Missing botToken or channelId in settings. Skipping Discord connection."
        );
        return;
    }

    if (discordClient) {
        await discordClient.disconnect();
    }

    discordClient = new DiscordClient(channelId, outputChannel);

    discordClient.onMessage((msg: DiscordMessage) => {
        handleDiscordMessage(msg);
    });

    try {
        await discordClient.connect(token);
        discordClient.setPresence("online", "Waiting for commands");
        vscode.window.showInformationMessage(
            "Antigravity Discord Bridge: Connected!"
        );
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Extension] Connection failed: ${errorMsg}`);
        vscode.window.showErrorMessage(
            `Discord connection failed: ${errorMsg}`
        );
        discordClient = null;
    }
    pushStatus();
}

/**
 * Push current connection status to the webview panel.
 */
function pushStatus(): void {
    chatPanel.updateStatus({
        discord: discordClient?.isConnected() ?? false,
        cdp: cdpBridge?.isConnected() ?? false,
        autoAccept: cdpBridge?.isAutoAcceptRunning() ?? false,
    });
}

/**
 * Process a Discord message:
 * 1. Inject it into the Antigravity chat via CDP
 * 2. Wait for the agent to respond
 * 3. Extract the response and send it back to Discord
 */
async function handleDiscordMessage(msg: DiscordMessage): Promise<void> {
    if (processing) {
        // Enqueue instead of rejecting
        if (messageQueue.length >= MAX_QUEUE_SIZE) {
            outputChannel.appendLine(
                `[Extension] Queue full (${MAX_QUEUE_SIZE}), dropping message from ${msg.author}`
            );
            if (discordClient?.isConnected()) {
                await discordClient.sendMessage(
                    `⚠️ Coda piena (${MAX_QUEUE_SIZE} messaggi). Riprova più tardi.`
                );
            }
            return;
        }

        messageQueue.push(msg);
        const position = messageQueue.length;
        outputChannel.appendLine(
            `[Extension] Queued message from ${msg.author} (position ${position})`
        );
        if (discordClient?.isConnected()) {
            await discordClient.sendMessage(
                `⏳ In coda (posizione ${position}). Il tuo messaggio verrà elaborato automaticamente.`
            );
        }
        return;
    }

    if (!cdpBridge?.isConnected()) {
        outputChannel.appendLine("[Extension] CDP bridge not connected. Trying to reconnect...");
        try {
            await connectCdp();
        } catch { }

        if (!cdpBridge?.isConnected()) {
            if (discordClient?.isConnected()) {
                await discordClient.sendMessage(
                    `⚠️ Bridge non connesso. Avvia Antigravity con --remote-debugging-port=9000`
                );
            }
            return;
        }
    }

    processing = true;
    discordClient?.setPresence("dnd", "Writing code");
    outputChannel.appendLine(
        `[Extension] Processing message from ${msg.author}: ${msg.content}`
    );

    // Show in WebView panel
    chatPanel.addMessage("user", msg.author, msg.content);
    chatPanel.setTyping("assistant", true);

    // Show typing indicator on Discord
    if (discordClient?.isConnected()) {
        discordClient.setTyping().catch(() => { });
    }

    // Notify IDE user
    vscode.window.setStatusBarMessage(
        `💬 Discord: ${msg.author} → "${msg.content.substring(0, 50)}..."`,
        10000
    );

    try {
        // 0. Ensure the chat panel is focused (NOT toggle — openAgent closes it if already open!)
        try {
            await vscode.commands.executeCommand("antigravity.agentPanel.focus");
            await new Promise(r => setTimeout(r, 1000)); // wait for UI to settle
            outputChannel.appendLine("[CDP] Focused agent panel");
        } catch (err) {
            outputChannel.appendLine(`[CDP] Could not focus agent panel: ${err}`);
        }

        // 1. Take a pre-snapshot of the chat
        const preSnapshot = await cdpBridge!.chatSnapshot();
        outputChannel.appendLine(
            `[CDP] Pre-snapshot: ${preSnapshot.count} messages`
        );

        // 2. Inject the message into the Antigravity chat
        const sendResult = await cdpBridge!.sendMessage(msg.content);
        if (!sendResult.ok) {
            throw new Error(`Failed to inject message: ${sendResult.error}`);
        }
        outputChannel.appendLine(
            `[CDP] Message injected (${(sendResult as { method?: string }).method || "unknown"})`
        );

        // 2b. Verify the agent started — retry send if not
        // Fixes first-message-empty bug when editor needs initial warm-up
        let agentStarted = false;
        for (let i = 0; i < 6 && !agentStarted; i++) {
            await new Promise(r => setTimeout(r, 500));
            agentStarted = await cdpBridge!.isBusy();
        }

        if (!agentStarted) {
            outputChannel.appendLine("[CDP] Agent didn't start — retrying message send");
            const retryResult = await cdpBridge!.sendMessage(msg.content);
            outputChannel.appendLine(
                `[CDP] Retry result: ${retryResult.ok ? 'ok' : retryResult.error} (${(retryResult as { method?: string }).method || "unknown"})`
            );
        }

        // Auto-accept is now always-on (started at CDP connect time)

        // 3. Create a Discord thread for reasoning/thinking stream
        let reasoningThread: import("discord.js").ThreadChannel | null = null;
        try {
            if (discordClient?.isConnected()) {
                reasoningThread = await discordClient.createThread(
                    msg.messageId,
                    `🤔 ${msg.content.substring(0, 80)}`
                );
                await discordClient.sendToThread(
                    reasoningThread,
                    `💭 **Ragionamento in corso...**`
                );
            }
        } catch (threadErr) {
            outputChannel.appendLine(
                `[Extension] Could not create thread: ${threadErr instanceof Error ? threadErr.message : String(threadErr)}`
            );
        }

        // 4. Keep discord typing indicator alive during processing
        const typingInterval = setInterval(() => {
            if (discordClient?.isConnected()) {
                discordClient.setTyping().catch(() => { });
            }
        }, 5000);

        // 5. Wait for the agent to respond, streaming reasoning to thread
        try {
            const response = await cdpBridge!.waitForResponse(
                preSnapshot, msg.content,
                // Stream reasoning chunks to the Discord thread
                async (chunk: string) => {
                    if (reasoningThread && discordClient?.isConnected()) {
                        try {
                            // Skip noise and MCP config text in reasoning
                            if (isMcpNoise(chunk)) return;
                            const trimmed = chunk.substring(0, 1900); // Discord limit
                            if (trimmed.length > 5) {
                                await discordClient.sendToThread(reasoningThread, trimmed);
                            }
                        } catch { }
                    }
                }
            );
            clearInterval(typingInterval);

            outputChannel.appendLine(
                `[CDP] Final response extracted (${response.length} chars)`
            );

            // Close out the reasoning thread
            if (reasoningThread && discordClient?.isConnected()) {
                try {
                    await discordClient.sendToThread(
                        reasoningThread,
                        `✅ **Elaborazione completata**`
                    );
                } catch { }
            }

            // Show in WebView
            chatPanel.setTyping("assistant", false);
            chatPanel.addMessage("assistant", "Antigravity", response);

            // Send final response to main channel
            // Try markdown-formatted extraction first, fall back to plain text diff
            if (discordClient?.isConnected() && response.length > 0) {
                let discordResponse = response;

                try {
                    const mdResponse = await cdpBridge!.extractLastResponseMarkdown();
                    if (mdResponse.length > 0) {
                        discordResponse = mdResponse;
                        outputChannel.appendLine(
                            `[Extension] Using markdown-formatted response (${mdResponse.length} chars)`
                        );
                    } else {
                        outputChannel.appendLine(
                            `[Extension] Markdown extraction empty, using plain text diff`
                        );
                    }
                } catch (mdErr) {
                    outputChannel.appendLine(
                        `[Extension] Markdown extraction failed, using plain text: ${mdErr}`
                    );
                }

                // Skip MCP config noise that leaked into the response
                if (isMcpNoise(discordResponse)) {
                    outputChannel.appendLine(
                        `[Extension] Skipping MCP noise response (${discordResponse.length} chars)`
                    );
                } else {
                    await discordClient.sendMessage(discordResponse);
                    outputChannel.appendLine(
                        `[Extension] Final response sent to Discord channel (${discordResponse.length} chars)`
                    );
                }
            }

            vscode.window.setStatusBarMessage(
                `✅ Discord: risposta inviata a ${msg.author}`,
                5000
            );
        } catch (waitErr) {
            clearInterval(typingInterval);
            throw waitErr;
        }
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Extension] Error processing: ${errorMsg}`);

        chatPanel.setTyping("assistant", false);

        if (discordClient?.isConnected()) {
            await discordClient
                .sendMessage(`⚠️ Errore: ${errorMsg}`)
                .catch(() => { });
        }
    } finally {
        processing = false;
        discordClient?.setPresence("online", "Waiting for commands");

        // Process next queued message if any
        if (messageQueue.length > 0) {
            const nextMsg = messageQueue.shift()!;
            outputChannel.appendLine(
                `[Extension] Dequeuing message from ${nextMsg.author} (${messageQueue.length} remaining)`
            );
            if (discordClient?.isConnected()) {
                await discordClient.sendMessage(
                    `▶️ Elaborazione del tuo messaggio in coda: "${nextMsg.content.substring(0, 80)}${nextMsg.content.length > 80 ? '...' : ''}"`
                ).catch(() => { });
            }
            // Process asynchronously (don't await to avoid deep recursion)
            handleDiscordMessage(nextMsg).catch((err) => {
                outputChannel.appendLine(`[Extension] Queue processing error: ${err}`);
            });
        }
    }
}
