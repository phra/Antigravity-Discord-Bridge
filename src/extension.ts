import * as vscode from "vscode";
import { DiscordClient, DiscordMessage } from "./discord-client.js";
import { ChatPanelProvider } from "./chat-panel.js";

const PARTICIPANT_ID = "antigravity.discord";

let discordClient: DiscordClient | null = null;
let chatPanel: ChatPanelProvider;
let outputChannel: vscode.OutputChannel;
let processing = false;

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

    // Register the @discord chat participant (for IDE → Discord)
    const participant = vscode.chat.createChatParticipant(
        PARTICIPANT_ID,
        chatHandler
    );
    participant.iconPath = new vscode.ThemeIcon("comment-discussion");
    context.subscriptions.push(participant);

    // Try to connect Discord on activation
    connectDiscord().catch((err) => {
        outputChannel.appendLine(`[Extension] Activation connect failed: ${err}`);
        outputChannel.show(true);
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
                    outputChannel.show(true);
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
            }
        )
    );

    outputChannel.appendLine("[Extension] Antigravity Discord Bridge activated");
}

export function deactivate() {
    if (discordClient) {
        discordClient.disconnect();
        discordClient = null;
    }
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

    // Disconnect existing client
    if (discordClient) {
        await discordClient.disconnect();
    }

    discordClient = new DiscordClient(channelId, outputChannel);

    // Auto-process incoming Discord messages
    discordClient.onMessage((msg: DiscordMessage) => {
        handleDiscordMessage(msg);
    });

    try {
        await discordClient.connect(token);
        vscode.window.showInformationMessage(
            "Antigravity Discord Bridge: Connected!"
        );
    } catch (err: unknown) {
        const errorMsg =
            err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Extension] Connection failed: ${errorMsg}`);
        vscode.window.showErrorMessage(
            `Discord connection failed: ${errorMsg}`
        );
        discordClient = null;
    }
}

/**
 * Auto-process a Discord message: send to LM, reply on Discord.
 * Shows a notification in VS Code with the question and a summary.
 */
async function handleDiscordMessage(msg: DiscordMessage): Promise<void> {
    if (processing) {
        // Queue a "busy" reply
        outputChannel.appendLine(
            `[Extension] Busy processing, skipping message from ${msg.author}`
        );
        if (discordClient?.isConnected()) {
            await discordClient.sendMessage(
                `⏳ Sto ancora elaborando una richiesta precedente. Riprova tra poco.`
            );
        }
        return;
    }

    processing = true;
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
        const response = await sendToLM(msg.content);

        // Show response in WebView panel
        chatPanel.setTyping("assistant", false);
        chatPanel.addMessage("assistant", "Antigravity", response);

        // Send response to Discord
        if (discordClient?.isConnected() && response.length > 0) {
            await discordClient.sendMessage(response);
            outputChannel.appendLine(
                `[Extension] Response sent to Discord (${response.length} chars)`
            );
        }

        // Notify IDE user
        vscode.window.setStatusBarMessage(
            `✅ Discord: risposta inviata a ${msg.author}`,
            5000
        );
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[Extension] Error processing: ${errorMsg}`);

        if (discordClient?.isConnected()) {
            await discordClient
                .sendMessage(`⚠️ Errore: ${errorMsg}`)
                .catch(() => { });
        }
    } finally {
        processing = false;
    }
}

/**
 * Send a prompt to the Language Model and return the full response.
 */
async function sendToLM(prompt: string): Promise<string> {
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
        throw new Error("Nessun Language Model disponibile");
    }

    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

    let fullResponse = "";
    for await (const chunk of response.text) {
        fullResponse += chunk;

        // Refresh typing indicator every ~5s worth of chunks
        if (discordClient?.isConnected()) {
            discordClient.setTyping().catch(() => { });
        }
    }

    return fullResponse;
}

/**
 * Chat Participant handler — for IDE-initiated messages via @discord.
 * Sends prompt to LM, shows response in IDE, forwards to Discord.
 */
const chatHandler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<vscode.ChatResult> => {
    const prompt = request.prompt.trim();

    if (!prompt) {
        stream.markdown("Scrivi un messaggio da inviare anche su Discord.");
        return {};
    }

    // Send typing indicator on Discord
    if (discordClient?.isConnected()) {
        discordClient.setTyping().catch(() => { });
    }

    // Send to LM and stream to IDE chat
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) {
        stream.markdown(
            "⚠️ Nessun Language Model disponibile. Assicurati di avere Gemini o Copilot attivo."
        );
        return {};
    }

    const model = models[0];
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];

    try {
        const response = await model.sendRequest(messages, {}, token);

        let fullResponse = "";
        for await (const chunk of response.text) {
            stream.markdown(chunk);
            fullResponse += chunk;
        }

        // Forward to Discord
        if (discordClient?.isConnected() && fullResponse.length > 0) {
            try {
                await discordClient.sendMessage(fullResponse);
                stream.markdown("\n\n---\n✅ *Inviato su Discord*");
            } catch (err: unknown) {
                const errorMsg =
                    err instanceof Error ? err.message : String(err);
                stream.markdown(`\n\n---\n⚠️ *Invio Discord fallito: ${errorMsg}*`);
            }
        }

        return {};
    } catch (err: unknown) {
        if (err instanceof vscode.LanguageModelError) {
            stream.markdown(`⚠️ Language Model error: ${err.message}`);
        } else {
            const errorMsg =
                err instanceof Error ? err.message : String(err);
            stream.markdown(`⚠️ Error: ${errorMsg}`);
        }
        return {};
    }
};
