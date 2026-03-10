import WebSocket from "ws";
import http from "http";
import type * as vscode from "vscode";
import { isNoiseLine } from "./utils.js";

/** CDP Runtime.evaluate result */
interface EvalResult {
    result?: { value?: unknown; type?: string; description?: string };
    exceptionDetails?: { text?: string };
}

/** CDP target from /json/list */
interface CdpTarget {
    id: string;
    title: string;
    url: string;
    type: string;
    webSocketDebuggerUrl?: string;
}

/**
 * Chrome DevTools Protocol bridge for Antigravity.
 *
 * Connects to the CDP debugging port, finds the chat editor,
 * and provides methods to inject messages and read responses.
 *
 * Prefers the Manager window (flat DOM, stable layout) over workbench targets.
 */
export class CdpBridge {
    private ws: WebSocket | null = null;
    private contextId: number | null = null;
    private allContextIds: number[] = [];
    private idCounter = 1;
    private port: number;
    private log: vscode.OutputChannel;
    private connected = false;
    private autoAcceptActive = false;

    constructor(port: number, outputChannel: vscode.OutputChannel) {
        this.port = port;
        this.log = outputChannel;
    }

    isConnected(): boolean {
        return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    isAutoAcceptRunning(): boolean {
        return this.autoAcceptActive;
    }

    // ── Connection ───────────────────────────────────────────

    /**
     * Connect to Antigravity via CDP.
     * Tries all available targets, preferring Manager window.
     * Retries up to 10 times waiting for the chat editor to appear.
     */
    async connect(): Promise<void> {
        const MAX_RETRIES = 10;
        const RETRY_MS = 3000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const targets = await this.getTargets();

            if (attempt === 1) {
                this.log.appendLine(`[CDP] Found ${targets.length} targets:`);
                for (const t of targets) {
                    this.log.appendLine(`[CDP]   "${t.title}" type=${t.type}`);
                }
            }

            if (targets.length === 0) {
                throw new Error(
                    `No CDP targets on port ${this.port}. ` +
                    `Start Antigravity with --remote-debugging-port=${this.port}`
                );
            }

            // Sort: Manager first, then workbench, then others
            const sorted = targets
                .filter(t => t.type !== "worker" && !t.title?.toLowerCase().includes("walkthrough"))
                .sort((a, b) => this.targetPriority(a) - this.targetPriority(b));

            // Try each target
            for (const target of sorted) {
                if (!target.webSocketDebuggerUrl) continue;

                const result = await this.probeTarget(target, attempt === 1);
                if (result) {
                    this.ws = result.ws;
                    this.contextId = result.contextId;
                    this.allContextIds = result.allContextIds;
                    this.connected = true;

                    this.log.appendLine(
                        `[CDP] ✓ Connected to "${target.title}" context ${result.contextId} ` +
                        `via ${result.method} [attempt ${attempt}]`
                    );

                    this.ws.on("close", () => {
                        this.connected = false;
                        this.log.appendLine("[CDP] Connection closed");
                    });

                    return;
                }
            }

            if (attempt < MAX_RETRIES) {
                this.log.appendLine(
                    `[CDP] Editor not found (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${RETRY_MS / 1000}s...`
                );
                await this.sleep(RETRY_MS);
            }
        }

        throw new Error(
            "Could not find Antigravity chat editor in any CDP target. " +
            "Make sure a chat tab is open."
        );
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.connected = false;
        this.contextId = null;
    }

    // ── Chat operations ──────────────────────────────────────

    /** Check if the agent is currently busy (cancel button visible). */
    async isBusy(): Promise<boolean> {
        const result = await this.evaluate(
            `(() => {
                const el = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                return !!el && el.offsetParent !== null;
            })()`,
            this.contextId!
        );
        return result === true;
    }

