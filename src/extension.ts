import * as vscode from "vscode";
import { DiscordClient, DiscordMessage } from "./discord-client.js";
import { ChatPanelProvider } from "./chat-panel.js";
import { CdpBridge } from "./cdp-bridge.js";
import { isMcpNoise, isNoiseLine } from "./utils.js";

// ── Types ───────────────────────────────────────────────

type BridgeState = "idle" | "processing" | "reconnecting";

interface QueueEntry {
    msg: DiscordMessage;
    enqueueTime: number;
}

// ── Leader Election via globalState ─────────────────────

const LEADER_KEY = "antigravity-discord.leaderId";
const LEADER_HEARTBEAT_KEY = "antigravity-discord.leaderHeartbeat";
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TTL_MS = 15000;

/**
 * Determine if this extension instance is the leader.
 * Uses VS Code globalState (shared across extension host windows).
 * The leader writes a heartbeat timestamp; other instances defer.
 */
function tryBecomeLeader(ctx: vscode.ExtensionContext): boolean {
    const instanceId = `${process.pid}-${Date.now()}`;
    const currentLeader = ctx.globalState.get<string>(LEADER_KEY);
    const lastHeartbeat = ctx.globalState.get<number>(LEADER_HEARTBEAT_KEY) || 0;
    const now = Date.now();

    // If no leader, or leader heartbeat is stale → become leader
    if (!currentLeader || (now - lastHeartbeat) > HEARTBEAT_TTL_MS) {
        ctx.globalState.update(LEADER_KEY, instanceId);
        ctx.globalState.update(LEADER_HEARTBEAT_KEY, now);
        return true;
    }

    // If WE are the leader (re-activation) → refresh heartbeat
    if (currentLeader.startsWith(`${process.pid}-`)) {
        ctx.globalState.update(LEADER_HEARTBEAT_KEY, now);
        return true;
    }

    return false;
}

function refreshHeartbeat(ctx: vscode.ExtensionContext): void {
    ctx.globalState.update(LEADER_HEARTBEAT_KEY, Date.now());
}

async function releaseLeadership(ctx: vscode.ExtensionContext): Promise<void> {
    const currentLeader = ctx.globalState.get<string>(LEADER_KEY);
    if (currentLeader?.startsWith(`${process.pid}-`)) {
        await ctx.globalState.update(LEADER_KEY, undefined);
        await ctx.globalState.update(LEADER_HEARTBEAT_KEY, undefined);
    }
}

// ── BridgeController ────────────────────────────────────

class BridgeController {
    private state: BridgeState = "idle";
    private discord: DiscordClient | null = null;
    private cdp: CdpBridge | null = null;
    private panel: ChatPanelProvider;
    private log: vscode.OutputChannel;
    private ctx: vscode.ExtensionContext;

    private queue: QueueEntry[] = [];
    private readonly MAX_QUEUE = 5;
    private processedIds = new Set<string>();
    private readonly DEDUP_TTL = 60_000;

    /** Thread ID → Antigravity conversation name */
    private conversationMap = new Map<string, string>();

    private busyPollInterval: ReturnType<typeof setInterval> | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private lastBusyState = false;

