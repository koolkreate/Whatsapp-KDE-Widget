'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractLastMessage, extractChatListRows } = require('../lib/chatPreview');

// ── extractLastMessage ───────────────────────────────────────────────────────

test('returns null for a null/undefined chat', () => {
    assert.equal(extractLastMessage(null), null);
    assert.equal(extractLastMessage(undefined), null);
});

test('returns null when the chat has no preview source at all', () => {
    assert.equal(extractLastMessage({ name: 'Empty chat' }), null);
});

test('extracts a plain text message from chat.lastMessage', () => {
    const out = extractLastMessage({
        lastMessage: { body: 'Hello there', type: 'chat', t: 1700000000, id: { fromMe: false } },
    });
    assert.deepEqual(out, {
        body: 'Hello there',
        type: 'chat',
        t: 1700000000,
        fromMe: false,
        isRevoked: false,
        senderName: '',
    });
});

test('falls back to caption for an image message with a caption', () => {
    const out = extractLastMessage({
        lastMessage: { body: '', caption: 'Beach day', type: 'image', t: 42 },
    });
    assert.equal(out.body, 'Beach day');
    assert.equal(out.type, 'image');
});

test('returns empty body for a caption-less video (no crash)', () => {
    const out = extractLastMessage({
        lastMessage: { body: '', type: 'video', t: 7 },
    });
    assert.equal(out.body, '');
    assert.equal(out.type, 'video');
});

test('flags revoked messages', () => {
    const out = extractLastMessage({
        lastMessage: { body: '', type: 'revoked', t: 3, isRevoked: true },
    });
    assert.equal(out.isRevoked, true);
});

test('derives fromMe from id.fromMe and self', () => {
    const viaId = extractLastMessage({ lastMessage: { body: 'x', id: { fromMe: true } } });
    assert.equal(viaId.fromMe, true);
    const viaSelf = extractLastMessage({ lastMessage: { body: 'x', self: 'out' } });
    assert.equal(viaSelf.fromMe, true);
    const incoming = extractLastMessage({ lastMessage: { body: 'x', id: { fromMe: false } } });
    assert.equal(incoming.fromMe, false);
});

test('blanks base64 media payloads carried in body (probe finding)', () => {
    const out = extractLastMessage({
        lastMessage: { body: '/9j/4AAQSkZJRgABAQ' + 'A'.repeat(600), type: 'image', t: 5 },
    });
    assert.equal(out.body, '');
    assert.equal(out.type, 'image');
});

test('extracts group senderName from the sender model', () => {
    const out = extractLastMessage({
        lastMessage: {
            body: 'hi all', type: 'chat',
            sender: { formattedTitle: 'Ada Lovelace', pushname: 'Ada' },
        },
    });
    assert.equal(out.senderName, 'Ada Lovelace');
});

test('falls back to the last model of chat.msgs when lastMessage is missing', () => {
    const out = extractLastMessage({
        msgs: {
            getModelsArray: () => [
                { body: 'older', t: 1 },
                { body: 'newest', t: 2, id: { fromMe: true } },
            ],
        },
    });
    assert.equal(out.body, 'newest');
    assert.equal(out.fromMe, true);
    assert.equal(out.t, 2);
});

test('falls back to chat.previewMessage as a last resort', () => {
    const out = extractLastMessage({ previewMessage: { body: 'preview text', type: 'chat' } });
    assert.equal(out.body, 'preview text');
});

test('never throws on hostile input', () => {
    assert.equal(extractLastMessage({ lastMessage: {} }).body, '');
    assert.equal(extractLastMessage({ msgs: { getModelsArray: () => { throw new Error('boom'); } } }), null);
});

// ── extractChatListRows (injectable document) ────────────────────────────────

test('extractChatListRows pulls title + subtitle per chat row', () => {
    const rows = [{
        querySelectorAll: function () {
            return [
                { title: 'Mesoma', textContent: 'Mesoma' },
                { title: 'Hey, are you there?', textContent: 'Hey, are you there?' },
            ];
        },
        querySelector: function (sel) {
            if (sel.indexOf('cell-frame-title') !== -1) {
                return { title: 'Mesoma', textContent: 'Mesoma' };
            }
            return null;
        },
    }];
    const out = extractChatListRows({ querySelectorAll: function () { return rows; } });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Mesoma');
    assert.equal(out[0].body, 'Hey, are you there?');
});

test('extractChatListRows tolerates rows without a name or subtitle', () => {
    const rows = [
        { querySelector: function () { return null; }, querySelectorAll: function () { return []; } },
    ];
    const out = extractChatListRows({ querySelectorAll: function () { return rows; } });
    assert.equal(out.length, 0);
    assert.deepEqual(extractChatListRows(null), []);
});

test('extractChatListRows ignores digit-only spans (unread badges)', () => {
    const rows = [{
        querySelector: function (sel) {
            if (sel.indexOf('cell-frame-title') !== -1) return { title: 'SummerLanecoC', textContent: 'SummerLanecoC' };
            return null;
        },
        querySelectorAll: function () {
            return [
                { title: 'SummerLanecoC', textContent: 'SummerLanecoC' },
                { title: '3', textContent: '3' },
            ];
        },
    }];
    const out = extractChatListRows({ querySelectorAll: function () { return rows; } });
    assert.equal(out.length, 1);
    assert.equal(out[0].body, '');
});
