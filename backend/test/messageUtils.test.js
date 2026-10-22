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
    assert.equal(utils.mediaSource({ body: 'plain text' }), '');
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
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m2', 'm3', 'm4', 'm6']);
    assert.deepEqual(utils.buildMediaList([]), []);
    assert.deepEqual(utils.buildMediaList(null), []);
});

test('needsThumb flags image/video/sticker msgs lacking body and thumbUrl', () => {
    assert.equal(utils.needsThumb({ type: 'image', body: '' }), true);
    assert.equal(utils.needsThumb({ type: 'video', body: '' }), true);
    assert.equal(utils.needsThumb({ type: 'sticker', body: '' }), true);
    assert.equal(utils.needsThumb({ type: 'image' }), true);
    assert.equal(utils.needsThumb({ _thumb: true, type: 'image', body: '' }), true);
    assert.equal(utils.needsThumb(null), false);
});

test('needsThumb is false for text and msgs already carrying thumbUrl/full body', () => {
    assert.equal(utils.needsThumb({ type: 'chat', body: '' }), false);
    assert.equal(utils.needsThumb({ type: 'chat', body: 'hello' }), false);
    assert.equal(utils.needsThumb({ type: 'image', body: '', thumbUrl: 'data:image/jpeg;base64,AAA' }), false);
    assert.equal(utils.needsThumb({ _thumb: true, type: 'image', body: '', thumbUrl: 'data:image/jpeg;base64,AAA' }), false);
    assert.equal(utils.needsThumb({ type: 'image', body: '/9j/' + 'A'.repeat(5000) }), false);
    assert.equal(utils.needsThumb({ type: 'video', body: '/9j/' + 'V'.repeat(5000) }), false);
});

test('mediaSource prefers thumbUrl when body is empty', () => {
    assert.equal(utils.mediaSource({ body: '', thumbUrl: 'data:image/jpeg;base64,THUMB' }), 'data:image/jpeg;base64,THUMB');
    assert.equal(utils.mediaSource({ body: '', thumbUrl: '' }), '');
    assert.equal(utils.mediaSource({ body: '' }), '');
    assert.equal(utils.mediaSource({ thumbUrl: 'data:image/jpeg;base64,THUMB' }), 'data:image/jpeg;base64,THUMB');
    assert.equal(utils.mediaSource({ body: '/9j/ABC', thumbUrl: 'data:image/jpeg;base64,THUMB' }), 'data:image/jpeg;base64,/9j/ABC');
});

test('thumbnailize preserves an existing thumbUrl onto the placeholder copy', () => {
    const big = { id: 'm9', type: 'image', body: '/9j/' + 'A'.repeat(6000), thumbUrl: 'data:image/jpeg;base64,THUMB' };
    const out = utils.thumbnailize(big, 4096);
    assert.equal(out._thumb, true);
    assert.equal(out.body, '');
    assert.equal(out.thumbUrl, 'data:image/jpeg;base64,THUMB');
});

test('buildMediaList includes typed media even with empty body (viewer resolves full)', () => {
    const msgs = [
        { id: 'm1', type: 'chat', body: 'text' },
        { id: 'm2', type: 'image', body: '/9j/a' },
        { id: 'm6', _thumb: true, type: 'image', body: '' },
        { id: 'm7', _thumb: true, type: 'image', body: '', thumbUrl: 'data:image/jpeg;base64,THUMB' },
        { id: 'm8', type: 'image', body: '' },
        { id: 'm9', type: 'image', body: '', thumbUrl: 'data:image/jpeg;base64,THUMB' },
        { id: 'm10', type: 'video', body: '', thumbUrl: 'data:image/jpeg;base64,THUMB' },
    ];
    const out = utils.buildMediaList(msgs);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m2', 'm6', 'm7', 'm8', 'm9', 'm10']);
});

// ── System / non-renderable messages (empty-bubble bug) ──────────────────────

test('isSystemMessage flags empty-body non-media WhatsApp system types', () => {
    // Live-observed payload: call_log with empty body rendered a timestamp-only pill.
    assert.equal(utils.isSystemMessage({ type: 'call_log', body: '', caption: '' }), true);
    assert.equal(utils.isSystemMessage({ type: 'notification', body: '' }), true);
    assert.equal(utils.isSystemMessage({ type: 'gp2', body: '' }), true);
    assert.equal(utils.isSystemMessage({ type: 'e2e_notification', body: '' }), true);
    assert.equal(utils.isSystemMessage({ type: 'revoked', body: '' }), true);
    assert.equal(utils.isSystemMessage({ type: 'chat', body: '', isRevoked: true }), true);
    assert.equal(utils.isSystemMessage({ type: 'mystery_type', body: '' }), true);
    assert.equal(utils.isSystemMessage({ type: 'chat', body: '' }), true); // unextractable text -> label beats empty pill
    assert.equal(utils.isSystemMessage(null), false);
});

test('isSystemMessage is false for anything with renderable content', () => {
    assert.equal(utils.isSystemMessage({ type: 'chat', body: 'hello' }), false);
    assert.equal(utils.isSystemMessage({ type: 'image', body: '' }), false);
    assert.equal(utils.isSystemMessage({ type: 'sticker', body: '' }), false);
    assert.equal(utils.isSystemMessage({ type: 'image', body: '', thumbUrl: 'data:image/jpeg;base64,T' }), false);
    assert.equal(utils.isSystemMessage({ type: 'ptt', body: '', waveform: [1, 2] }), false);
    assert.equal(utils.isSystemMessage({ type: 'chat', body: '/9j/abc' }), false);
    assert.equal(utils.isSystemMessage({ type: 'image', body: 'the caption text' }), false);
});

