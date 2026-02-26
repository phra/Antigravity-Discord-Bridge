import { describe, it, expect } from 'vitest';
import {
    isNoiseLine,
    isAcceptButton,
    splitMessage,
    findSplitPoint,
    htmlToMarkdown,
    decodeHtmlEntities,
} from '../utils';

// ── isNoiseLine ──────────────────────────────────────────

describe('isNoiseLine', () => {
    it('detects CDP log prefixes', () => {
        expect(isNoiseLine('[CDP] Connected')).toBe(true);
        expect(isNoiseLine('[Stream] chunk received')).toBe(true);
        expect(isNoiseLine('[Discord] Message from user')).toBe(true);
        expect(isNoiseLine('[Extension] activated')).toBe(true);
    });

    it('detects JSON metadata properties', () => {
        expect(isNoiseLine('"classes": "lucide-icon"')).toBe(true);
        expect(isNoiseLine('"tag": "div"')).toBe(true);
        expect(isNoiseLine('"role": "textbox"')).toBe(true);
        expect(isNoiseLine('"visible": true')).toBe(true);
    });

    it('detects CDP status messages', () => {
        expect(isNoiseLine('Pre-snapshot: 100 lines')).toBe(true);
        expect(isNoiseLine('Post-snapshot: 150 lines')).toBe(true);
        expect(isNoiseLine('Diff result: 5 new lines')).toBe(true);
        expect(isNoiseLine('Agent is processing...')).toBe(true);
        expect(isNoiseLine('Agent finished processing')).toBe(true);
        expect(isNoiseLine('Message injected via CDP')).toBe(true);
        expect(isNoiseLine('Found chat editor in context 23')).toBe(true);
        expect(isNoiseLine('Still waiting for agent response')).toBe(true);
    });

    it('detects UI chrome/thought markers', () => {
        expect(isNoiseLine('Thought for 3s')).toBe(true);
        expect(isNoiseLine('Ctrl+I to toggle inline chat')).toBe(true);
    });

    it('detects standalone JSON brackets', () => {
        expect(isNoiseLine('{')).toBe(true);
        expect(isNoiseLine('}')).toBe(true);
        expect(isNoiseLine('[')).toBe(true);
        expect(isNoiseLine(']')).toBe(true);
    });

    it('passes through actual content', () => {
        expect(isNoiseLine('Hello, how can I help?')).toBe(false);
        expect(isNoiseLine('The function returns a boolean')).toBe(false);
        expect(isNoiseLine('```typescript')).toBe(false);
        expect(isNoiseLine('Here is the code:')).toBe(false);
        expect(isNoiseLine('1. First step')).toBe(false);
        expect(isNoiseLine('- bullet point')).toBe(false);
    });

    it('does not false-positive on content containing keywords', () => {
        expect(isNoiseLine('The agent is a software component')).toBe(false);
        expect(isNoiseLine('Use Ctrl+C to copy')).toBe(false);
        expect(isNoiseLine('I thought about this problem')).toBe(false);
    });

    it('detects Antigravity UI chrome elements', () => {
        expect(isNoiseLine('⋯ Expand 214 more lines')).toBe(true);
        expect(isNoiseLine('⋯ Expand 78 more lines')).toBe(true);
        expect(isNoiseLine('⋯ Expand 20 more lines')).toBe(true);
        expect(isNoiseLine('Always run')).toBe(true);
        expect(isNoiseLine('Planning')).toBe(true);
        expect(isNoiseLine('Review Changes')).toBe(true);
        expect(isNoiseLine('Review')).toBe(true);
        expect(isNoiseLine('Cancel')).toBe(true);
        expect(isNoiseLine('Submit')).toBe(true);
    });

    it('detects auto-accept scan output', () => {
        expect(isNoiseLine('[AutoAccept] Scan #1: 28 buttons.')).toBe(true);
        expect(isNoiseLine('["Always run","Review","Planning",""]')).toBe(true);
    });
});

// ── isAcceptButton ───────────────────────────────────────

