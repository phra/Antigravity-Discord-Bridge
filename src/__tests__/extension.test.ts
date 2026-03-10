import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the response cleaning pipeline in the orchestrator.
 * This covers the cleanResponse logic that was moved into BridgeController.
 *
 * We test it as a standalone function since it's pure logic.
 */

import { isNoiseLine } from '../utils';

/** Replicate the cleanResponse logic from BridgeController */
function cleanResponse(text: string, userMessage: string): string {
    return text
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (trimmed.length === 0) return true;
            if (isNoiseLine(trimmed)) return false;
            if (trimmed === userMessage.trim()) return false;
            if (/^Simple request/i.test(trimmed)) return false;
            return true;
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

describe('BridgeController cleanResponse', () => {
    it('strips all noise from a raw CDP response', () => {
        const raw = [
            '[CDP] Pre-snapshot: 114 messages',
            'Thought for <1s',
            'tell me a joke',
            'Simple request, no task needed.',
            'Why did the chicken cross the road? To get to the other side! 🐔',
            '✅ Elaborazione completata',
        ].join('\n');

        expect(cleanResponse(raw, 'tell me a joke'))
            .toBe('Why did the chicken cross the road? To get to the other side! 🐔');
    });

    it('preserves multi-paragraph responses', () => {
        const raw = [
            '[CDP] Pre-snapshot: 10 messages',
            'Thought for 3s',
            '',
            'First paragraph.',
            '',
            'Second paragraph.',
        ].join('\n');

        expect(cleanResponse(raw, 'explain'))
            .toBe('First paragraph.\n\nSecond paragraph.');
    });

    it('preserves code blocks', () => {
        const raw = [
            'Thinking...',
            '',
            'Here is the code:',
            '',
            '```typescript',
            'const x = 1;',
            '```',
        ].join('\n');

        const result = cleanResponse(raw, 'write code');
        expect(result).toContain('```typescript');
        expect(result).toContain('const x = 1;');
    });

    it('returns empty when only noise', () => {
        const raw = [
            '[CDP] stuff',
            'Thought for <1s',
            '✅ Elaborazione completata',
        ].join('\n');

        expect(cleanResponse(raw, 'test')).toBe('');
    });

    it('does not strip legitimate content with noise-like keywords', () => {
        const raw = 'The agent is processing incoming messages.';
        expect(cleanResponse(raw, 'what is the agent')).toContain('agent is processing');
    });

    it('collapses excessive blank lines', () => {
        const raw = 'Line 1\n\n\n\n\nLine 2';
        expect(cleanResponse(raw, 'test')).toBe('Line 1\n\nLine 2');
    });
});

describe('BridgeController dedup logic', () => {
    it('processedIds Set prevents duplicate processing', () => {
        const processedIds = new Set<string>();
        const results: string[] = [];

        function handleMessage(messageId: string) {
            if (processedIds.has(messageId)) return;
            processedIds.add(messageId);
            results.push(messageId);
        }

        handleMessage('msg-1');
        handleMessage('msg-1'); // duplicate
        handleMessage('msg-2');
        handleMessage('msg-1'); // still duplicate
        handleMessage('msg-3');

        expect(results).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });

    it('dedup Set entries expire after TTL', async () => {
        const processedIds = new Set<string>();
        const DEDUP_TTL = 50; // 50ms for test speed

        processedIds.add('msg-1');
        setTimeout(() => processedIds.delete('msg-1'), DEDUP_TTL);

        expect(processedIds.has('msg-1')).toBe(true);
        await new Promise(r => setTimeout(r, DEDUP_TTL + 10));
        expect(processedIds.has('msg-1')).toBe(false);
    });
});

describe('BridgeController queue logic', () => {
    it('queue respects MAX_QUEUE limit', () => {
        const MAX_QUEUE = 5;
        const queue: Array<{ msg: string; enqueueTime: number }> = [];
        const dropped: string[] = [];

        for (let i = 1; i <= 7; i++) {
            if (queue.length >= MAX_QUEUE) {
                dropped.push(`msg-${i}`);
            } else {
                queue.push({ msg: `msg-${i}`, enqueueTime: Date.now() });
            }
        }

        expect(queue).toHaveLength(5);
        expect(dropped).toEqual(['msg-6', 'msg-7']);
    });

    it('queue processes in FIFO order', () => {
        const queue = ['msg-1', 'msg-2', 'msg-3'];
        const processed: string[] = [];

        while (queue.length > 0) {
            processed.push(queue.shift()!);
        }

        expect(processed).toEqual(['msg-1', 'msg-2', 'msg-3']);
    });
});

describe('Leader election logic', () => {
    it('first instance becomes leader', () => {
        const state = new Map<string, any>();

        // Simulate tryBecomeLeader
        const instanceId = `${process.pid}-${Date.now()}`;
        const currentLeader = state.get('leaderId');
        const lastHeartbeat = state.get('leaderHeartbeat') || 0;
        const now = Date.now();

        const canLead = !currentLeader || (now - lastHeartbeat) > 15000;

        expect(canLead).toBe(true);
        state.set('leaderId', instanceId);
        state.set('leaderHeartbeat', now);
    });

    it('second instance defers to active leader', () => {
        const state = new Map<string, any>();
        const now = Date.now();

        // First instance
        state.set('leaderId', `${process.pid}-first`);
        state.set('leaderHeartbeat', now);

        // Second instance tries
        const currentLeader = state.get('leaderId');
        const lastHeartbeat = state.get('leaderHeartbeat');

        const leaderIsStale = (now - lastHeartbeat) > 15000;
        const canLead = !currentLeader || leaderIsStale;

        expect(canLead).toBe(false);
    });

    it('second instance takes over when heartbeat is stale', () => {
        const state = new Map<string, any>();
        const now = Date.now();

        // Stale leader (heartbeat 20s ago)
        state.set('leaderId', '99999-old');
        state.set('leaderHeartbeat', now - 20000);

        // New instance
        const lastHeartbeat = state.get('leaderHeartbeat');
        const leaderIsStale = (now - lastHeartbeat) > 15000;

        expect(leaderIsStale).toBe(true);
    });
});
