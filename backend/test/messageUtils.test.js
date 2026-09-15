'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// MessageUtils is shared plain JS loaded both by the widget QML and by Node.
const utils = require('../../widget/contents/ui/messageUtils.js');

test('isMediaMessage flags image/video/sticker and raw base64 bodies', () => {
    assert.equal(utils.isMediaMessage({ type: 'image' }), true);
    assert.equal(utils.isMediaMessage({ type: 'video' }), true);
    assert.equal(utils.isMediaMessage({ type: 'sticker' }), true);
    assert.equal(utils.isMediaMessage({ type: 'chat', body: '/9j/...' }), true);
    assert.equal(utils.isMediaMessage({ type: 'chat', body: 'data:image/png;base64,...' }), true);
    assert.equal(utils.isMediaMessage({ type: 'chat', body: 'iVBORw0KGgo...' }), true);
    assert.equal(utils.isMediaMessage({ type: 'chat', body: 'hello world' }), false);
});

test('mediaLabel returns emoji label or empty', () => {
    assert.equal(utils.mediaLabel('image'), '📷 Photo');
    assert.equal(utils.mediaLabel('video'), '🎥 Video');
    assert.equal(utils.mediaLabel('audio'), '🎵 Audio');
    assert.equal(utils.mediaLabel('document'), '📄 Document');
    assert.equal(utils.mediaLabel('sticker'), '🪄 Sticker');
    assert.equal(utils.mediaLabel('chat'), '');
});

test('copyTextForMessage returns the body for text, a label for media', () => {
    assert.equal(utils.copyTextForMessage({ type: 'chat', body: 'hello' }), 'hello');
    assert.equal(utils.copyTextForMessage({ type: 'image' }), '📷 Photo');
    assert.equal(utils.copyTextForMessage({ type: 'chat', body: '/9j/abc' }), '📷 Photo');
    assert.equal(utils.copyTextForMessage({ type: 'document', body: 'name.pdf' }), '📄 Document');
});

test('copyTextForMessage falls back to message content field', () => {
    assert.equal(utils.copyTextForMessage({ type: 'chat', content: 'via content' }), 'via content');
    assert.equal(utils.copyTextForMessage(null), '');
});

test('replyPreviewText truncates long text with an ellipsis', () => {
    const long = 'x'.repeat(200);
    const p = utils.replyPreviewText({ type: 'chat', body: long });
    assert.ok(p.length <= 64);
    assert.ok(p.endsWith('…'));
});

test('replyPreviewText shows emoji label for media and empty string for nothing', () => {
    assert.equal(utils.replyPreviewText({ type: 'sticker' }), '🪄 Sticker');
    assert.equal(utils.replyPreviewText({}), '');
});

// ── chatRecency / compareChats (Slice 1 sort) ────────────────────────────────

test('chatRecency uses the newer of chat.t and lastMessage.t', () => {
    assert.equal(utils.chatRecency({ t: 100, lastMessage: { t: 200 } }), 200);
    assert.equal(utils.chatRecency({ t: 300, lastMessage: { t: 200 } }), 300);
    assert.equal(utils.chatRecency({ t: 300 }), 300);
    assert.equal(utils.chatRecency({ lastMessage: { t: 150 } }), 150);
    assert.equal(utils.chatRecency({}), 0);
    assert.equal(utils.chatRecency(null), 0);
});

test('compareChats orders pinned first regardless of recency', () => {
    const pinned = { name: 'old pinned', t: 1, isPinned: true };
    const fresh = { name: 'fresh', t: 999 };
    assert.equal(utils.compareChats(fresh, pinned), 1);
    assert.equal(utils.compareChats(pinned, fresh), -1);
});

test('compareChats orders by recency when both unpinned', () => {
    const a = { name: 'a', t: 100 };
    const b = { name: 'b', lastMessage: { t: 200 } };
    assert.equal(utils.compareChats(a, b), 1);
    assert.equal(utils.compareChats(b, a), -1);
});

test('compareChats falls back to name asc as a stable tiebreak', () => {
    const a = { name: 'Beta', t: 100 };
    const b = { name: 'Alpha', t: 100 };
    assert.equal(utils.compareChats(a, b), 1);
    assert.equal(utils.compareChats(b, a), -1);
    assert.equal(utils.compareChats(a, a), 0);
});

test('compareChats honours the injected pinned resolver', () => {
    const pins = { 'pinned-by-list': true };
    const resolver = function (c) { return !!pins[c.id]; };
    const a = { id: 'pinned-by-list', name: 'a', t: 1 };
    const b = { id: 'plain', name: 'b', t: 999 };
    assert.equal(utils.compareChats(b, a, resolver), 1);
});

// ── thumbnailize / mediaSource / buildMediaList (Slices 3–4) ─────────────────

test('thumbnailize keeps small bodies and text untouched', () => {
    const text = { id: 'm1', type: 'chat', body: 'hello' };
    assert.equal(utils.thumbnailize(text, 4096), text);
    const smallB64 = { id: 'm2', type: 'image', body: '/9j/small' };
    assert.equal(utils.thumbnailize(smallB64, 4096), smallB64);
});

test('thumbnailize replaces large base64 bodies with a placeholder', () => {
    const big = { id: 'm3', type: 'image', body: '/9j/' + 'A'.repeat(6000), t: 5 };
    const out = utils.thumbnailize(big, 4096);
    assert.notEqual(out, big);
    assert.equal(out._thumb, true);
    assert.equal(out.body, '');
    assert.equal(out.type, 'image');
    assert.equal(out.t, 5);
    assert.equal(big.body.length, 6004); // original untouched
    assert.equal(utils.thumbnailize(null), null);
});

test('mediaSource builds data URLs like the old inline QML logic', () => {
    assert.equal(utils.mediaSource({ body: '/9j/ABC' }), 'data:image/jpeg;base64,/9j/ABC');
    assert.equal(utils.mediaSource({ body: 'iVBORw0KGgoXYZ' }), 'data:image/png;base64,iVBORw0KGgoXYZ');
    assert.equal(utils.mediaSource({ body: 'data:image/webp;base64,AAA' }), 'data:image/webp;base64,AAA');
    assert.equal(utils.mediaSource({ body: '' }), '');
    assert.equal(utils.mediaSource({ body: 'plain text' }), 'data:image/jpeg;base64,plain text');
    assert.equal(utils.mediaSource(null), '');
});

test('buildMediaList filters to viewable media in chat order', () => {
    const msgs = [
        { id: 'm1', type: 'chat', body: 'text' },
        { id: 'm2', type: 'image', body: '/9j/a' },
        { id: 'm3', type: 'chat', body: '/9j/inline' },
        { id: 'm4', type: 'video', body: '/9j/vid' },
        { id: 'm5', type: 'chat', body: 'more text' },
        { id: 'm6', _thumb: true, type: 'image', body: '' },
    ];
    const out = utils.buildMediaList(msgs);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m2', 'm3', 'm4']);
    assert.deepEqual(utils.buildMediaList([]), []);
    assert.deepEqual(utils.buildMediaList(null), []);
});