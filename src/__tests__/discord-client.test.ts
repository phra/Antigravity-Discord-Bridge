import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the rewritten DiscordClient message routing.
 *
 * We mock discord.js Client internals and test that the routeMessage()
 * gate correctly filters messages based on the 5 routing rules.
 */

// Mock discord.js before importing DiscordClient
vi.mock('discord.js', () => {
    const EventEmitter = require('events');

    class MockClient extends EventEmitter {
        user = { setPresence: vi.fn() };
        channels = { fetch: vi.fn() };
        login = vi.fn().mockResolvedValue('mock-token');
        destroy = vi.fn();
        isReady = vi.fn().mockReturnValue(true);
    }

    class MockTextChannel {
        name = 'test-channel';
        send = vi.fn().mockResolvedValue({});
        messages = { fetch: vi.fn() };
        threads = { create: vi.fn() };
    }

    return {
        Client: MockClient,
        GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
        TextChannel: MockTextChannel,
        Events: { MessageCreate: 'messageCreate', Error: 'error' },
        ActivityType: { Custom: 4 },
        ThreadAutoArchiveDuration: { OneDay: 1440 },
        ChannelType: { PublicThread: 11 },
    };
});

// Mock vscode OutputChannel
const mockLog = {
    appendLine: vi.fn(),
    show: vi.fn(),
};

import { DiscordClient } from '../discord-client';

describe('DiscordClient message routing', () => {
    let client: DiscordClient;
    let callback: ReturnType<typeof vi.fn>;
    let discordJsClient: any;
    const CHANNEL_ID = '123456789';

    beforeEach(() => {
        vi.clearAllMocks();
        client = new DiscordClient(CHANNEL_ID, mockLog as any);
        callback = vi.fn();
        client.onMessage(callback as any);

        // Access the internal discord.js Client to emit messages
        discordJsClient = (client as any).client;
    });

    function emitMessage(overrides: Record<string, any> = {}) {
        const defaultAttachments = { map: vi.fn().mockReturnValue([]) } as any;
        const msg = {
            author: { bot: false, displayName: 'TestUser' },
            content: 'hello',
            createdAt: new Date(),
            attachments: defaultAttachments,
            id: 'msg-001',
            channelId: CHANNEL_ID,
            channel: {
                isThread: () => false,
                parentId: null,
            },
            ...overrides,
        };
        discordJsClient.emit('messageCreate', msg);
        return msg;
    }

    // ── Rule 1: Ignore bot messages ──

    it('ignores bot messages', () => {
        emitMessage({ author: { bot: true, displayName: 'SomeBot' } });
        expect(callback).not.toHaveBeenCalled();
    });

    // ── Rule 2: Accept main channel messages ──

    it('accepts messages in the main channel', () => {
        emitMessage();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                author: 'TestUser',
                content: 'hello',
                isMainChannel: true,
                threadId: undefined,
            })
        );
    });

    // ── Rule 3: Accept thread messages under our channel ──

    it('accepts messages from threads in our channel', () => {
        emitMessage({
            id: 'msg-in-thread',
            channelId: 'thread-001',
            channel: {
                isThread: () => true,
                parentId: CHANNEL_ID,
            },
        });
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                isMainChannel: false,
                threadId: 'thread-001',
            })
        );
    });

    // ── Rule 4: Skip thread-starter echo ──

    it('skips thread-starter echo (message.id === channelId)', () => {
        emitMessage({
            id: 'thread-starter-id',
            channelId: 'thread-starter-id', // this is the key: msg.id === thread.id
            channel: {
                isThread: () => true,
                parentId: CHANNEL_ID,
            },
        });
        expect(callback).not.toHaveBeenCalled();
    });

    // ── Rule 5: Ignore other channels ──

    it('ignores messages from other channels', () => {
        emitMessage({
            channelId: 'other-channel-id',
            channel: {
                isThread: () => false,
                parentId: null,
            },
        });
        expect(callback).not.toHaveBeenCalled();
    });

    it('ignores messages from threads in other channels', () => {
        emitMessage({
            channelId: 'thread-in-other-channel',
            channel: {
                isThread: () => true,
                parentId: 'other-channel-id',
            },
        });
        expect(callback).not.toHaveBeenCalled();
    });

    // ── Multiple messages ──

    it('dispatches multiple valid messages', () => {
        emitMessage({ id: 'msg-1', content: 'first' });
        emitMessage({ id: 'msg-2', content: 'second' });
        expect(callback).toHaveBeenCalledTimes(2);
    });

    // ── Structural ──

    it('passes through attachments', () => {
        const mockAttachments = { map: vi.fn().mockReturnValue(['url1', 'url2']) };
        emitMessage({ attachments: mockAttachments as any });
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                attachments: ['url1', 'url2'],
            })
        );
    });

    it('includes messageId in callback', () => {
        emitMessage({ id: 'unique-msg-id' });
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({ messageId: 'unique-msg-id' })
        );
    });
});