test('systemMessageText maps system types to readable labels', () => {
    assert.equal(utils.systemMessageText({ type: 'call_log', body: '' }), '📞 Call');
    assert.equal(utils.systemMessageText({ type: 'call_log', body: '', subtype: 'miss_call' }), '📞 Missed voice call');
    assert.equal(utils.systemMessageText({ type: 'call_log', body: '', subtype: 'miss_video' }), '📞 Missed video call');
    assert.equal(utils.systemMessageText({ type: 'notification', body: '' }), 'ℹ️ Group notification');
    assert.equal(utils.systemMessageText({ type: 'gp2', body: '' }), 'ℹ️ Group notification');
    assert.equal(utils.systemMessageText({ type: 'e2e_notification', body: '' }), '🔒 Messages and calls are end-to-end encrypted.');
    assert.equal(utils.systemMessageText({ type: 'revoked', body: '' }), '🚫 This message was deleted');
    assert.equal(utils.systemMessageText({ type: 'chat', body: '', isRevoked: true }), '🚫 This message was deleted');
    assert.equal(utils.systemMessageText({ type: 'location', body: '' }), '📍 Location');
    assert.equal(utils.systemMessageText({ type: 'contact', body: '' }), '👤 Contact');
    assert.equal(utils.systemMessageText({ type: 'totally_unknown', body: '' }), 'Unsupported message');
});

test('systemMessageText returns empty string for normal messages', () => {
    assert.equal(utils.systemMessageText({ type: 'chat', body: 'hello' }), '');
    assert.equal(utils.systemMessageText({ type: 'image', body: '' }), '');
    assert.equal(utils.systemMessageText({ type: 'ptt', body: '' }), '');
    assert.equal(utils.systemMessageText(null), '');
});

// ── filterChats (archived-chat view) ─────────────────────────────────────────

test('filterChats hides archived chats by default', () => {
    const chats = [
        { id: '123@s.whatsapp.net', name: 'Johnny', t: 100 },
        { id: '456@s.whatsapp.net', name: 'Alice', t: 200 },
        { id: '789@g.us', name: 'Team', t: 300, isArchived: true }, // stale flag must be ignored
    ];
    const out = utils.filterChats(chats, '', ['123@s.whatsapp.net'], false);
    assert.deepEqual(out.map(c => c.id), ['456@s.whatsapp.net', '789@g.us']);
});

test('filterChats with showArchived shows only archived chats', () => {
    const chats = [
        { id: '123@s.whatsapp.net', name: 'Johnny', t: 100 },
        { id: '456@s.whatsapp.net', name: 'Alice', t: 200 },
    ];
    const out = utils.filterChats(chats, '', ['123@s.whatsapp.net'], true);
    assert.deepEqual(out.map(c => c.id), ['123@s.whatsapp.net']);
});

test('filterChats search applies within the current view', () => {
    const chats = [
        { id: '123@s.whatsapp.net', name: 'Johnny', t: 100 },
        { id: '456@s.whatsapp.net', name: 'Johnny Two', t: 200 },
        { id: '789@s.whatsapp.net', name: 'Alice', t: 300 },
    ];
    const archived = ['123@s.whatsapp.net'];
    // Archived view: only archived Johnnys match "johnny".
    assert.deepEqual(
        utils.filterChats(chats, 'johnny', archived, true).map(c => c.id),
        ['123@s.whatsapp.net']);
    // Main view: only non-archived Johnnys match.
    assert.deepEqual(
        utils.filterChats(chats, 'johnny', archived, false).map(c => c.id),
        ['456@s.whatsapp.net']);
});

test('filterChats matches display name and the phone portion of the id', () => {
    const chats = [
        { id: '254711222333@s.whatsapp.net', name: 'K', t: 100 },
        { id: '999-888@g.us', name: 'Wednesday Team', t: 200 },
    ];
    assert.deepEqual(
        utils.filterChats(chats, '2547112', [], false).map(c => c.id),
        ['254711222333@s.whatsapp.net']);
    assert.deepEqual(
        utils.filterChats(chats, '  wednesday ', [], false).map(c => c.id),
        ['999-888@g.us']);
    assert.deepEqual(
        utils.filterChats(chats, 's.whatsapp.net', [], false).map(c => c.id),
        []); // only matched text before '@' counts
});

test('filterChats ignores stale archived ids that match no chat', () => {
    const chats = [
        { id: '123@s.whatsapp.net', name: 'Johnny', t: 100 },
        { id: '456@s.whatsapp.net', name: 'Alice', t: 200 },
    ];
    const out = utils.filterChats(chats, '', ['stale-removed@s.whatsapp.net', 'johnny'], false);
    assert.deepEqual(out.map(c => c.id), ['123@s.whatsapp.net', '456@s.whatsapp.net']);
});

test('filterChats tolerates empty / null inputs and never mutates the list', () => {
    assert.deepEqual(utils.filterChats(null, '', [], false), []);
    assert.deepEqual(utils.filterChats([], '', null, true), []);
    assert.deepEqual(utils.filterChats(undefined, null, undefined, false), []);
    const chats = [{ id: '1@x', name: 'Solo', t: 1 }];
    const out = utils.filterChats(chats, 'solo', null, false);
    assert.deepEqual(out.map(c => c.id), ['1@x']);
    assert.equal(chats.length, 1);      // input untouched
    assert.notEqual(out, chats);        // fresh array returned
});
