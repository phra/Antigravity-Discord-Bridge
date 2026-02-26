import WebSocket from "ws";
import http from "http";
import * as vscode from "vscode";
import { isNoiseLine } from "./utils";

/** Result from a CDP Runtime.evaluate call */
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
 * Connects to the debugging port, finds the chat editor in the UI,
 * and provides methods to inject messages and read responses.
 */
export class CdpBridge {
    private ws: WebSocket | null = null;
    private contextId: number | null = null;
    private allContextIds: number[] = [];
    private idCounter = 1;
    private port: number;
    private outputChannel: vscode.OutputChannel;
    private connected = false;

    constructor(port: number, outputChannel: vscode.OutputChannel) {
        this.port = port;
        this.outputChannel = outputChannel;
    }

    isConnected(): boolean {
        return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Connect to the Antigravity debugging target.
     * Tries ALL available CDP targets (not just the first workbench match)
     * because the chat editor may live in a webview with a different target.
     */
    async connect(): Promise<void> {
        const targets = await this.getTargets();

        // Log ALL targets for diagnostics
        this.outputChannel.appendLine(`[CDP] Found ${targets.length} targets:`);
        for (const t of targets) {
            this.outputChannel.appendLine(
                `[CDP]   - "${t.title}" type=${t.type} url=${t.url?.substring(0, 120)}`
            );
        }

        if (targets.length === 0) {
            throw new Error(
                `No CDP targets found on port ${this.port}. ` +
                `Is Antigravity started with --remote-debugging-port=${this.port}?`
            );
        }

        // Prioritize targets: workbench first, then others (webviews, etc.)
        const sorted = [...targets].sort((a, b) => {
            const aWork = a.url?.includes("workbench") || a.title?.toLowerCase().includes("workbench") ? 0 : 1;
            const bWork = b.url?.includes("workbench") || b.title?.toLowerCase().includes("workbench") ? 0 : 1;
            return aWork - bWork;
        });

        // 1. Try every target, searching all its execution contexts for the chat editor
        const MAX_RETRIES = 10;
        const RETRY_INTERVAL_MS = 3000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            for (const target of sorted) {
                if (!target.webSocketDebuggerUrl) continue;

                let ws: WebSocket | null = null;
                let tempIdCounter = 1;

                try {
                    // Connect to this target
                    ws = new WebSocket(target.webSocketDebuggerUrl);
                    await new Promise<void>((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
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

                    if (attempt === 1) {
                        this.outputChannel.appendLine(
                            `[CDP] Target "${target.title}": ${contexts.length} contexts`
                        );
                        for (const ctx of contexts) {
                            this.outputChannel.appendLine(
                                `[CDP]   Context ${ctx.id}: name="${ctx.name}" origin="${ctx.origin}"`
                            );
                        }
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
                                            if (data.error) {
                                                reject(new Error(data.error.message));
                                            } else if (data.result?.exceptionDetails) {
                                                reject(new Error(data.result.exceptionDetails.text));
                                            } else {
                                                resolve(data.result?.result?.value);
                                            }
                                        }
                                    } catch { }
                                };
                                ws!.on("message", handler);
                                ws!.send(JSON.stringify({
                                    id,
                                    method: "Runtime.evaluate",
                                    params: {
                                        expression: `(() => {
                                            // Primary: Lexical editor inside #cascade
                                            const lexical = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                                                .filter(el => el.offsetParent !== null);
                                            if (lexical.length > 0) return { found: true, method: 'lexical-cascade' };

                                            // Fallback 1: Lexical editor anywhere
                                            const anyLexical = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                                                .filter(el => el.offsetParent !== null);
                                            if (anyLexical.length > 0) return { found: true, method: 'lexical-any' };

                                            // Fallback 2: Any contenteditable textbox
                                            const anyEditable = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
                                                .filter(el => el.offsetParent !== null);
                                            if (anyEditable.length > 0) return { found: true, method: 'contenteditable-textbox' };

                                            return {
                                                found: false,
                                                hasCascade: !!document.getElementById('cascade'),
                                                lexicalCount: document.querySelectorAll('[data-lexical-editor="true"]').length,
                                                editableCount: document.querySelectorAll('[contenteditable="true"]').length,
                                                textboxCount: document.querySelectorAll('[role="textbox"]').length,
                                                bodyLen: document.body?.innerHTML?.length || 0,
                                                title: document.title || ''
                                            };
                                        })()`,
                                        returnByValue: true,
                                        contextId: ctx.id,
                                    },
                                }));
                            });

                            const r = evalResult as {
                                found?: boolean;
                                method?: string;
                                hasCascade?: boolean;
                                lexicalCount?: number;
                                editableCount?: number;
                                textboxCount?: number;
                                bodyLen?: number;
                                title?: string;
                            } | null;

                            if (r?.found) {
                                // Found the editor! Adopt this WebSocket as our connection.
                                this.ws = ws;
                                this.contextId = ctx.id;
                                // Save ALL context IDs on this target for auto-accept injection
                                this.allContextIds = contexts.map(c => c.id);
                                this.idCounter = tempIdCounter;
                                this.outputChannel.appendLine(
                                    `[CDP] ✓ Found chat editor in target "${target.title}" ` +
                                    `context ${ctx.id} (${ctx.name || ctx.origin}) via ${r.method} [attempt ${attempt}]`
                                );
                                this.outputChannel.appendLine(
                                    `[CDP]   All contexts saved for auto-accept: [${this.allContextIds.join(', ')}]`
                                );
                                // Don't close this ws — we're keeping it
                                ws = null;
                                break;
                            } else if (r && attempt === 1) {
                                this.outputChannel.appendLine(
                                    `[CDP]   Context ${ctx.id} diagnostics: cascade=${r.hasCascade}, lexical=${r.lexicalCount}, editable=${r.editableCount}, textbox=${r.textboxCount}, bodyLen=${r.bodyLen}, title="${r.title}"`
                                );
                            }
                        } catch (err) {
                            if (attempt === 1) {
                                this.outputChannel.appendLine(
                                    `[CDP]   Context ${ctx.id} eval error: ${err instanceof Error ? err.message : String(err)}`
                                );
                            }
                        }
                    }
                } catch (err) {
                    if (attempt === 1) {
                        this.outputChannel.appendLine(
                            `[CDP]   Target "${target.title}" connect error: ${err instanceof Error ? err.message : String(err)}`
                        );
                    }
                } finally {
                    // Close the ws if we didn't adopt it
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.terminate();
                    }
                }

                if (this.contextId !== null) break;
            }

            if (this.contextId !== null) break;

            if (attempt < MAX_RETRIES) {
                this.outputChannel.appendLine(
                    `[CDP] Chat editor not found yet (attempt ${attempt}/${MAX_RETRIES}). ` +
                    `Retrying in ${RETRY_INTERVAL_MS / 1000}s... Open a chat in Antigravity if not already open.`
                );
                await this.sleep(RETRY_INTERVAL_MS);

                // Re-fetch targets on retry — new webviews may appear
                const freshTargets = await this.getTargets();
                sorted.length = 0;
                sorted.push(...[...freshTargets].sort((a, b) => {
                    const aWork = a.url?.includes("workbench") || a.title?.toLowerCase().includes("workbench") ? 0 : 1;
                    const bWork = b.url?.includes("workbench") || b.title?.toLowerCase().includes("workbench") ? 0 : 1;
                    return aWork - bWork;
                }));
            }
        }

        if (this.contextId === null || this.ws === null) {
            throw new Error(
                "Could not find the Antigravity chat editor in any CDP target or context. " +
                "Make sure a chat tab is open in Antigravity (not the Walkthrough page)."
            );
        }

        this.connected = true;
        this.outputChannel.appendLine("[CDP] Connected and ready");

        // Handle disconnection
        this.ws.on("close", () => {
            this.connected = false;
            this.outputChannel.appendLine("[CDP] Connection closed");
        });
    }

    /**
     * Disconnect from CDP.
     */
    disconnect(): void {
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
        this.connected = false;
        this.contextId = null;
    }

    /**
     * Check if the agent is currently busy (cancel button visible).
     */
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
     * Discover the DOM structure of the chat UI for debugging.
     * Returns a diagnostic object with info about what elements exist.
     */
    async discoverDom(): Promise<string> {
        const result = await this.evaluate(
            `(() => {
                const info = {};

                // Check key containers
                info.hasCascade = !!document.getElementById('cascade');
                info.title = document.title;

                // Find all buttons and their labels (no visibility filter — diagnostics)
                const buttons = [...document.querySelectorAll('button')]
                    .map(b => ({
                        text: (b.textContent || '').trim().substring(0, 50),
                        ariaLabel: b.getAttribute('aria-label') || '',
                        classes: b.className.substring(0, 80),
                        disabled: b.disabled,
                        visible: b.offsetParent !== null || b.getClientRects().length > 0,
                        hasSvg: b.querySelector('svg') ? b.querySelector('svg').className?.baseVal || 'svg' : null
                    }));
                info.buttons = buttons.slice(-25); // last 25 buttons

                // Find all contenteditable elements (no visibility filter — diagnostics)
                const editables = [...document.querySelectorAll('[contenteditable="true"]')]
                    .map(e => ({
                        tag: e.tagName,
                        role: e.getAttribute('role'),
                        lexical: e.getAttribute('data-lexical-editor'),
                        classes: e.className.substring(0, 80),
                        textLen: (e.textContent || '').length,
                        visible: e.offsetParent !== null || e.getClientRects().length > 0,
                        parentId: e.parentElement?.id || '',
                        parentClass: (e.parentElement?.className || '').substring(0, 80),
                        grandparentId: e.parentElement?.parentElement?.id || '',
                    }));
                info.editables = editables;

                // Find SVGs with specific classes (for submit button)
                const svgs = [...document.querySelectorAll('svg')]
                    .filter(s => s.offsetParent !== null)
                    .map(s => ({
                        classes: s.className?.baseVal || '',
                        parentTag: s.parentElement?.tagName || '',
                        parentAriaLabel: s.parentElement?.getAttribute('aria-label') || ''
                    }))
                    .filter(s => s.classes.includes('lucide') || s.parentAriaLabel);
                info.svgs = svgs.slice(-10);

                return info;
            })()`,
            this.contextId!
        );

        return JSON.stringify(result, null, 2);
    }

    /**
     * Snapshot the entire visible page text.
     * Used for before/after diffing to extract the agent's response.
     * Uses innerText (respects CSS visibility) to avoid hidden elements.
     */
    async chatSnapshot(): Promise<{ count: number; lastText: string }> {
        const result = await this.evaluate(
            `(() => {
                // Scope to the chat conversation container only, NOT the full workbench.
                // This avoids capturing Output Channel, file explorer, status bar, etc.
                const chatContainer = document.querySelector('#cascade')
                    || document.querySelector('[class*="chat-message"]')?.closest('[class*="scroll"]')
                    || document.querySelector('[role="log"]')
                    || document.querySelector('[class*="conversation"]');
                const source = chatContainer || document.body;
                const text = source?.innerText || '';
                const lines = text.split('\\n').filter(l => l.trim().length > 0);
                return {
                    count: lines.length,
                    lastText: text,
                    len: text.length
                };
            })()`,
            this.contextId!
        );

        const r = result as { count: number; lastText: string } | null;
        return r || { count: 0, lastText: "" };
    }

    /**
     * Discover the message DOM structure for debugging.
     * Returns detailed info about what's in the chat area.
     */
    async discoverMessages(): Promise<string> {
        const result = await this.evaluate(
            `(() => {
                // Dump the innerText of the page, truncated
                const bodyText = (document.body?.innerText || '').substring(0, 3000);

                // Try to find what changed — look for large text containers
                const divs = [...document.querySelectorAll('div, section, main')]
                    .filter(el => {
                        const text = el.innerText || '';
                        return text.length > 100 && text.length < 10000;
                    })
                    .map(el => ({
                        tag: el.tagName,
                        id: el.id,
                        classes: (el.className || '').substring(0, 60),
                        textLen: (el.innerText || '').length,
                        childCount: el.children.length,
                        scrollH: el.scrollHeight,
                        preview: (el.innerText || '').substring(0, 200)
                    }))
                    .sort((a, b) => b.textLen - a.textLen)
                    .slice(0, 10);

                return { divs, bodyTextLen: bodyText.length, bodyPreview: bodyText.substring(0, 500) };
            })()`,
            this.contextId!
        );

        return JSON.stringify(result, null, 2);
    }

    /**
     * Inject a message into the chat editor and submit it.
     * Uses the same technique as ag_bridge's poke.mjs.
     */
    async sendMessage(text: string): Promise<{ ok: boolean; error?: string; method?: string }> {
        // Step 1: Check busy + inject text (synchronous, no awaitPromise)
        const injectResult = await this.evaluate(
            `(() => {
                const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                if (cancel && cancel.offsetParent !== null) {
                    return { ok: false, error: "agent_busy" };
                }

                function findEditor() {
                    let editors = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                        .filter(el => el.offsetParent !== null || el.getClientRects().length > 0);
                    if (editors.length > 0) return editors.at(-1);

                    editors = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                        .filter(el => el.offsetParent !== null || el.getClientRects().length > 0);
                    if (editors.length > 0) return editors.at(-1);

                    editors = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
                        .filter(el => el.offsetParent !== null || el.getClientRects().length > 0);
                    if (editors.length > 0) return editors.at(-1);

                    editors = [...document.querySelectorAll('[contenteditable="true"]')]
                        .filter(el => (el.offsetParent !== null || el.getClientRects().length > 0) && el.tagName !== 'BODY');
                    if (editors.length > 0) return editors.at(-1);

                    return null;
                }

                const editor = findEditor();
                if (!editor) return { ok: false, error: "editor_not_found" };

                editor.focus();
                document.execCommand("selectAll", false, null);
                document.execCommand("delete", false, null);

                let inserted = false;
                try {
                    inserted = !!document.execCommand("insertText", false, ${JSON.stringify(text)});
                } catch {}

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
            false // synchronous, no awaitPromise
        );

        const injectRes = injectResult as { ok: boolean; error?: string } | null;
        if (!injectRes?.ok) {
            return { ok: false, error: injectRes?.error || "inject_failed" };
        }

        // Step 2: Wait briefly for DOM update, then click submit
        await this.sleep(300);

        const submitResult = await this.evaluate(
            `(() => {
                // Try multiple submit button selectors
                const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button")
                    || document.querySelector('[data-testid="send-button"]')
                    || document.querySelector('button[aria-label*="send" i]')
                    || document.querySelector('button[aria-label*="invia" i]');

                if (submit && !submit.disabled) {
                    submit.click();
                    return { ok: true, method: "click_submit" };
                }

                // Enter fallback — find the editor again and send Enter
                const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')
                    || document.querySelector('[contenteditable="true"][role="textbox"]');

                if (editor) {
                    editor.dispatchEvent(new KeyboardEvent("keydown", {
                        bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13
                    }));
                    editor.dispatchEvent(new KeyboardEvent("keypress", {
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

    /**
     * Wait for the agent to finish responding, then extract the response.
     * Takes a pre-snapshot to diff against.
     */
    async waitForResponse(
        preSnapshot: { count: number; lastText: string },
        userMessage: string,
        onStreamChunk?: (chunk: string) => Promise<void>,
    ): Promise<string> {
        // Phase 1: Wait for agent to start (become busy) — max 30s
        let started = false;
        for (let i = 0; i < 60 && !started; i++) {
            await this.sleep(500);
            started = await this.isBusy();
        }

        if (!started) {
            this.outputChannel.appendLine(
                "[CDP] Agent never became busy — checking for response anyway"
            );
        } else {
            this.outputChannel.appendLine("[CDP] Agent is processing...");
        }

        // Phase 2: Wait for agent to finish (no longer busy) — NO TIMEOUT
        // During this phase, periodically diff and stream new text via callback
        let elapsed = 0;
        let lastStreamedText = preSnapshot.lastText;
        const preLines = new Set(
            preSnapshot.lastText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
        );
        let allStreamedChunks: string[] = [];

        while (true) {
            const busy = await this.isBusy();
            if (!busy && started) {
                // Agent finished — wait for DOM to settle
                await this.sleep(1500);
                this.outputChannel.appendLine("[CDP] Agent finished processing");
                break;
            }

            // Also check if a new response appeared (even without busy detection)
            if (!started && elapsed > 5000) {
                const snap = await this.chatSnapshot();
                if (snap.lastText !== preSnapshot.lastText) {
                    this.outputChannel.appendLine("[CDP] New response detected via snapshot");
                    await this.sleep(1000);
                    break;
                }
            }

            // Stream new text to callback every 3 seconds (if callback provided)
            if (onStreamChunk && elapsed > 0 && elapsed % 3000 === 0) {
                try {
                    const currentSnap = await this.chatSnapshot();
                    const currentLines = currentSnap.lastText
                        .split('\n')
                        .map(l => l.trim())
                        .filter(l => l.length > 0);

                    // Find lines not in the original pre-snapshot
                    const newLines = currentLines.filter(l => !preLines.has(l));
                    const newText = newLines.join('\n').trim();

                    // Only send if there's genuinely new content since last stream
                    if (newText.length > 0 && newText !== allStreamedChunks.join('\n').trim()) {
                        // Find what's actually new since last stream
                        const lastSet = new Set(allStreamedChunks);
                        const freshLines = newLines.filter(l => !lastSet.has(l));
                        const freshText = freshLines.join('\n').trim();

                        if (freshText.length > 0) {
                            await onStreamChunk(freshText);
                            allStreamedChunks.push(...freshLines);
                        }
                    }
                } catch (err) {
                    // Don't let streaming errors break the wait loop
                    this.outputChannel.appendLine(
                        `[CDP] Stream chunk error: ${err instanceof Error ? err.message : String(err)}`
                    );
                }
            }

            await this.sleep(1000);
            elapsed += 1000;

            // Log progress every 30s
            if (elapsed % 30000 === 0) {
                this.outputChannel.appendLine(
                    `[CDP] Still waiting for agent response (${Math.round(elapsed / 1000)}s elapsed)...`
                );
            }
        }

        // Extract the response by diffing page text before/after
        const postSnapshot = await this.chatSnapshot();

        this.outputChannel.appendLine(
            `[CDP] Post-snapshot: ${postSnapshot.count} lines (${(postSnapshot.lastText || '').length} chars)`
        );

        // Compute text diff: lines in "after" that are NOT in "before"
        const newLines = postSnapshot.lastText
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0 && !preLines.has(l));

        // Filter out noise: debug metadata, CDP logs, JSON-like diagnostics
        const filtered = newLines.filter(line => {
            if (line.length < 3) return false;
            if (line === userMessage?.trim()) return false;
            if (isNoiseLine(line)) return false;
            return true;
        });

        const fullResponse = filtered.join('\n').trim();

        this.outputChannel.appendLine(
            `[CDP] Diff result: ${newLines.length} new lines → ${filtered.length} after filtering (${fullResponse.length} chars)`
        );

        // If we streamed chunks, return only the non-streamed portion (final answer)
        if (allStreamedChunks.length > 0) {
            const streamedSet = new Set(allStreamedChunks);
            const nonStreamedLines = filtered.filter(l => !streamedSet.has(l));
            const finalAnswer = nonStreamedLines.join('\n').trim();

            this.outputChannel.appendLine(
                `[CDP] Streamed ${allStreamedChunks.length} lines, final answer: ${finalAnswer.length} chars`
            );
            return finalAnswer;
        }

        if (fullResponse.length > 0) {
            return fullResponse;
        }

        this.outputChannel.appendLine("[CDP] Diff produced no result — returning empty");
        return "";
    }

    /**
     * Extract the last assistant response as Discord-compatible markdown.
     * Finds the last message container in the chat, gets its HTML,
     * and converts it to markdown preserving code blocks, bold, italic, etc.
     * Returns empty string if no response is found.
     */
    async extractLastResponseMarkdown(): Promise<string> {
        if (!this.isConnected()) return "";

        const result = await this.evaluate(
            `(() => {
                // ── Lightweight HTML → Discord markdown ──
                function htmlToMarkdown(el) {
                    let md = '';
                    for (const node of el.childNodes) {
                        if (node.nodeType === Node.TEXT_NODE) {
                            md += node.textContent;
                            continue;
                        }
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;
                        const tag = node.tagName;

                        // Code blocks (pre > code)
                        if (tag === 'PRE') {
                            const code = node.querySelector('code');
                            const text = (code || node).textContent || '';
                            // Try to detect language from class
                            const langClass = (code?.className || '').match(/language-(\\w+)/);
                            const lang = langClass ? langClass[1] : '';
                            md += '\\n\\\`\\\`\\\`' + lang + '\\n' + text.trimEnd() + '\\n\\\`\\\`\\\`\\n';
                            continue;
                        }

                        // Inline code
                        if (tag === 'CODE') {
                            md += '\\\`' + (node.textContent || '') + '\\\`';
                            continue;
                        }

                        // Bold
                        if (tag === 'STRONG' || tag === 'B') {
                            md += '**' + htmlToMarkdown(node) + '**';
                            continue;
                        }

                        // Italic
                        if (tag === 'EM' || tag === 'I') {
                            md += '*' + htmlToMarkdown(node) + '*';
                            continue;
                        }

                        // Headers
                        if (/^H[1-6]$/.test(tag)) {
                            const level = parseInt(tag[1]);
                            md += '\\n' + '#'.repeat(level) + ' ' + htmlToMarkdown(node) + '\\n';
                            continue;
                        }

                        // Lists
                        if (tag === 'UL' || tag === 'OL') {
                            const items = node.querySelectorAll(':scope > li');
                            items.forEach((li, i) => {
                                const prefix = tag === 'OL' ? (i+1) + '. ' : '- ';
                                md += prefix + htmlToMarkdown(li).trim() + '\\n';
                            });
                            md += '\\n';
                            continue;
                        }
                        if (tag === 'LI') {
                            md += htmlToMarkdown(node);
                            continue;
                        }

                        // Links
                        if (tag === 'A') {
                            const href = node.getAttribute('href') || '';
                            md += '[' + htmlToMarkdown(node) + '](' + href + ')';
                            continue;
                        }

                        // Paragraphs, divs — recurse + newline
                        if (tag === 'P' || tag === 'DIV') {
                            md += htmlToMarkdown(node) + '\\n';
                            continue;
                        }

                        // BR
                        if (tag === 'BR') {
                            md += '\\n';
                            continue;
                        }

                        // Blockquote
                        if (tag === 'BLOCKQUOTE') {
                            const lines = htmlToMarkdown(node).split('\\n');
                            md += lines.map(l => '> ' + l).join('\\n') + '\\n';
                            continue;
                        }

                        // HR
                        if (tag === 'HR') {
                            md += '\\n---\\n';
                            continue;
                        }

                        // Default: recurse
                        md += htmlToMarkdown(node);
                    }
                    return md;
                }

                // Find the chat container
                const chatContainer = document.querySelector('#cascade')
                    || document.querySelector('[class*="chat-message"]')?.closest('[class*="scroll"]')
                    || document.querySelector('[role="log"]')
                    || document.querySelector('[class*="conversation"]');
                if (!chatContainer) return '';

                // Try to find structured message containers
                // Look for the LAST message block that is an assistant response
                const allMsgBlocks = chatContainer.querySelectorAll(
                    '[class*="message"], [class*="response"], [class*="assistant"], [class*="reply"], [data-role="assistant"]'
                );

                // Try the last block first
                if (allMsgBlocks.length > 0) {
                    const lastBlock = allMsgBlocks[allMsgBlocks.length - 1];
                    const md = htmlToMarkdown(lastBlock);
                    if (md.trim().length > 0) return md.trim();
                }

                // Fallback: find the last large text block
                // Get all direct children and find the last one with substantial content
                const children = Array.from(chatContainer.children);
                for (let i = children.length - 1; i >= 0; i--) {
                    const child = children[i];
                    if ((child.textContent || '').trim().length > 20) {
                        const md = htmlToMarkdown(child);
                        if (md.trim().length > 20) return md.trim();
                    }
                }

                return '';
            })()`,
            this.contextId!
        );

        const md = (result as string) || "";

        // Clean up excessive newlines
        return md
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // ── Auto-accept ─────────────────────────────────────────

    private autoAcceptScript = `(() => {
        if (window.__autoAcceptInterval) return 'already_running';

        function findAllButtons(root) {
            let buttons = [];
            try {
                buttons = buttons.concat(Array.from(root.querySelectorAll('button')));
                const iframes = root.querySelectorAll('iframe');
                for (const iframe of iframes) {
                    try {
                        if (iframe.contentDocument) {
                            buttons = buttons.concat(findAllButtons(iframe.contentDocument));
                        }
                    } catch(e) {}
                }
                const allElements = root.querySelectorAll('*');
                for (const el of allElements) {
                    if (el.shadowRoot) {
                        buttons = buttons.concat(findAllButtons(el.shadowRoot));
                    }
                }
            } catch(e) {}
            return buttons;
        }

        function isAcceptButton(text) {
            // Antigravity-specific buttons
            if (text === 'Accept' || text === 'Run' || text === 'Always run') return true;
            if (text.startsWith('Accept')) return true;   // "Accept all", "Accept All Changes"
            if (text.startsWith('Run'))    return true;   // "Run Alt+↵", "Run All+1", "Run command"
            if (text.startsWith('Always run')) return true;
            if (text.startsWith('Always Allow')) return true;
            return false;
        }

        let scanCount = 0;
        window.__autoAcceptInterval = setInterval(() => {
            scanCount++;
            const buttons = findAllButtons(document);

            if (scanCount % 5 === 1) {
                const btnTexts = buttons.slice(0, 30).map(b => (b.textContent || '').trim().substring(0, 50));
                console.log('[AutoAccept] Scan #' + scanCount + ': ' + buttons.length + ' buttons. Sample: ' + JSON.stringify(btnTexts));
            }

            const acceptBtn = buttons.find(b => {
                const text = (b.textContent || '').trim();
                return isAcceptButton(text);
            });

            if (acceptBtn && !acceptBtn.disabled) {
                const text = (acceptBtn.textContent || '').trim();
                console.log('[AutoAccept] CLICKING: "' + text + '"');
                acceptBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
                acceptBtn.click();
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

    /**
     * Re-discover current execution contexts on our WebSocket connection.
     * Context IDs change as VS Code navigates/refreshes, so we can't rely
     * on the ones saved during connect().
     */
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

        // Disable then re-enable Runtime to trigger context notifications
        await this.call("Runtime.disable", {}).catch(() => { });
        await this.call("Runtime.enable", {}).catch(() => { });
        await this.sleep(300);

        this.ws!.off("message", listener);

        return contexts;
    }

    /**
     * Inject the auto-accept interval into ALL current execution contexts.
     * Re-discovers contexts fresh each time to avoid stale context IDs.
     */
    async startAutoAccept(): Promise<void> {
        if (!this.isConnected()) return;

        // Listen for console.log from the auto-accept script
        this.ws?.on("message", (raw: Buffer) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.method === "Runtime.consoleAPICalled" && data.params?.type === "log") {
                    const args = data.params.args || [];
                    const text = args.map((a: { value?: string }) => a.value || "").join(" ");
                    if (text.startsWith("[AutoAccept]")) {
                        this.outputChannel.appendLine(`[CDP] ${text}`);
                    }
                }
            } catch { }
        });

        // Discover FRESH context IDs
        const freshContexts = await this.discoverCurrentContexts();
        this.outputChannel.appendLine(
            `[CDP] Auto-accept: discovered ${freshContexts.length} fresh contexts: [${freshContexts.join(', ')}]`
        );

        // Inject into ALL discovered contexts
        const results: string[] = [];
        for (const ctxId of freshContexts) {
            try {
                const res = await this.evaluate(this.autoAcceptScript, ctxId, false);
                results.push(`ctx${ctxId}=${res}`);
            } catch (err) {
                results.push(`ctx${ctxId}=error`);
            }
        }

        this.outputChannel.appendLine(
            `[CDP] Auto-accept injection results: [${results.join(', ')}]`
        );
    }

    /**
     * Stop the auto-accept interval in ALL current execution contexts.
     */
    async stopAutoAccept(): Promise<void> {
        if (!this.isConnected()) return;

        const freshContexts = await this.discoverCurrentContexts();
        for (const ctxId of freshContexts) {
            try {
                await this.evaluate(this.autoAcceptStopScript, ctxId, false);
            } catch { }
        }

        this.outputChannel.appendLine("[CDP] Auto-accept stopped in all contexts");
    }

    // ── Private helpers ──────────────────────────────────────

    private getTargets(): Promise<CdpTarget[]> {
        return new Promise((resolve, reject) => {
            http.get(
                `http://127.0.0.1:${this.port}/json/list`,
                (res) => {
                    let data = "";
                    res.on("data", (chunk: Buffer) => (data += chunk));
                    res.on("end", () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch (e) {
                            reject(e);
                        }
                    });
                }
            ).on("error", reject);
        });
    }

    private call(
        method: string,
        params: Record<string, unknown>
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.ws) {
                reject(new Error("Not connected"));
                return;
            }
            const id = this.idCounter++;
            const handler = (msg: WebSocket.Data) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.id === id) {
                        this.ws?.off("message", handler);
                        if (data.error) {
                            reject(
                                new Error(
                                    data.error.message || JSON.stringify(data.error)
                                )
                            );
                        } else {
                            resolve(data.result);
                        }
                    }
                } catch { }
            };
            this.ws.on("message", handler);
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    private async evaluate(
        expression: string,
        contextId: number,
        awaitPromise: boolean = false
    ): Promise<unknown> {
        const result = (await this.call("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
            contextId,
        })) as EvalResult;

        if (result?.exceptionDetails) {
            throw new Error(
                `Eval error: ${result.exceptionDetails.text}`
            );
        }

        return result?.result?.value;
    }

    // isNoiseLine is now in utils.ts

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }
}