    /**
     * Inject a message into the chat editor and submit it.
     */
    async sendMessage(text: string): Promise<{ ok: boolean; error?: string; method?: string }> {
        // Step 1: Inject text into editor
        const injectResult = await this.evaluate(
            `(() => {
                const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                if (cancel && cancel.offsetParent !== null) {
                    return { ok: false, error: "agent_busy" };
                }

                // Find the chat editor (prefer spatial filter: after sidebar, x > 200)
                const editors = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                    .filter(el => {
                        if (el.offsetParent === null && el.getClientRects().length === 0) return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.x > 200;
                    });

                // Fallback: any visible lexical editor
                const editor = editors[0]
                    || [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                        .find(el => el.offsetParent !== null);

                if (!editor) return { ok: false, error: "editor_not_found" };

                editor.focus();
                document.execCommand("selectAll", false, null);
                document.execCommand("delete", false, null);

                let inserted = false;
                try { inserted = !!document.execCommand("insertText", false, ${JSON.stringify(text)}); } catch {}

                if (!inserted) {
                    editor.textContent = ${JSON.stringify(text)};
                    editor.dispatchEvent(new InputEvent("beforeinput", {
                        bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)}
                    }));
                    editor.dispatchEvent(new InputEvent("input", {
                        bubbles: true, inputType: "insertText", data: ${JSON.stringify(text)}
                    }));
                }
                return { ok: true, inserted };
            })()`,
            this.contextId!,
            false
        );

        const injectRes = injectResult as { ok: boolean; error?: string } | null;
        if (!injectRes?.ok) {
            return { ok: false, error: injectRes?.error || "inject_failed" };
        }

        // Step 2: Click submit button
        await this.sleep(300);

        const submitResult = await this.evaluate(
            `(() => {
                const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button")
                    || document.querySelector('[data-testid="send-button"]')
                    || document.querySelector('button[aria-label*="send" i]');

                if (submit && !submit.disabled) {
                    submit.click();
                    return { ok: true, method: "click_submit" };
                }

                // Enter fallback
                const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')
                    || document.querySelector('[contenteditable="true"][role="textbox"]');

                if (editor) {
                    editor.dispatchEvent(new KeyboardEvent("keydown", {
                        bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13
                    }));
                    editor.dispatchEvent(new KeyboardEvent("keyup", {
                        bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13
                    }));
                    return { ok: true, method: "enter_fallback" };
                }

                return { ok: false, error: "no_submit_or_editor" };
            })()`,
            this.contextId!,
            false
        );

        return (submitResult as { ok: boolean; error?: string; method?: string }) || {
            ok: false,
            error: "submit_eval_failed",
        };
    }

    /** Snapshot the visible page text for before/after diffing. */
    async chatSnapshot(): Promise<{ count: number; lastText: string }> {
        const result = await this.evaluate(
            `(() => {
                const scrollable = document.querySelector('.scrollbar-hide[class*="overflow-y-auto"]')
                    || document.querySelector('[class*="overflow-y-auto"][class*="min-h-0"]')
                    || document.querySelector('[role="log"]')
                    || document.body;
                const text = scrollable?.innerText || '';
                const lines = text.split('\\n').filter(l => l.trim().length > 0);
                return { count: lines.length, lastText: text };
            })()`,
            this.contextId!
        );

        return (result as { count: number; lastText: string }) || { count: 0, lastText: "" };
    }