    constructor(ctx: vscode.ExtensionContext) {
        this.ctx = ctx;
        this.log = vscode.window.createOutputChannel("Antigravity Discord");
        this.panel = new ChatPanelProvider(ctx.extensionUri);

        ctx.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                ChatPanelProvider.viewType,
                this.panel
            )
        );

        this.panel.onStatusRequest(() => ({
            discord: this.discord?.isConnected() ?? false,
            cdp: this.cdp?.isConnected() ?? false,
            autoAccept: this.cdp?.isAutoAcceptRunning() ?? false,
        }));

        // Start heartbeat
        this.heartbeatInterval = setInterval(() => refreshHeartbeat(ctx), HEARTBEAT_INTERVAL_MS);

        // Reconnect on config changes
        ctx.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration("antigravity-discord.botToken") ||
                    e.affectsConfiguration("antigravity-discord.channelId")) {
                    this.connectDiscord().catch(err =>
                        this.log.appendLine(`[Extension] Reconnect failed: ${err}`)
                    );
                }
                if (e.affectsConfiguration("antigravity-discord.debugPort")) {
                    this.connectCdp().catch(err =>
                        this.log.appendLine(`[Extension] CDP reconnect failed: ${err}`)
                    );
                }
            })
        );

        // Manual reconnect command
        ctx.subscriptions.push(
            vscode.commands.registerCommand("antigravity-discord.reconnect", () => {
                this.connectDiscord().catch(err =>
                    this.log.appendLine(`[Extension] Manual reconnect failed: ${err}`)
                );
                this.connectCdp().catch(err =>
                    this.log.appendLine(`[Extension] Manual CDP reconnect failed: ${err}`)
                );
            })
        );
    }

    async start(): Promise<void> {
        this.log.appendLine(`[Extension] [PID=${process.pid}] Antigravity Discord Bridge activated`);
        this.log.show(true);

        await Promise.allSettled([
            this.connectDiscord(),
            this.connectCdp(),
        ]);
    }

    async stop(): Promise<void> {
        if (this.busyPollInterval) clearInterval(this.busyPollInterval);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

        if (this.discord) {
            await this.discord.disconnect().catch(() => { });
            this.discord = null;
        }
        if (this.cdp) {
            this.cdp.disconnect();
            this.cdp = null;
        }

        releaseLeadership(this.ctx);
    }

    // ── Discord connection ───────────────────────────────

    private async connectDiscord(): Promise<void> {
        const config = vscode.workspace.getConfiguration("antigravity-discord");
        const token = config.get<string>("botToken", "");
        const channelId = config.get<string>("channelId", "");

        if (!token || !channelId) {
            this.log.appendLine("[Extension] Missing botToken or channelId — skipping Discord");
            return;
        }

        try {
            if (this.discord) {
                await this.discord.reconnect(token, channelId);
            } else {
                this.discord = new DiscordClient(channelId, this.log);
                this.discord.onMessage(msg => this.handleMessage(msg));
                await this.discord.connect(token);
            }
            if (this.cdp?.isConnected()) {
                this.discord.setPresence("online", "Waiting for commands");
            } else {
                this.discord.setPresence("idle", "⚠️ CDP not connected");
            }
            vscode.window.showInformationMessage("Antigravity Discord Bridge: Connected!");
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[Extension] Discord failed: ${errorMsg}`);
            vscode.window.showErrorMessage(`Discord connection failed: ${errorMsg}`);
            if (!this.discord?.isConnected()) this.discord = null;
        }
        this.pushStatus();
    }

    // ── CDP connection ───────────────────────────────────

    private async connectCdp(): Promise<void> {
        const config = vscode.workspace.getConfiguration("antigravity-discord");
        const port = config.get<number>("debugPort", 9000);

        this.log.appendLine(`[Extension] Connecting to CDP on port ${port}...`);

        if (this.cdp) this.cdp.disconnect();
        this.cdp = new CdpBridge(port, this.log);

        try {
            await this.cdp.connect();
            this.log.appendLine("[Extension] CDP bridge ready");

            // Start auto-accept
            if (config.get<boolean>("autoAccept", true)) {
                try {
                    await this.cdp.startAutoAccept();
                    this.log.appendLine("[Extension] Auto-accept started");
                } catch (err) {
                    this.log.appendLine(`[Extension] Auto-accept failed: ${err}`);
                }
            }

            this.startBusyPoller();
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[Extension] CDP failed: ${errorMsg}`);
            this.cdp = null;
            // Show away status so operators know CDP is down
            if (this.discord?.isConnected()) {
                this.discord.setPresence("idle", "⚠️ CDP not connected");
            }
        }
        this.pushStatus();
    }

    // ── Busy state poller ────────────────────────────────

    private startBusyPoller(): void {
        if (this.busyPollInterval) return;
        this.busyPollInterval = setInterval(async () => {
            if (!this.cdp?.isConnected() || !this.discord?.isConnected()) return;
            if (this.state !== "idle") return;

            try {
                const busy = await this.cdp.isBusy();
                if (this.state !== "idle") return;
                if (busy !== this.lastBusyState) {
                    this.lastBusyState = busy;
                    this.discord!.setPresence(
                        busy ? "dnd" : "online",
                        busy ? "Writing code" : "Waiting for commands"
                    );
                }
            } catch { }
        }, 2000);
    }

    // ── Message handling ─────────────────────────────────

    private async handleMessage(msg: DiscordMessage): Promise<void> {
        // Dedup gate (single layer)
        if (this.processedIds.has(msg.messageId)) {
            this.log.appendLine(`[Extension] Skipping duplicate ${msg.messageId}`);
            return;
        }
        this.processedIds.add(msg.messageId);
        setTimeout(() => this.processedIds.delete(msg.messageId), this.DEDUP_TTL);

        // Queue if busy
        if (this.state !== "idle") {
            if (this.queue.length >= this.MAX_QUEUE) {
                this.log.appendLine(`[Extension] Queue full, dropping from ${msg.author}`);
                if (this.discord?.isConnected()) {
                    await this.discord.sendMessage(
                        `⚠️ Coda piena (${this.MAX_QUEUE}). Riprova più tardi.`
                    );
                }
                return;
            }
            this.queue.push({ msg, enqueueTime: Date.now() });
            const pos = this.queue.length;
            this.log.appendLine(`[Extension] Queued from ${msg.author} (pos ${pos})`);
            if (this.discord?.isConnected()) {
                await this.discord.sendMessage(`⏳ In coda (pos ${pos}).`);
            }
            return;
        }

        await this.processMessage(msg);
    }

    private async processMessage(msg: DiscordMessage): Promise<void> {
        // Ensure CDP is connected
        if (!this.cdp?.isConnected()) {
            this.log.appendLine("[Extension] CDP not connected — reconnecting...");
            try { await this.connectCdp(); } catch { }
            if (!this.cdp?.isConnected()) {
                if (this.discord?.isConnected()) {
                    await this.discord.sendMessage(
                        `⚠️ Bridge non connesso. Avvia Antigravity con --remote-debugging-port=9000`
                    );
                    this.discord.setPresence("idle", "⚠️ CDP not connected");
                }
                return;
            }
        }

        this.state = "processing";
        this.lastBusyState = true;
        this.discord?.setPresence("dnd", "Writing code");

        this.log.appendLine(
            `[Extension] Processing from ${msg.author}` +
            `${msg.threadId ? ` (thread: ${msg.threadId})` : " (new conversation)"}: ` +
            `"${msg.content.substring(0, 80)}"`
        );

        this.panel.addMessage("user", msg.author, msg.content);
        this.panel.setTyping("assistant", true);

        let thread: import("discord.js").ThreadChannel | null = null;
        let typingInterval: ReturnType<typeof setInterval> | null = null;
        let statusMsg: import("discord.js").Message | null = null;
        let statusInterval: ReturnType<typeof setInterval> | null = null;
        let elapsedSec = 0;

        try {
            // ── Resolve thread ──

            if (msg.isMainChannel) {
                // New conversation
                const convName = await this.cdp!.createNewConversation();
                this.log.appendLine(`[Extension] New conversation: "${convName}"`);

                if (this.discord?.isConnected()) {
                    try {
                        thread = await this.discord.createThread(
                            msg.messageId,
                            `💬 ${msg.content.substring(0, 90)}`
                        );
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        // Another instance already created a thread → bail
                        if (errMsg.includes("already been created") || errMsg.includes("already has a thread")) {
                            this.log.appendLine("[Extension] ⚠️ Another instance handling — skipping");
                            return;
                        }
                        // Fallback: standalone thread
                        try {
                            thread = await this.discord.createConversationThread(
                                `💬 ${msg.content.substring(0, 90)}`
                            );
                        } catch { }
                    }
                    if (thread) {
                        this.conversationMap.set(thread.id, convName);
                    }
                }
            } else if (msg.threadId) {
                // Continue existing conversation
                const convName = this.conversationMap.get(msg.threadId);
                if (convName) {
                    await this.cdp!.switchConversation(convName);
                }
                if (this.discord?.isConnected()) {
                    thread = await this.discord.getThread(msg.threadId);
                }
            }

            // ── Typing indicator ──
            typingInterval = setInterval(() => {
                if (thread && this.discord?.isConnected()) {
                    this.discord.setTypingInThread(thread).catch(() => { });
                }
            }, 5000);

            vscode.window.setStatusBarMessage(
                `💬 Discord: ${msg.author} → "${msg.content.substring(0, 50)}..."`, 10000
            );

            // ── Inject message ──
            const preSnapshot = await this.cdp!.chatSnapshot();
            const sendResult = await this.cdp!.sendMessage(msg.content);
            if (!sendResult.ok) throw new Error(`Inject failed: ${sendResult.error}`);

            this.log.appendLine(`[CDP] Message injected (${sendResult.method})`);

            // Verify agent started — retry once if not
            let agentStarted = false;
            for (let i = 0; i < 6 && !agentStarted; i++) {
                await new Promise(r => setTimeout(r, 500));
                agentStarted = await this.cdp!.isBusy();
            }
            if (!agentStarted) {
                this.log.appendLine("[CDP] Agent didn't start — retrying send");
                await this.cdp!.sendMessage(msg.content);
            }

            // ── Status message in thread ──
            if (thread && this.discord?.isConnected()) {
                try {
                    const nonce = `${Date.now()}${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`;
                    statusMsg = await thread.send({
                        content: "⏳ Elaborazione in corso...",
                        nonce,
                        enforceNonce: true,
                    });
                } catch { }
            }

            statusInterval = setInterval(async () => {
                elapsedSec += 2;
                if (statusMsg) {
                    try { await statusMsg.edit(`⏳ Elaborazione in corso... (${elapsedSec}s)`); } catch { }
                }
            }, 2000);

            // ── Wait for response ──
            const response = await this.cdp!.waitForResponse(preSnapshot, msg.content);
            if (typingInterval) clearInterval(typingInterval);
            if (statusInterval) clearInterval(statusInterval);

            this.log.appendLine(`[CDP] Response extracted (${response.length} chars)`);

            if (statusMsg) {
                try { await statusMsg.edit(`✅ Completato (${elapsedSec}s)`); } catch { }
            }

            // ── Extract and clean response ──
            let discordResponse = response;
            try {
                const md = await this.cdp!.extractLastResponseMarkdown();
                if (md.length > 0) {
                    discordResponse = md;
                    this.log.appendLine(`[Extension] Using markdown (${md.length} chars)`);
                }
            } catch { }

            discordResponse = this.cleanResponse(discordResponse, msg.content);
            this.log.appendLine(`[Extension] Cleaned: ${discordResponse.length} chars`);

            // ── Send response to Discord ──
            if (thread && this.discord?.isConnected()) {
                // Thinking as spoiler
                try {
                    const thinking = await this.cdp!.extractThinkingContent();
                    if (thinking.length > 0) {
                        const maxChunk = 1990;
                        for (let i = 0; i < thinking.length; i += maxChunk) {
                            await this.discord.sendToThread(thread, `💭 ||${thinking.substring(i, i + maxChunk)}||`);
                        }
                    }
                } catch { }

                // Final response
                if (discordResponse.length > 0 && !isMcpNoise(discordResponse)) {
                    await this.discord.sendToThread(thread, discordResponse);
                    this.log.appendLine(`[Extension] ✅ Sent to thread (${discordResponse.length} chars)`);
                } else if (discordResponse.length === 0) {
                    await this.discord.sendToThread(thread, "⚠️ Nessuna risposta rilevata");
                }
            } else if (this.discord?.isConnected()) {
                if (discordResponse.length > 0 && !isMcpNoise(discordResponse)) {
                    await this.discord.sendMessage(discordResponse);
                }
            }

            // WebView
            this.panel.setTyping("assistant", false);
            this.panel.addMessage("assistant", "Antigravity", discordResponse);

            // Update conversation name if it was renamed
            if (thread && msg.isMainChannel) {
                try {
                    const updatedName = await this.cdp!.getCurrentConversationName();
                    const oldName = this.conversationMap.get(thread.id);
                    if (updatedName && updatedName !== oldName) {
                        this.conversationMap.set(thread.id, updatedName);
                        this.log.appendLine(`[Extension] Conversation renamed: "${oldName}" → "${updatedName}"`);
                    }
                } catch { }
            }

            vscode.window.setStatusBarMessage(`✅ Discord: risposta inviata a ${msg.author}`, 5000);

        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            this.log.appendLine(`[Extension] Error: ${errorMsg}`);
            this.panel.setTyping("assistant", false);

            if (typingInterval) clearInterval(typingInterval);
            if (statusInterval) clearInterval(statusInterval);

            if (thread && this.discord?.isConnected()) {
                await this.discord.sendToThread(thread, `⚠️ Errore: ${errorMsg}`).catch(() => { });
            } else if (this.discord?.isConnected()) {
                await this.discord.sendMessage(`⚠️ Errore: ${errorMsg}`).catch(() => { });
            }
        } finally {
            this.state = "idle";
            this.lastBusyState = false;
            this.discord?.setPresence("online", "Waiting for commands");
            this.pushStatus();

            // Process next queued message
            if (this.queue.length > 0) {
                const next = this.queue.shift()!;
                this.log.appendLine(`[Extension] Dequeuing from ${next.msg.author} (${this.queue.length} left)`);
                this.processMessage(next.msg).catch(err => {
                    this.log.appendLine(`[Extension] Queue error: ${err}`);
                });
            }
        }
    }

    // ── Response cleaning ────────────────────────────────

    private cleanResponse(text: string, userMessage: string): string {
        return text
            .split("\n")
            .filter(line => {
                const trimmed = line.trim();
                if (trimmed.length === 0) return true;
                if (isNoiseLine(trimmed)) return false;
                if (trimmed === userMessage.trim()) return false;
                if (/^Simple request/i.test(trimmed)) return false;
                return true;
            })
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    private pushStatus(): void {
        this.panel.updateStatus({
            discord: this.discord?.isConnected() ?? false,
            cdp: this.cdp?.isConnected() ?? false,
            autoAccept: this.cdp?.isAutoAcceptRunning() ?? false,
        });
    }
}

// ── VS Code Extension Entry Points ──────────────────────

let controller: BridgeController | null = null;

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel("Antigravity Discord");

    // Leader election: only one extension host connects to Discord
    if (!tryBecomeLeader(context)) {
        // May be stale from extension host reload — wait briefly and retry
        outputChannel.appendLine(
            `[Extension] [PID=${process.pid}] Leader election deferred — retrying in 2s...`
        );
        await new Promise(r => setTimeout(r, 2000));
        if (!tryBecomeLeader(context)) {
            outputChannel.appendLine(
                `[Extension] [PID=${process.pid}] Another instance is the leader — skipping Discord connection`
            );
            outputChannel.show(true);
            return;
        }
    }

    outputChannel.appendLine(`[Extension] [PID=${process.pid}] Elected as leader`);

    controller = new BridgeController(context);
    controller.start().catch(err => {
        outputChannel.appendLine(`[Extension] Start failed: ${err}`);
        outputChannel.show(true);
    });
}

export function deactivate() {
    const p = controller?.stop();
    controller = null;
    return p;
}
