/**
 * Pure utility functions extracted for testability.
 * Used by CdpBridge, DiscordClient, and injected CDP scripts.
 */

// ── Noise filtering ──────────────────────────────────────

/**
 * Detect lines that are debug/diagnostic noise — not part of the AI response.
 * Matches CDP log lines, JSON-like metadata, DOM diagnostics, etc.
 */
export function isNoiseLine(line: string): boolean {
    // CDP log prefixes
    if (/^\[CDP\]/.test(line)) return true;
    if (/^\[Stream\]/.test(line)) return true;
    if (/^\[Discord\]/.test(line)) return true;
    if (/^\[Extension\]/.test(line)) return true;

    // JSON-like metadata properties
    if (/^"(classes|parentTag|parentAriaLabel|tag|role|lexical|textLen|visible|parentId|parentClass|grandparentId|hasSvg|ariaLabel|disabled)"\s*:/.test(line)) return true;

    // CDP status messages
    if (/^Ctrl\+I|^Ctrl\+L/.test(line)) return true;
    if (/^Pre-snapshot:|^Post-snapshot:|^Diff result:/.test(line)) return true;
    if (/^Agent is processing|^Agent finished|^Agent never became/.test(line)) return true;
    if (/^Message injected|^Focused agent panel/.test(line)) return true;
    if (/^DOM discovery/.test(line)) return true;
    if (/^Found chat editor|^Still waiting for agent/.test(line)) return true;

    // SVG/button diagnostics from discoverDom
    if (/^"svgs"\s*:\s*\[/.test(line)) return true;
    if (/^\{$|^\}$|^\]$|^\[$/.test(line)) return true;

    // Thought/thinking markers that are UI chrome, not content
    if (/^Thought for/.test(line)) return true;

    return false;
}

// ── Auto-accept button matching ──────────────────────────

/**
 * Check if a button's text content matches an Accept/Run/Allow pattern.
 * Used by the CDP-injected auto-accept interval.
 */
export function isAcceptButton(text: string): boolean {
    return text === 'Accept'
        || text === 'Run'
        || text === 'Always Allow'
        || text.startsWith('Accept')
        || text.startsWith('Run ')
        || text.startsWith('Always Allow');
}

// ── Message splitting ────────────────────────────────────

/**
 * Find the best point to split a message:
 * 1. Try to split at a double newline (paragraph break)
 * 2. Try to split at a single newline
 * 3. Fall back to maxLen
 */
export function findSplitPoint(text: string, maxLen: number): number {
    const doubleNewline = text.lastIndexOf("\n\n", maxLen);
    if (doubleNewline > maxLen * 0.5) {
        return doubleNewline + 2;
    }

    const singleNewline = text.lastIndexOf("\n", maxLen);
    if (singleNewline > maxLen * 0.3) {
        return singleNewline + 1;
    }

    return maxLen;
}

/**
 * Split a message into chunks that fit Discord's 2000 char limit.
 * Preserves code blocks intact when possible.
 */
export function splitMessage(text: string, maxLen = 2000): string[] {
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

        const splitIdx = findSplitPoint(remaining, maxLen);
        chunks.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx);
    }

    return chunks;
}

// ── HTML to Markdown (for Discord) ───────────────────────

/**
 * Convert an HTML string to Discord-compatible markdown.
 * Handles code blocks, inline code, bold, italic, headers, lists,
 * links, blockquotes, and paragraphs.
 */
export function htmlToMarkdown(html: string): string {
    // This function is designed to run in the browser via CDP injection.
    // For testing, we provide a Node-compatible version that parses HTML strings.
    // In production, the CDP script uses the DOM directly.
    // See cdp-bridge.ts extractLastResponseMarkdown() for the DOM version.

    // Simple tag-based conversion for testing
    let md = html;

    // Code blocks: <pre><code class="language-X">...</code></pre>
    md = md.replace(/<pre><code(?:\s+class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/gi,
        (_, lang, code) => `\n\`\`\`${lang || ''}\n${decodeHtmlEntities(code).trimEnd()}\n\`\`\`\n`);

    // Inline code
    md = md.replace(/<code>(.*?)<\/code>/gi, (_, code) => `\`${decodeHtmlEntities(code)}\``);

    // Bold
    md = md.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**');

    // Italic
    md = md.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*');

    // Headers
    md = md.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/gi,
        (_, level, content) => `\n${'#'.repeat(Number(level))} ${content}\n`);

    // Unordered lists
    md = md.replace(/<ul>([\s\S]*?)<\/ul>/gi, (_, items) => {
        return items.replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n') + '\n';
    });

    // Ordered lists
    md = md.replace(/<ol>([\s\S]*?)<\/ol>/gi, (_, items) => {
        let i = 0;
        return items.replace(/<li>([\s\S]*?)<\/li>/gi, () => `${++i}. ${arguments[1]}\n`) + '\n';
    });

    // Links
    md = md.replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

    // Blockquotes
    md = md.replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi,
        (_, content) => content.split('\n').map((l: string) => `> ${l}`).join('\n') + '\n');

    // Paragraphs
    md = md.replace(/<p>([\s\S]*?)<\/p>/gi, '$1\n');

    // BR
    md = md.replace(/<br\s*\/?>/gi, '\n');

    // HR
    md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

    // Strip remaining tags
    md = md.replace(/<[^>]+>/g, '');

    // Decode HTML entities
    md = decodeHtmlEntities(md);

    // Clean up excessive newlines
    md = md.replace(/\n{3,}/g, '\n\n');

    return md.trim();
}

/**
 * Decode common HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
}