    /**
     * Wait for the agent to finish responding, then extract the response.
     */
    async waitForResponse(
        preSnapshot: { count: number; lastText: string },
        userMessage: string,
    ): Promise<string> {
        const preLines = new Set(
            preSnapshot.lastText.split("\n").map(l => l.trim()).filter(l => l.length > 0)
        );

        // Phase 1: Wait for agent to start (become busy) — max 30s
        let started = false;
        for (let i = 0; i < 60 && !started; i++) {
            await this.sleep(500);
            started = await this.isBusy();
        }

        if (!started) {
            this.log.appendLine("[CDP] Agent never became busy — checking for response anyway");
        } else {
            this.log.appendLine("[CDP] Agent is processing...");
        }

        // Phase 2: Wait for agent to finish — no timeout
        let elapsed = 0;
        while (true) {
            const busy = await this.isBusy();
            if (!busy && started) {
                await this.sleep(1500); // Let DOM settle
                this.log.appendLine("[CDP] Agent finished processing");
                break;
            }

            // Fallback: detect response via snapshot diff (if agent never became busy)
            if (!started && elapsed > 5000) {
                const snap = await this.chatSnapshot();
                if (snap.lastText !== preSnapshot.lastText) {
                    this.log.appendLine("[CDP] New response detected via snapshot");
                    await this.sleep(1000);
                    break;
                }
            }

            await this.sleep(1000);
            elapsed += 1000;

            if (elapsed % 30000 === 0) {
                this.log.appendLine(`[CDP] Still waiting (${elapsed / 1000}s)...`);
            }
        }

        // Extract response by diffing page text
        const postSnapshot = await this.chatSnapshot();
        const newLines = postSnapshot.lastText
            .split("\n")
            .map(l => l.trim())
            .filter(l => l.length > 0 && !preLines.has(l));

        const filtered = newLines.filter(line => {
            if (line.length < 3) return false;
            if (line === userMessage?.trim()) return false;
            if (isNoiseLine(line)) return false;
            return true;
        });

        const response = filtered.join("\n").trim();
        this.log.appendLine(
            `[CDP] Diff: ${newLines.length} new → ${filtered.length} after filter (${response.length} chars)`
        );

        return response;
    }

    /**
     * Extract the last assistant response as markdown.
     */
    async extractLastResponseMarkdown(): Promise<string> {
        if (!this.isConnected()) return "";

        const script = `(() => { ${this.htmlToMarkdownScript}
            // Find conversation area
            const convArea = document.querySelector('.relative.flex.flex-col.gap-y-3');

            function isInsideThinking(el) {
                let p = el.parentElement;
                while (p) {
                    if ((p.className || '').includes('max-h-[')) return true;
                    p = p.parentElement;
                }
                return false;
            }

            function isInsideTaskBlock(el) {
                let p = el.parentElement;
                while (p) {
                    const cls = p.className || '';
                    if (cls.includes('isolate') && cls.includes('mb-2') && cls.includes('overflow-hidden')) return true;
                    p = p.parentElement;
                }
                return false;
            }

            if (convArea && convArea.children.length > 0) {
                const lastTurn = convArea.children[convArea.children.length - 1];
                const aiDivs = Array.from(lastTurn.querySelectorAll('div.leading-relaxed.select-text'))
                    .filter(el => el.offsetParent !== null && !isInsideThinking(el) && !isInsideTaskBlock(el));

                if (aiDivs.length > 0) {
                    return htmlToMarkdown(aiDivs[aiDivs.length - 1]).trim();
                }
            }

            // Fallback: global search
            const aiDivs = Array.from(document.querySelectorAll('div.leading-relaxed.select-text'))
                .filter(el => el.offsetParent !== null && !isInsideThinking(el) && !isInsideTaskBlock(el)
                    && (el.innerText || '').trim().length > 0);

            if (aiDivs.length > 0) {
                return htmlToMarkdown(aiDivs[aiDivs.length - 1]).trim();
            }

            return '';
        })()`;

        const result = await this.evaluate(script, this.contextId!);
        const md = (typeof result === "string" ? result : "") || "";
        return md.replace(/\n{3,}/g, "\n\n").trim();
    }

    /** Extract thinking/reasoning content from the last turn. */
    async extractThinkingContent(): Promise<string> {
        if (!this.isConnected()) return "";

        try {
            const result = await this.evaluate(
                `(() => {
                    const convArea = document.querySelector('.relative.flex.flex-col.gap-y-3');
                    if (!convArea || convArea.children.length === 0) return '';
                    const lastTurn = convArea.children[convArea.children.length - 1];
                    const container = lastTurn.querySelector('[class*="max-h-[200px]"]')
                        || lastTurn.querySelector('[class*="max-h-["]');
                    return container ? (container.innerText || '').trim() : '';
                })()`,
                this.contextId!
            );
            return (result as string) || "";
        } catch {
            return "";
        }
    }

    // ── Conversation management ──────────────────────────────