describe('isAcceptButton', () => {
    it('matches exact button texts', () => {
        expect(isAcceptButton('Accept')).toBe(true);
        expect(isAcceptButton('Run')).toBe(true);
        expect(isAcceptButton('Always Allow')).toBe(true);
    });

    it('matches buttons with suffixes', () => {
        expect(isAcceptButton('Accept all')).toBe(true);
        expect(isAcceptButton('Accept All Changes')).toBe(true);
        expect(isAcceptButton('RunAlt+⏎')).toBe(true);        // no space!
        expect(isAcceptButton('Run Alt+↵')).toBe(true);
        expect(isAcceptButton('Run All+1')).toBe(true);
        expect(isAcceptButton('Run command')).toBe(true);
        expect(isAcceptButton('Always Allow this extension')).toBe(true);
    });

    it('rejects non-matching buttons', () => {
        expect(isAcceptButton('Cancel')).toBe(false);
        expect(isAcceptButton('Reject')).toBe(false);
        expect(isAcceptButton('Reject all')).toBe(false);
        expect(isAcceptButton('Close')).toBe(false);
        expect(isAcceptButton('Save')).toBe(false);
        expect(isAcceptButton('Delete')).toBe(false);
    });

    it('rejects mode toggles and partial matches', () => {
        expect(isAcceptButton('Always run')).toBe(false);   // mode toggle, not approval
        expect(isAcceptButton('Do not Accept')).toBe(false);
        expect(isAcceptButton('Override Run')).toBe(false);
    });

    it('handles edge cases', () => {
        expect(isAcceptButton('')).toBe(false);
        expect(isAcceptButton('   ')).toBe(false);
    });
});

// ── splitMessage ─────────────────────────────────────────

describe('splitMessage', () => {
    it('returns single chunk for short messages', () => {
        expect(splitMessage('hello')).toEqual(['hello']);
        expect(splitMessage('short message', 2000)).toEqual(['short message']);
    });

    it('returns single chunk for exactly maxLen', () => {
        const exact = 'a'.repeat(2000);
        expect(splitMessage(exact)).toEqual([exact]);
    });

    it('splits long messages at paragraph breaks', () => {
        const para1 = 'a'.repeat(1500);
        const para2 = 'b'.repeat(800);
        const text = `${para1}\n\n${para2}`;
        const chunks = splitMessage(text);
        expect(chunks.length).toBe(2);
        expect(chunks[0]).toBe(para1 + '\n\n');
        expect(chunks[1]).toBe(para2);
    });

    it('splits at single newline when no paragraph break available', () => {
        const line1 = 'a'.repeat(1500);
        const line2 = 'b'.repeat(800);
        const text = `${line1}\n${line2}`;
        const chunks = splitMessage(text);
        expect(chunks.length).toBe(2);
        expect(chunks[0]).toBe(line1 + '\n');
        expect(chunks[1]).toBe(line2);
    });

    it('hard splits when no newlines available', () => {
        const text = 'a'.repeat(5000);
        const chunks = splitMessage(text);
        expect(chunks.length).toBe(3);
        expect(chunks[0].length).toBe(2000);
        expect(chunks[1].length).toBe(2000);
        expect(chunks[2].length).toBe(1000);
    });

    it('handles custom maxLen', () => {
        const text = 'a'.repeat(100);
        const chunks = splitMessage(text, 30);
        expect(chunks.length).toBe(4);
        expect(chunks.every(c => c.length <= 30)).toBe(true);
    });

    it('handles empty string', () => {
        expect(splitMessage('')).toEqual(['']);
    });
});

// ── findSplitPoint ───────────────────────────────────────

