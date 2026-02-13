import WebSocket from "ws";
import http from "http";
import * as vscode from "vscode";

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
     */
    async connect(): Promise<void> {
        // 1. Find the workbench target
        const targets = await this.getTargets();
        const target = targets.find(
            (t) =>
                t.url?.includes("workbench") ||
                t.title?.toLowerCase().includes("workbench")
        );

        if (!target?.webSocketDebuggerUrl) {
            throw new Error(
                `No workbench target found on port ${this.port}. ` +
                `Is Antigravity started with --remote-debugging-port=${this.port}?`
            );
        }

        this.outputChannel.appendLine(
            `[CDP] Found target: ${target.title} (${target.url})`
        );

        // 2. Connect via WebSocket
        this.ws = new WebSocket(target.webSocketDebuggerUrl);

        await new Promise<void>((resolve, reject) => {
            this.ws!.on("open", resolve);
            this.ws!.on("error", reject);
        });

        // 3. Enable Runtime and discover contexts
        const contexts: Array<{ id: number; origin: string; name: string }> = [];
        this.ws.on("message", (msg: WebSocket.Data) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.method === "Runtime.executionContextCreated") {
                    contexts.push(data.params.context);
                }
            } catch { }
        });

        await this.call("Runtime.enable", {});
        // Wait for contexts to be discovered
        await this.sleep(500);

        this.outputChannel.appendLine(
            `[CDP] Found ${contexts.length} execution contexts`
        );

        // Log each context for debugging
        for (const ctx of contexts) {
            this.outputChannel.appendLine(
                `[CDP]   Context ${ctx.id}: name="${ctx.name}" origin="${ctx.origin}"`
            );
        }

        // 4. Find the context that has the chat editor — with retry logic
        //    The chat panel may not be open on startup (e.g., Walkthrough page shown)
        const MAX_RETRIES = 10;
        const RETRY_INTERVAL_MS = 3000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            for (const ctx of contexts) {
                try {
                    const result = await this.evaluate(
                        `(() => {
                            // Primary: Lexical editor inside #cascade
                            const lexical = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                                .filter(el => el.offsetParent !== null);
                            if (lexical.length > 0) return { found: true, method: 'lexical-cascade' };

                            // Fallback 1: Lexical editor anywhere
                            const anyLexical = [...document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
                                .filter(el => el.offsetParent !== null);
                            if (anyLexical.length > 0) return { found: true, method: 'lexical-any' };

                            // Fallback 2: Any contenteditable textbox (Antigravity may change DOM)
                            const anyEditable = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
                                .filter(el => el.offsetParent !== null);
                            if (anyEditable.length > 0) return { found: true, method: 'contenteditable-textbox' };

                            // Diagnostic info for debugging
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
                        ctx.id
                    );

                    const r = result as {
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
                        this.contextId = ctx.id;
                        this.outputChannel.appendLine(
                            `[CDP] Found chat context: ${ctx.id} (${ctx.name || ctx.origin}) via ${r.method} [attempt ${attempt}]`
                        );
                        break;
                    } else if (r && attempt === 1) {
                        // Log diagnostic info on first attempt only
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

            if (this.contextId !== null) {
                break;
            }

            if (attempt < MAX_RETRIES) {
                this.outputChannel.appendLine(
                    `[CDP] Chat editor not found yet (attempt ${attempt}/${MAX_RETRIES}). ` +
                    `Retrying in ${RETRY_INTERVAL_MS / 1000}s... Open a chat in Antigravity if not already open.`
                );
                await this.sleep(RETRY_INTERVAL_MS);
            }
        }

        if (this.contextId === null) {
            throw new Error(
                "Could not find the Antigravity chat editor in any execution context. " +
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
                const text = document.body?.innerText || '';
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

        // Filter out noise
        const filtered = newLines.filter(line => {
            if (line.length < 3) return false;
            if (line === userMessage?.trim()) return false;
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

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }
}