    /**
     * Create a new conversation in the Manager/chat UI.
     */
    async createNewConversation(): Promise<string> {
        if (!this.isConnected()) throw new Error("Not connected");

        const clickResult = await this.evaluate(
            `(() => {
                // Strategy 1: "Start new conversation" button
                const items = Array.from(document.querySelectorAll('div.cursor-pointer'));
                const btn = items.find(el => (el.textContent || '').includes('Start new conversation'));
                if (btn) { btn.click(); return { ok: true, method: 'start_new_conversation_btn' }; }

                // Strategy 2: Editor already visible
                const editors = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                    .filter(el => {
                        if (el.offsetParent === null && el.getClientRects().length === 0) return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.x > 200;
                    });
                if (editors.length > 0) return { ok: true, method: 'editor_already_visible' };

                // Strategy 3: +/New Chat button
                const allButtons = Array.from(document.querySelectorAll('button'));
                const newBtn = allButtons.find(b => {
                    const text = (b.textContent || '').trim().toLowerCase();
                    const aria = (b.getAttribute('aria-label') || '').toLowerCase();
                    return text === '+' || text === 'new chat' || text === 'nuova chat'
                        || aria.includes('new chat') || aria.includes('new conversation');
                });
                if (newBtn) { newBtn.click(); return { ok: true, method: 'new_chat_button' }; }

                // Strategy 4: Icon button (add, edit_square)
                const iconBtn = allButtons.find(b => {
                    const text = (b.textContent || '').trim();
                    return text === 'add' || text === 'add_circle' || text === 'edit_square';
                });
                if (iconBtn) { iconBtn.click(); return { ok: true, method: 'icon_button' }; }

                return { ok: false, error: 'no_new_conv_button' };
            })()`,
            this.contextId!
        );

        const r = clickResult as { ok: boolean; error?: string; method?: string };
        if (!r?.ok) throw new Error(`Failed to create conversation: ${r?.error}`);

        this.log.appendLine(`[CDP] New conversation via: ${r.method}`);

        if (r.method === "editor_already_visible") {
            return (await this.getCurrentConversationName()) || "New Chat";
        }

        // Wait for editor to appear
        for (let i = 0; i < 10; i++) {
            await this.sleep(500);
            const ready = await this.evaluate(
                `(() => {
                    const e = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]');
                    return !!(e && (e.offsetParent !== null || e.getClientRects().length > 0));
                })()`,
                this.contextId!
            );
            if (ready === true) break;
        }

        return (await this.getCurrentConversationName()) || "New Chat";
    }

    /** Switch to a conversation by name. */
    async switchConversation(name: string): Promise<boolean> {
        if (!this.isConnected()) return false;

        const result = await this.evaluate(
            `(() => {
                const convButtons = Array.from(document.querySelectorAll(
                    'button.select-none.cursor-pointer.rounded-md'
                )).filter(b => {
                    const r = b.getBoundingClientRect();
                    return r.x < 300 && r.width > 50;
                });

                const target = convButtons.find(b => (b.textContent || '').trim().includes(${JSON.stringify(name)}));
                if (!target) return { ok: false, error: 'not_found' };

                target.click();
                return { ok: true, clicked: (target.textContent || '').trim().substring(0, 80) };
            })()`,
            this.contextId!
        );

        const r = result as { ok: boolean; clicked?: string };
        if (r?.ok) {
            this.log.appendLine(`[CDP] Switched to: "${r.clicked}"`);
            await this.sleep(500);
            return true;
        }
        return false;
    }

    /** Get the current conversation name from the sidebar. */
    async getCurrentConversationName(): Promise<string> {
        if (!this.isConnected()) return "";

        const result = await this.evaluate(
            `(() => {
                const convButtons = Array.from(document.querySelectorAll(
                    'button.select-none.cursor-pointer.rounded-md'
                )).filter(b => {
                    const r = b.getBoundingClientRect();
                    return r.x < 300 && r.width > 50;
                });

                for (const btn of convButtons) {
                    const text = (btn.textContent || '').trim();
                    if (text.includes('progress_activity')) {
                        return text.replace('progress_activity', '').replace('more_vert', '')
                            .replace(/\\d+[hm]$/, '').replace(/now$/, '').trim();
                    }
                }

                if (convButtons.length > 0) {
                    return (convButtons[0].textContent || '').trim()
                        .replace('more_vert', '').replace(/\\d+[hm]$/, '').replace(/now$/, '').trim();
                }

                return '';
            })()`,
            this.contextId!
        );

        return (result as string) || "";
    }

