import {
    Client,
    GatewayIntentBits,
    TextChannel,
    ThreadChannel,
    Message,
    Events,
    ActivityType,
    PresenceStatusData,
    ThreadAutoArchiveDuration,
    ChannelType,
} from "discord.js";
import type * as vscode from "vscode";
import { splitMessage } from "./utils.js";

export interface DiscordMessage {
    author: string;
    content: string;
    timestamp: Date;
    attachments: string[];
    messageId: string;
    /** Thread ID if the message came from a thread (continuing an existing conversation) */
    threadId?: string;
    /** True if the message was sent in the main channel (starts a new conversation) */
    isMainChannel: boolean;
}

type MessageCallback = (msg: DiscordMessage) => void;

/**
 * Clean Discord bot client.
 *
 * Message routing rules (single gate, no overlapping dedup):
 * 1. Ignore all bot messages (prevents loops)
 * 2. Accept messages in the main channel → new conversation
 * 3. Accept messages in threads under the main channel → continue conversation
 * 4. Skip thread-starter echoes (message.id === thread.id when startThread() is used)
 * 5. All other messages → ignore
 *
 * Deduplication is NOT done here — it's the orchestrator's responsibility.
 */
export class DiscordClient {
    private client: Client;
    private channel: TextChannel | null = null;
    private channelId: string;
    private messageCallback: MessageCallback | null = null;
    private log: vscode.OutputChannel;
    private connected = false;

    constructor(channelId: string, outputChannel: vscode.OutputChannel) {
        this.channelId = channelId;
        this.log = outputChannel;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
            ],
        });

        // Register the single message listener
        this.client.on(Events.MessageCreate, (message: Message) => {
            this.routeMessage(message);
        });

        this.client.on(Events.Error, (error: Error) => {
            this.log.appendLine(`[Discord] Error: ${error.message}`);
        });
    }

    // ── Connection ───────────────────────────────────────────

    async connect(token: string): Promise<void> {
        this.log.appendLine("[Discord] Connecting...");
        await this.client.login(token);

        const ch = await this.client.channels.fetch(this.channelId);
        if (!ch || !(ch instanceof TextChannel)) {
            throw new Error(`Channel ${this.channelId} not found or not a text channel`);
        }
        this.channel = ch;
        this.connected = true;
        this.log.appendLine(`[Discord] Connected to #${this.channel.name}`);
    }

    async reconnect(token: string, channelId?: string): Promise<void> {
        if (channelId) this.channelId = channelId;

        if (!this.client.isReady()) {
            this.log.appendLine("[Discord] Re-logging in...");
            await this.client.login(token);
        }

        const ch = await this.client.channels.fetch(this.channelId);
        if (!ch || !(ch instanceof TextChannel)) {
            throw new Error(`Channel ${this.channelId} not found or not a text channel`);
        }
        this.channel = ch;
        this.connected = true;
        this.log.appendLine(`[Discord] Reconnected to #${this.channel.name}`);
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.client.destroy();
        this.log.appendLine("[Discord] Disconnected");
    }

    isConnected(): boolean {
        return this.connected;
    }

    // ── Callbacks ────────────────────────────────────────────

    onMessage(callback: MessageCallback): void {
        this.messageCallback = callback;
    }

    // ── Sending messages ─────────────────────────────────────

    async sendMessage(content: string): Promise<void> {
        if (!this.channel) throw new Error("Not connected to Discord");
        for (const chunk of splitMessage(content)) {
            await this.channel.send(chunk);
        }
    }

    async sendToThread(thread: ThreadChannel, content: string): Promise<void> {
        const chunks = splitMessage(content);
        for (const chunk of chunks) {
            const nonce = `${Date.now()}${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`;
            await thread.send({ content: chunk, nonce, enforceNonce: true });
        }
    }

    // ── Thread management ────────────────────────────────────

    async createThread(messageId: string, name: string): Promise<ThreadChannel> {
        if (!this.channel) throw new Error("Not connected to Discord");
        const message = await this.channel.messages.fetch(messageId);
        return message.startThread({
            name: name.substring(0, 100),
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        });
    }

    async createConversationThread(name: string): Promise<ThreadChannel> {
        if (!this.channel) throw new Error("Not connected to Discord");
        return this.channel.threads.create({
            name: name.substring(0, 100),
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
            type: ChannelType.PublicThread,
        });
    }

    async getThread(threadId: string): Promise<ThreadChannel | null> {
        try {
            const ch = await this.client.channels.fetch(threadId);
            return ch?.isThread() ? (ch as ThreadChannel) : null;
        } catch {
            return null;
        }
    }

    // ── Presence ─────────────────────────────────────────────

    setPresence(status: PresenceStatusData, activity: string): void {
        this.client.user?.setPresence({
            status,
            activities: [{
                name: activity,
                type: ActivityType.Custom,
                state: activity,
            }],
        });
    }

    async setTypingInThread(thread: ThreadChannel): Promise<void> {
        await thread.sendTyping();
    }

    // ── Message routing (single gate) ────────────────────────

    private routeMessage(message: Message): void {
        // Rule 1: Ignore bot messages
        if (message.author.bot) return;

        const isMainChannel = message.channelId === this.channelId;
        const isOurThread = message.channel.isThread() &&
            message.channel.parentId === this.channelId;

        // Rule 5: Only our channel or its threads
        if (!isMainChannel && !isOurThread) return;

        // Rule 4: Skip thread-starter echo
        // When startThread() creates a thread on a message, Discord re-emits
        // the original message as a thread message with message.id === thread.id
        if (isOurThread && message.id === message.channelId) {
            this.log.appendLine(
                `[Discord] Skipping thread-starter echo: ${message.id}`
            );
            return;
        }

        const threadId = isOurThread ? message.channelId : undefined;

        this.log.appendLine(
            `[Discord] ${isMainChannel ? "📩 Main" : "💬 Thread"} from ${message.author.displayName}: ` +
            `"${message.content.substring(0, 80)}"`
        );

        this.messageCallback?.({
            author: message.author.displayName,
            content: message.content,
            timestamp: message.createdAt,
            attachments: message.attachments.map(a => a.url),
            messageId: message.id,
            threadId,
            isMainChannel,
        });
    }
}
