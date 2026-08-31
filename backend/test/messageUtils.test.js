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