    // ── Auto-accept ──────────────────────────────────────────

    async startAutoAccept(): Promise<void> {
        if (!this.isConnected()) return;

        // Listen for console.log from auto-accept script
        this.ws?.on("message", (raw: Buffer) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.method === "Runtime.consoleAPICalled" && data.params?.type === "log") {
                    const text = (data.params.args || []).map((a: { value?: string }) => a.value || "").join(" ");
                    if (text.startsWith("[AutoAccept]")) {
                        this.log.appendLine(`[CDP] ${text}`);
                    }
                }
            } catch { }
        });

        // Discover fresh contexts and inject
        const freshContexts = await this.discoverCurrentContexts();
        for (const ctxId of freshContexts) {
            try {
                await this.evaluate(this.autoAcceptScript, ctxId, false);
            } catch { }
        }

        this.log.appendLine(`[CDP] Auto-accept injected into ${freshContexts.length} contexts`);
        this.autoAcceptActive = true;
    }

    async stopAutoAccept(): Promise<void> {
        if (!this.isConnected()) return;
        const freshContexts = await this.discoverCurrentContexts();
        for (const ctxId of freshContexts) {
            try {
                await this.evaluate(this.autoAcceptStopScript, ctxId, false);
            } catch { }
        }
        this.autoAcceptActive = false;
    }

    // ── Private: target probing ──────────────────────────────

    private targetPriority(t: CdpTarget): number {
        if (t.title === "Manager") return 0;
        if (t.url?.includes("workbench") || t.title?.toLowerCase().includes("workbench")) return 1;
        return 2;
    }

    private async probeTarget(
        target: CdpTarget,
        logDiag: boolean
    ): Promise<{ ws: WebSocket; contextId: number; allContextIds: number[]; method: string } | null> {
        let ws: WebSocket | null = null;
        let tempIdCounter = 1;

        try {
            ws = new WebSocket(target.webSocketDebuggerUrl!);
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("ws timeout")), 5000);
                ws!.on("open", () => { clearTimeout(timeout); resolve(); });
                ws!.on("error", (e) => { clearTimeout(timeout); reject(e); });
            });

            // Discover execution contexts
            const contexts: Array<{ id: number; origin: string; name: string }> = [];
            ws.on("message", (msg: WebSocket.Data) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.method === "Runtime.executionContextCreated") {
                        contexts.push(data.params.context);
                    }
                } catch { }
            });

            // Enable Runtime
            await new Promise<void>((resolve, reject) => {
                const id = tempIdCounter++;
                const handler = (msg: WebSocket.Data) => {
                    try {
                        const data = JSON.parse(msg.toString());
                        if (data.id === id) {
                            ws!.off("message", handler);
                            data.error ? reject(new Error(data.error.message)) : resolve();
                        }
                    } catch { }
                };
                ws!.on("message", handler);
                ws!.send(JSON.stringify({ id, method: "Runtime.enable", params: {} }));
            });

            await this.sleep(500);

            if (logDiag) {
                this.log.appendLine(`[CDP] Target "${target.title}": ${contexts.length} contexts`);
            }

            // Search each context for the chat editor
            for (const ctx of contexts) {
                try {
                    const evalResult = await new Promise<unknown>((resolve, reject) => {
                        const id = tempIdCounter++;
                        const handler = (msg: WebSocket.Data) => {
                            try {
                                const data = JSON.parse(msg.toString());
                                if (data.id === id) {
                                    ws!.off("message", handler);
                                    if (data.error) reject(new Error(data.error.message));
                                    else if (data.result?.exceptionDetails) reject(new Error(data.result.exceptionDetails.text));
                                    else resolve(data.result?.result?.value);
                                }
                            } catch { }
                        };
                        ws!.on("message", handler);
                        ws!.send(JSON.stringify({
                            id,
                            method: "Runtime.evaluate",
                            params: {
                                expression: `(() => {
                                    const lexical = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                                        .filter(el => el.offsetParent !== null);
                                    if (lexical.length > 0) return { found: true, method: 'lexical' };

                                    const anyEditable = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
                                        .filter(el => el.offsetParent !== null);
                                    if (anyEditable.length > 0) return { found: true, method: 'contenteditable' };

                                    if (document.title === 'Manager') return { found: true, method: 'manager-no-chat' };

                                    return { found: false };
                                })()`,
                                returnByValue: true,
                                contextId: ctx.id,
                            },
                        }));
                    });

                    const r = evalResult as { found?: boolean; method?: string } | null;
                    if (r?.found) {
                        // Adopt this WebSocket
                        const result = {
                            ws: ws!,
                            contextId: ctx.id,
                            allContextIds: contexts.map(c => c.id),
                            method: r.method || "unknown",
                        };
                        this.idCounter = tempIdCounter;
                        ws = null; // Prevent cleanup
                        return result;
                    }
                } catch { }
            }
        } catch { } finally {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.terminate();
            }
        }

        return null;
    }

    // ── Private: auto-accept scripts ─────────────────────────

    private autoAcceptScript = `(() => {
        if (window.__autoAcceptInterval) return 'already_running';

        function findAllButtons(root) {
            let buttons = [];
            try {
                buttons = buttons.concat(Array.from(root.querySelectorAll('button')));
                for (const iframe of root.querySelectorAll('iframe')) {
                    try { if (iframe.contentDocument) buttons = buttons.concat(findAllButtons(iframe.contentDocument)); } catch {}
                }
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) buttons = buttons.concat(findAllButtons(el.shadowRoot));
                }
            } catch {}
            return buttons;
        }

        function isAcceptButton(text) {
            if (text === 'Always run' || text.startsWith('Always run')) return false;
            if (text === 'Accept' || text === 'Run') return true;
            if (text.startsWith('Accept')) return true;
            if (text.startsWith('Run')) return true;
            if (text.startsWith('Always Allow')) return true;
            return false;
        }

        let scanCount = 0;
        window.__autoAcceptInterval = setInterval(() => {
            scanCount++;
            const buttons = findAllButtons(document);

            if (scanCount % 20 === 1) {
                const texts = buttons.slice(0, 30).map(b => (b.textContent || '').trim().substring(0, 50));
                console.log('[AutoAccept] Scan #' + scanCount + ': ' + buttons.length + ' buttons. Sample: ' + JSON.stringify(texts));
            }

            const btn = buttons.find(b => {
                const text = (b.textContent || '').trim();
                return isAcceptButton(text);
            });

            if (btn && !btn.disabled) {
                console.log('[AutoAccept] CLICKING: "' + (btn.textContent || '').trim() + '"');
                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                btn.click();
            }
        }, 1500);

        return 'started';
    })()`;

    private autoAcceptStopScript = `(() => {
        if (window.__autoAcceptInterval) {
            clearInterval(window.__autoAcceptInterval);
            window.__autoAcceptInterval = null;
            return 'stopped';
        }
        return 'not_running';
    })()`;

    // ── Private: HTML to Markdown ────────────────────────────

    private htmlToMarkdownScript = [
        'const BT = String.fromCharCode(96);',
        'const FENCE = BT + BT + BT;',
        'const NL = String.fromCharCode(10);',
        'function htmlToMarkdown(el) {',
        '  let md = "";',
        '  for (const node of el.childNodes) {',
        '    if (node.nodeType === Node.TEXT_NODE) { md += node.textContent; continue; }',
        '    if (node.nodeType !== Node.ELEMENT_NODE) continue;',
        '    const tag = node.tagName;',
        '    if (tag==="STYLE"||tag==="SCRIPT"||tag==="LINK"||tag==="SVG"||tag==="NAV"||tag==="BUTTON"||tag==="IMG") continue;',
        '    if (tag === "PRE") {',
        '      const code = node.querySelector("code");',
        '      const src = code || node;',
        '      const lc = (code?.className || "").match(/language-(\\\\w+)/);',
        '      const lang = lc ? lc[1] : "";',
        '      const lines = src.querySelectorAll("[class*=code-line], .view-line");',
        '      let text;',
        '      if (lines.length > 0) {',
        '        text = Array.from(lines).map(l => l.textContent || "").join(NL);',
        '      } else {',
        '        const clone = src.cloneNode(true);',
        '        clone.querySelectorAll("style,script").forEach(s => s.remove());',
        '        text = clone.textContent || "";',
        '      }',
        '      md += NL + FENCE + lang + NL + text.trimEnd() + NL + FENCE + NL;',
        '      continue;',
        '    }',
        '    if (tag === "CODE") { md += BT + (node.textContent || "") + BT; continue; }',
        '    if (tag === "STRONG" || tag === "B") { md += "**" + htmlToMarkdown(node) + "**"; continue; }',
        '    if (tag === "EM" || tag === "I") { md += "*" + htmlToMarkdown(node) + "*"; continue; }',
        '    if (/^H[1-6]$/.test(tag)) { md += NL + "#".repeat(parseInt(tag[1])) + " " + htmlToMarkdown(node) + NL; continue; }',
        '    if (tag === "UL" || tag === "OL") {',
        '      node.querySelectorAll(":scope > li").forEach((li, i) => {',
        '        md += (tag === "OL" ? (i+1) + ". " : "- ") + htmlToMarkdown(li).trim() + NL;',
        '      }); md += NL; continue;',
        '    }',
        '    if (tag === "LI") { md += htmlToMarkdown(node); continue; }',
        '    if (tag === "A") { md += "[" + htmlToMarkdown(node) + "](" + (node.getAttribute("href")||"") + ")"; continue; }',
        '    if (tag === "P" || tag === "DIV") { md += htmlToMarkdown(node) + NL; continue; }',
        '    if (tag === "BR") { md += NL; continue; }',
        '    if (tag === "BLOCKQUOTE") { md += htmlToMarkdown(node).split(NL).map(l => "> " + l).join(NL) + NL; continue; }',
        '    if (tag === "HR") { md += NL + "---" + NL; continue; }',
        '    md += htmlToMarkdown(node);',
        '  }',
        '  return md;',
        '}',
    ].join('\n');

    // ── Private: helpers ─────────────────────────────────────

    private async discoverCurrentContexts(): Promise<number[]> {
        if (!this.isConnected()) return [];
        const contexts: number[] = [];
        const listener = (raw: WebSocket.Data) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.method === "Runtime.executionContextCreated") {
                    contexts.push(data.params.context.id);
                }
            } catch { }
        };
        this.ws!.on("message", listener);
        await this.call("Runtime.disable", {}).catch(() => { });
        await this.call("Runtime.enable", {}).catch(() => { });
        await this.sleep(300);
        this.ws!.off("message", listener);
        return contexts;
    }

    private getTargets(): Promise<CdpTarget[]> {
        return new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${this.port}/json/list`, (res) => {
                let data = "";
                res.on("data", (chunk: Buffer) => (data += chunk));
                res.on("end", () => {
                    try { resolve(JSON.parse(data)); }
                    catch (e) { reject(e); }
                });
            }).on("error", reject);
        });
    }

    private call(method: string, params: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.ws) { reject(new Error("Not connected")); return; }
            const id = this.idCounter++;
            const handler = (msg: WebSocket.Data) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.id === id) {
                        this.ws?.off("message", handler);
                        data.error ? reject(new Error(data.error.message || JSON.stringify(data.error))) : resolve(data.result);
                    }
                } catch { }
            };
            this.ws.on("message", handler);
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    private async evaluate(expression: string, contextId: number, awaitPromise = false): Promise<unknown> {
        const result = (await this.call("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
            contextId,
        })) as EvalResult;

        if (result?.exceptionDetails) {
            throw new Error(`Eval error: ${result.exceptionDetails.text}`);
        }

        return result?.result?.value;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}
