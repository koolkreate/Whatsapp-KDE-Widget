'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// MessageUtils is shared plain JS loaded both by the widget QML and by Node.
const utils = require('../../widget/contents/ui/messageUtils.js');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_B64 = '/9j/AAABCsomejpegbytes';

// ── isMediaBody ─────────────────────────────────────────────────────────────

test('isMediaBody recognises raw base64 and data-URL bodies as media bytes', () => {
    assert.equal(utils.isMediaBody(JPEG_B64), true);
    assert.equal(utils.isMediaBody(PNG_B64), true);
    assert.equal(utils.isMediaBody('data:image/jpeg;base64,AAAA'), true);
    assert.equal(utils.isMediaBody('data:video/mp4;base64,AAAA'), true);
});

test('isMediaBody treats caption text as NOT media bytes', () => {
    assert.equal(utils.isMediaBody('Check out this sunset pic 🌅'), false);
    assert.equal(utils.isMediaBody(''), false);
    assert.equal(utils.isMediaBody(null), false);
    assert.equal(utils.isMediaBody(undefined), false);
    assert.equal(utils.isMediaBody(12345), false);
});

// ── mediaCaption ────────────────────────────────────────────────────────────

test('mediaCaption returns the body when it is real text', () => {
    assert.equal(utils.mediaCaption({ body: 'Nice shot!' }), 'Nice shot!');
    assert.equal(utils.mediaCaption({ caption: 'From caption field' }), 'From caption field');
});

test('mediaCaption returns "" when the body is media bytes or missing', () => {
    assert.equal(utils.mediaCaption({ body: JPEG_B64 }), '');
    assert.equal(utils.mediaCaption({ body: PNG_B64 }), '');
    assert.equal(utils.mediaCaption({ body: '' }), '');
    assert.equal(utils.mediaCaption({}), '');
    assert.equal(utils.mediaCaption(null), '');
});

// ── isMediaMessage ──────────────────────────────────────────────────────────

test('isMediaMessage flags typed media and raw media bodies (incl. captioned image)', () => {
    assert.equal(utils.isMediaMessage({ type: 'image', body: 'a caption' }), true);
    assert.equal(utils.isMediaMessage({ type: 'chat', body: JPEG_B64 }), true);
    assert.equal(utils.isMediaMessage({ type: 'chat', body: 'plain text' }), false);
    assert.equal(utils.isMediaMessage(null), false);
});

// ── mediaSource (never turns a caption into a broken data-URL) ──────────────

test('mediaSource prefixes raw base64 bodies into data-URLs', () => {
    assert.equal(utils.mediaSource({ body: JPEG_B64 }), 'data:image/jpeg;base64,' + JPEG_B64);
    assert.equal(utils.mediaSource({ body: PNG_B64 }), 'data:image/png;base64,' + PNG_B64);
    assert.equal(utils.mediaSource({ body: 'data:image/png;base64,XX' }), 'data:image/png;base64,XX');
});

test('mediaSource must NOT prefix a caption body — it falls back to thumbUrl', () => {
    assert.equal(utils.mediaSource({ body: 'sunset caption', thumbUrl: 'data:image/jpeg;base64,THUMB' }),
                 'data:image/jpeg;base64,THUMB');
    assert.equal(utils.mediaSource({ body: 'sunset caption', thumbUrl: '' }), '');
});

// ── mediaPreviewSource (caption + thumb priority) ───────────────────────────

test('mediaPreviewSource prefers thumbUrl for captioned media', () => {
    assert.equal(utils.mediaPreviewSource({ body: 'caption', thumbUrl: 'data:image/jpeg;base64,T' }),
                 'data:image/jpeg;base64,T');
    // Large inline body (> MICRO_BODY_MAX) still beats the micro thumb.
    const big = JPEG_B64 + 'x'.repeat(5000);
    assert.equal(utils.mediaPreviewSource({ body: big, thumbUrl: 'data:image/jpeg;base64,T' }),
                 'data:image/jpeg;base64,' + big);
});

// ── needsThumb (captioned media without thumb must fetch one) ───────────────

test('needsThumb is true for a captioned image without thumbUrl', () => {
    assert.equal(utils.needsThumb({ type: 'image', body: 'a caption', thumbUrl: '' }), true);
    assert.equal(utils.needsThumb({ type: 'image', body: 'a caption', thumbUrl: 'data:image/png;base64,X' }), false);
    // A genuinely large inline body is a usable preview — no fetch needed.
    assert.equal(utils.needsThumb({ type: 'image', body: '/9j/' + 'A'.repeat(5000) }), false);
    assert.equal(utils.needsThumb({ type: 'chat', body: 'text' }), false);
});

// ── copy / reply previews (caption-aware) ───────────────────────────────────

test('copyTextForMessage returns the caption for captioned media', () => {
    assert.equal(utils.copyTextForMessage({ type: 'image', body: 'Beach day ☀️' }), 'Beach day ☀️');
    assert.equal(utils.copyTextForMessage({ type: 'image', body: '' }), '📷 Photo');
    assert.equal(utils.copyTextForMessage({ body: 'plain text' }), 'plain text');
});

test('replyPreviewText returns the caption for captioned media (truncated)', () => {
    assert.equal(utils.replyPreviewText({ type: 'image', body: 'Look at this' }), 'Look at this');
    assert.equal(utils.replyPreviewText({ type: 'image', body: 'x'.repeat(80) }),
                 'x'.repeat(59) + '…');
    assert.equal(utils.replyPreviewText({ type: 'image', body: '' }), '📷 Photo');
});

// ── buildMediaList (captioned images stay navigable in the viewer) ──────────

test('buildMediaList includes captioned image and raw-body messages', () => {
    const msgs = [
        { id: '1', type: 'chat', body: 'just text' },
        { id: '2', type: 'image', body: 'sunset caption' },
        { id: '3', type: 'chat', body: PNG_B64 },
        { id: '4', type: 'video', body: '' },
    ];
    const list = utils.buildMediaList(msgs);
    assert.deepEqual(list.map(m => m.id), ['2', '3', '4']);
});
