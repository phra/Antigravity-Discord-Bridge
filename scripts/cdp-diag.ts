/**
 * CDP Button Diagnostic — connects to Antigravity's debug port and
 * enumerates ALL buttons across ALL targets and ALL contexts.
 * Run: npx tsx scripts/cdp-diag.ts
 */
import WebSocket from "ws";
import http from "http";

const PORT = 9000;

interface CdpTarget {
    id: string;
    title: string;
    url: string;
    type: string;
    webSocketDebuggerUrl?: string;
}

async function getTargets(): Promise<CdpTarget[]> {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(JSON.parse(data)));
            res.on("error", reject);
        }).on("error", reject);
    });
}

function cdpCall(ws: WebSocket, id: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 5000);
        const handler = (raw: WebSocket.Data) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.id === id) {
                    ws.off("message", handler);
                    clearTimeout(timeout);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.result);
                }
            } catch { }
        };
        ws.on("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
    console.log(`\n🔍 CDP Button Diagnostic — port ${PORT}\n`);

    const targets = await getTargets();
    console.log(`Found ${targets.length} targets:\n`);

    for (const target of targets) {
        console.log(`━━━ Target: "${target.title}" (${target.type}) ━━━`);
        console.log(`    URL: ${target.url?.substring(0, 100)}`);

        if (!target.webSocketDebuggerUrl) {
            console.log("    ⚠️  No WebSocket URL — skipping\n");
            continue;
        }

        let ws: WebSocket;
        try {
            ws = new WebSocket(target.webSocketDebuggerUrl);
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => reject(new Error("connect timeout")), 3000);
                ws.on("open", () => { clearTimeout(t); resolve(); });
                ws.on("error", (e) => { clearTimeout(t); reject(e); });
            });
        } catch (err) {
            console.log(`    ❌ Connection failed: ${err}\n`);
            continue;
        }

        let idCounter = 1;

        // Collect contexts
        const contexts: Array<{ id: number; name: string; origin: string }> = [];
        ws.on("message", (raw: WebSocket.Data) => {
            try {
                const data = JSON.parse(raw.toString());
                if (data.method === "Runtime.executionContextCreated") {
                    contexts.push(data.params.context);
                }
            } catch { }
        });

        await cdpCall(ws, idCounter++, "Runtime.enable");
        await new Promise(r => setTimeout(r, 500));

        console.log(`    ${contexts.length} execution contexts:\n`);

        for (const ctx of contexts) {
            console.log(`    📦 Context ${ctx.id}: name="${ctx.name}" origin="${ctx.origin}"`);

            try {
                const result = await cdpCall(ws, idCounter++, "Runtime.evaluate", {
                    expression: `(() => {
                        // Find all buttons in this context
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const btnData = buttons.map(b => ({
                            text: (b.textContent || '').trim().substring(0, 60),
                            disabled: b.disabled,
                            visible: b.offsetParent !== null,
                            tag: b.tagName,
                            classes: b.className?.substring(0, 60) || '',
                            id: b.id || '',
                        }));

                        // Also check iframes
                        const iframes = document.querySelectorAll('iframe');
                        let iframeButtonCount = 0;
                        for (const iframe of iframes) {
                            try {
                                if (iframe.contentDocument) {
                                    iframeButtonCount += iframe.contentDocument.querySelectorAll('button').length;
                                }
                            } catch(e) {}
                        }

                        // Check shadow DOMs
                        let shadowCount = 0;
                        const allEls = document.querySelectorAll('*');
                        for (const el of allEls) {
                            if (el.shadowRoot) shadowCount++;
                        }

                        return {
                            totalButtons: buttons.length,
                            iframeButtons: iframeButtonCount,
                            shadowRoots: shadowCount,
                            totalElements: allEls.length,
                            buttons: btnData.slice(0, 30),
                            title: document.title || '',
                            bodyLen: document.body?.innerHTML?.length || 0,
                        };
                    })()`,
                    returnByValue: true,
                    contextId: ctx.id,
                });

                const r = result?.result?.value;
                if (r) {
                    console.log(`       Elements: ${r.totalElements}, Buttons: ${r.totalButtons}, iframe btns: ${r.iframeButtons}, shadow roots: ${r.shadowRoots}`);
                    console.log(`       Title: "${r.title}", bodyLen: ${r.bodyLen}`);
                    if (r.buttons?.length > 0) {
                        console.log(`       Buttons found:`);
                        for (const btn of r.buttons) {
                            const vis = btn.visible ? '👁' : '🚫';
                            const dis = btn.disabled ? '⛔' : '✅';
                            console.log(`         ${vis} ${dis} "${btn.text}" id="${btn.id}" class="${btn.classes}"`);
                        }
                    }
                } else if (result?.exceptionDetails) {
                    console.log(`       ❌ Error: ${result.exceptionDetails.text}`);
                }
            } catch (err) {
                console.log(`       ❌ Eval error: ${err}`);
            }
            console.log();
        }

        ws.close();
    }

    console.log("✅ Diagnostic complete\n");
}

main().catch(console.error);
