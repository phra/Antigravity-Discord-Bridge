#!/usr/bin/env node
/**
 * WI-1 Diagnostic: Investigate Dual Extension Host Loading
 * 
 * This script connects to the Antigravity CDP debugging port and:
 * 1. Enumerates ALL CDP targets (windows, workers, webviews)
 * 2. Checks each target for extension host indicators
 * 3. Checks for the PID lock file
 * 4. Reports findings
 * 
 * Usage: node scripts/diagnose-dual-host.mjs [port]
 *   default port: 9000
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';

const PORT = parseInt(process.argv[2] || '9000', 10);
const LOCK_FILE = path.join(os.tmpdir(), 'antigravity-discord-connection.lock');

console.log('═══════════════════════════════════════════════════════════');
console.log('  WI-1 Diagnostic: Dual Extension Host Investigation');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  CDP Port: ${PORT}`);
console.log(`  Lock File: ${LOCK_FILE}`);
console.log('');

// ── Step 1: Check PID lock file ────────────────────────────
console.log('─── Step 1: PID Lock File ───');
try {
    if (fs.existsSync(LOCK_FILE)) {
        const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
        console.log(`  Lock file exists: PID=${pid}`);
        try {
            process.kill(parseInt(pid, 10), 0);
            console.log(`  ✅ PID ${pid} is ALIVE`);
        } catch {
            console.log(`  ⚠️ PID ${pid} is DEAD (stale lock)`);
        }
    } else {
        console.log('  No lock file found');
    }
} catch (err) {
    console.log(`  Error checking lock: ${err.message}`);
}
console.log('');

// ── Step 2: Enumerate CDP targets ─────────────────────────
console.log('─── Step 2: CDP Targets ───');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

try {
    const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
    console.log(`  Found ${targets.length} targets:\n`);

    // Categorize targets
    const categories = {
        managers: [],
        workbenches: [],
        workers: [],
        webviews: [],
        others: [],
    };

    for (const t of targets) {
        const info = {
            id: t.id,
            title: t.title || '(no title)',
            type: t.type || '(no type)',
            url: (t.url || '').substring(0, 150),
            hasWsUrl: !!t.webSocketDebuggerUrl,
        };

        if (t.title === 'Manager') categories.managers.push(info);
        else if (t.url?.includes('workbench') || t.title?.toLowerCase().includes('workbench')) categories.workbenches.push(info);
        else if (t.type === 'worker') categories.workers.push(info);
        else if (t.url?.includes('webview')) categories.webviews.push(info);
        else categories.others.push(info);
    }

    for (const [cat, items] of Object.entries(categories)) {
        if (items.length > 0) {
            console.log(`  [${cat.toUpperCase()}] (${items.length}):`);
            for (const item of items) {
                console.log(`    • "${item.title}" type=${item.type} ws=${item.hasWsUrl}`);
                console.log(`      url: ${item.url}`);
            }
            console.log('');
        }
    }

    // ── Step 3: Check each non-worker target for extension host indicators ──
    console.log('─── Step 3: Extension Host Detection ───');
    
    const nonWorkerTargets = targets.filter(t => t.type !== 'worker' && t.webSocketDebuggerUrl);
    
    for (const target of nonWorkerTargets) {
        console.log(`\n  Probing: "${target.title}" (${target.type})`);
        
        let ws;
        try {
            ws = new WebSocket(target.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('timeout')), 3000);
                ws.on('open', () => { clearTimeout(timeout); resolve(); });
                ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
            });

            // Collect execution contexts
            const contexts = [];
            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg.toString());
                    if (data.method === 'Runtime.executionContextCreated') {
                        contexts.push(data.params.context);
                    }
                } catch {}
            });

            // Enable Runtime
            await sendCdp(ws, 1, 'Runtime.enable', {});
            await sleep(500);

            console.log(`    Contexts: ${contexts.length}`);
            for (const ctx of contexts) {
                console.log(`      [${ctx.id}] name="${ctx.name}" origin="${ctx.origin}"`);
            }

            // Check each context for extension indicators
            for (const ctx of contexts) {
                try {
                    const result = await evalInContext(ws, ctx.id, `(() => {
                        const info = {};
                        info.title = document.title;
                        
                        // Check for extension host indicators
                        info.hasAntigravityExtension = typeof globalThis.__antigravityDiscord !== 'undefined';
                        
                        // Check for Discord client (discord.js creates WebSocket connections)
                        info.hasWebSockets = typeof WebSocket !== 'undefined';
                        
                        // Check for Lexical editors (chat UI)
                        info.lexicalEditors = document.querySelectorAll('[data-lexical-editor="true"]').length;
                        info.visibleLexicalEditors = [...document.querySelectorAll('[data-lexical-editor="true"]')]
                            .filter(el => el.offsetParent !== null).length;
                        
                        // Check for extension activation (vscode API)
                        info.hasVscodeApi = typeof acquireVsCodeApi !== 'undefined';
                        
                        // Check body size (proxy for loaded UI)
                        info.bodyLen = document.body?.innerHTML?.length || 0;
                        
                        // Check for conversation sidebar buttons
                        info.conversationButtons = document.querySelectorAll('button.select-none.cursor-pointer.rounded-md').length;
                        
                        // Check for "Start new conversation" button
                        info.hasNewConvButton = [...document.querySelectorAll('div.cursor-pointer')]
                            .some(el => (el.textContent || '').includes('Start new conversation'));
                        
                        return info;
                    })()`);
                    
                    if (result && (result.lexicalEditors > 0 || result.conversationButtons > 0 || result.hasNewConvButton)) {
                        console.log(`      🎯 Context ${ctx.id} has chat UI! ${JSON.stringify(result)}`);
                    }
                } catch (err) {
                    // Context eval failed — skip silently
                }
            }
        } catch (err) {
            console.log(`    Error: ${err.message}`);
        } finally {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.terminate();
            }
        }
    }

    // ── Step 4: Summary ───────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Summary');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Total targets: ${targets.length}`);
    console.log(`  Manager windows: ${categories.managers.length}`);
    console.log(`  Workbench windows: ${categories.workbenches.length}`);
    console.log(`  Workers: ${categories.workers.length}`);
    console.log(`  Webviews: ${categories.webviews.length}`);
    console.log(`  Others: ${categories.others.length}`);
    console.log('');
    
    // Key insight: if there are 2+ workbench-type targets, the extension likely loads 2x
    const extensionHostTargets = categories.managers.length + categories.workbenches.length;
    if (extensionHostTargets > 1) {
        console.log(`  ⚠️ POTENTIAL DUAL LOAD: ${extensionHostTargets} extension host targets found`);
        console.log(`     Manager: ${categories.managers.length}, Workbench: ${categories.workbenches.length}`);
        console.log(`     The extension may be running in BOTH windows!`);
    } else if (extensionHostTargets === 1) {
        console.log(`  ✅ Single extension host target — dual load unlikely`);
    } else {
        console.log(`  ⚠️ No obvious extension host target found`);
    }
    
} catch (err) {
    console.log(`  ❌ Could not connect to CDP on port ${PORT}: ${err.message}`);
    console.log(`     Is Antigravity running with --remote-debugging-port=${PORT}?`);
}

// ── Helpers ─────────────────────────────────────────────
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

let idCounter = 100;

function sendCdp(ws, id, method, params) {
    return new Promise((resolve, reject) => {
        const handler = (msg) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.id === id) {
                    ws.off('message', handler);
                    data.error ? reject(new Error(data.error.message)) : resolve(data.result);
                }
            } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, 5000);
    });
}

function evalInContext(ws, contextId, expression) {
    const id = idCounter++;
    return new Promise((resolve, reject) => {
        const handler = (msg) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.id === id) {
                    ws.off('message', handler);
                    if (data.error) reject(new Error(data.error.message));
                    else if (data.result?.exceptionDetails) reject(new Error(data.result.exceptionDetails.text));
                    else resolve(data.result?.result?.value);
                }
            } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, contextId }
        }));
        setTimeout(() => { ws.off('message', handler); reject(new Error('eval timeout')); }, 5000);
    });
}
