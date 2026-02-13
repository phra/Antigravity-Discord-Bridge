import {
    Client,
    GatewayIntentBits,
    TextChannel,
    Message,
    Events,
    Partials,
    ActivityType,
    PresenceStatusData,
} from "discord.js";
import * as vscode from "vscode";

export interface DiscordMessage {
    author: string;
    content: string;
    timestamp: Date;
    attachments: string[];
}

type MessageCallback = (msg: DiscordMessage) => void;

export class DiscordClient {
    private client: Client;
    private channel: TextChannel | null = null;
    private channelId: string;
    private messageCallback: MessageCallback | null = null;
    private outputChannel: vscode.OutputChannel;
    private connected = false;

    constructor(channelId: string, outputChannel: vscode.OutputChannel) {
        this.channelId = channelId;
        this.outputChannel = outputChannel;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
            partials: [Partials.Message, Partials.Channel],
        });

        this.client.on(Events.MessageCreate, (message: Message) => {
            this.handleMessage(message);
        });

        this.client.on(Events.Error, (error: Error) => {
            this.outputChannel.appendLine(`[Discord] Error: ${error.message}`);
        });
    }

    async connect(token: string): Promise<void> {
        this.outputChannel.appendLine("[Discord] Connecting...");
        await this.client.login(token);

        const ch = await this.client.channels.fetch(this.channelId);
        if (!ch || !(ch instanceof TextChannel)) {
            throw new Error(
                `Channel ${this.channelId} not found or is not a text channel`
            );
        }
        this.channel = ch;
        this.connected = true;
        this.outputChannel.appendLine(
            `[Discord] Connected to #${this.channel.name}`
        );
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.client.destroy();
        this.outputChannel.appendLine("[Discord] Disconnected");
    }

    isConnected(): boolean {
        return this.connected;
    }

    onMessage(callback: MessageCallback): void {
        this.messageCallback = callback;
    }

    async sendMessage(content: string): Promise<void> {
        if (!this.channel) {
            throw new Error("Not connected to Discord");
        }

        const chunks = this.splitMessage(content);
        for (const chunk of chunks) {
            await this.channel.send(chunk);
        }
    }

    async setTyping(): Promise<void> {
        if (this.channel) {
            await this.channel.sendTyping();
        }
    }

    setPresence(status: PresenceStatusData, activity: string): void {
        this.client.user?.setPresence({
            status,
            activities: [
                {
                    name: activity,
                    type: ActivityType.Custom,
                    state: activity,
                },
            ],
        });
        this.outputChannel.appendLine(
            `[Discord] Presence → ${status}: "${activity}"`
        );
    }

    private handleMessage(message: Message): void {
        // Ignore bot messages (prevents loops)
        if (message.author.bot) {
            return;
        }
        // Only process messages from the configured channel
        if (message.channelId !== this.channelId) {
            return;
        }

        this.outputChannel.appendLine(
            `[Discord] Message from ${message.author.displayName}: ${message.content}`
        );

        if (this.messageCallback) {
            this.messageCallback({
                author: message.author.displayName,
                content: message.content,
                timestamp: message.createdAt,
                attachments: message.attachments.map((a) => a.url),
            });
        }
    }

    /**
     * Split a message into chunks that fit Discord's 2000 char limit.
     * Preserves code blocks intact when possible.
     */
    private splitMessage(text: string, maxLen = 2000): string[] {
        if (text.length <= maxLen) {
            return [text];
        }

        const chunks: string[] = [];
        let remaining = text;

        while (remaining.length > 0) {
            if (remaining.length <= maxLen) {
                chunks.push(remaining);
                break;
            }

            // Try to split at a code block boundary
            let splitIdx = this.findSplitPoint(remaining, maxLen);
            chunks.push(remaining.substring(0, splitIdx));
            remaining = remaining.substring(splitIdx);
        }

        return chunks;
    }

    /**
     * Find the best point to split a message:
     * 1. Try to split at a double newline (paragraph break)
     * 2. Try to split at a single newline
     * 3. Fall back to maxLen
     */
    private findSplitPoint(text: string, maxLen: number): number {
        // Look for a paragraph break near the limit
        const doubleNewline = text.lastIndexOf("\n\n", maxLen);
        if (doubleNewline > maxLen * 0.5) {
            return doubleNewline + 2;
        }

        // Look for a single newline
        const singleNewline = text.lastIndexOf("\n", maxLen);
        if (singleNewline > maxLen * 0.3) {
            return singleNewline + 1;
        }

        // Hard split
        return maxLen;
    }
}