describe('findSplitPoint', () => {
    it('prefers double newline near the limit', () => {
        const text = 'a'.repeat(1500) + '\n\n' + 'b'.repeat(500);
        const point = findSplitPoint(text, 2000);
        expect(point).toBe(1502); // 1500 + 2 (\n\n)
    });

    it('falls back to single newline', () => {
        const text = 'a'.repeat(1500) + '\n' + 'b'.repeat(1000);
        const point = findSplitPoint(text, 2000);
        expect(point).toBe(1501); // 1500 + 1 (\n)
    });

    it('hard splits when no newlines in range', () => {
        const text = 'a'.repeat(3000);
        const point = findSplitPoint(text, 2000);
        expect(point).toBe(2000);
    });

    it('ignores newlines too early in the text', () => {
        // Single newline at 20% of maxLen should be ignored (below 30% threshold)
        const text = 'a'.repeat(100) + '\n' + 'b'.repeat(2400);
        const point = findSplitPoint(text, 2000);
        expect(point).toBe(2000); // Hard split — \n too early
    });
});

// ── htmlToMarkdown ───────────────────────────────────────

describe('htmlToMarkdown', () => {
    it('converts code blocks', () => {
        const html = '<pre><code class="language-typescript">const x = 1;</code></pre>';
        const md = htmlToMarkdown(html);
        expect(md).toContain('```typescript');
        expect(md).toContain('const x = 1;');
        expect(md).toContain('```');
    });

    it('converts code blocks without language', () => {
        const html = '<pre><code>echo hello</code></pre>';
        const md = htmlToMarkdown(html);
        expect(md).toContain('```\n');
        expect(md).toContain('echo hello');
    });

    it('converts inline code', () => {
        const html = 'Use <code>npm install</code> to install';
        const md = htmlToMarkdown(html);
        expect(md).toContain('`npm install`');
    });

    it('converts bold', () => {
        const html = 'This is <strong>important</strong>';
        const md = htmlToMarkdown(html);
        expect(md).toContain('**important**');
    });

    it('converts italic', () => {
        const html = 'This is <em>emphasized</em>';
        const md = htmlToMarkdown(html);
        expect(md).toContain('*emphasized*');
    });

    it('converts headers', () => {
        expect(htmlToMarkdown('<h1>Title</h1>')).toContain('# Title');
        expect(htmlToMarkdown('<h2>Subtitle</h2>')).toContain('## Subtitle');
        expect(htmlToMarkdown('<h3>Section</h3>')).toContain('### Section');
    });

    it('converts links', () => {
        const html = '<a href="https://example.com">Example</a>';
        const md = htmlToMarkdown(html);
        expect(md).toContain('[Example](https://example.com)');
    });

    it('converts paragraphs', () => {
        const html = '<p>First paragraph</p><p>Second paragraph</p>';
        const md = htmlToMarkdown(html);
        expect(md).toContain('First paragraph');
        expect(md).toContain('Second paragraph');
    });

    it('converts BR tags', () => {
        const html = 'line1<br>line2<br/>line3';
        const md = htmlToMarkdown(html);
        expect(md).toContain('line1\nline2\nline3');
    });

    it('converts HR tags', () => {
        const html = 'above<hr>below';
        const md = htmlToMarkdown(html);
        expect(md).toContain('---');
    });

    it('strips remaining HTML tags', () => {
        const html = '<div><span>hello</span></div>';
        const md = htmlToMarkdown(html);
        expect(md).toBe('hello');
        expect(md).not.toContain('<');
    });
});

// ── decodeHtmlEntities ───────────────────────────────────

describe('decodeHtmlEntities', () => {
    it('decodes common entities', () => {
        expect(decodeHtmlEntities('&amp;')).toBe('&');
        expect(decodeHtmlEntities('&lt;')).toBe('<');
        expect(decodeHtmlEntities('&gt;')).toBe('>');
        expect(decodeHtmlEntities('&quot;')).toBe('"');
        expect(decodeHtmlEntities('&#39;')).toBe("'");
        expect(decodeHtmlEntities('&nbsp;')).toBe(' ');
    });

    it('decodes multiple entities in one string', () => {
        expect(decodeHtmlEntities('a &lt; b &amp;&amp; c &gt; d')).toBe('a < b && c > d');
    });

    it('passes through text without entities', () => {
        expect(decodeHtmlEntities('hello world')).toBe('hello world');
    });
});
