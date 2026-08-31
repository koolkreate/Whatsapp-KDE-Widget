'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const MsgUtils = require('../../widget/contents/ui/messageUtils.js');

// ── aggregateReactions ───────────────────────────────────────────────────────
test('aggregateReactions groups duplicate emojis with counts', () => {
    const raw = [
        { emoji: '❤️', sender: 'A', fromMe: false },
        { emoji: '❤️', sender: 'B', fromMe: false },
        { emoji: '👍', sender: 'C', fromMe: true },
    ];
    const out = MsgUtils.aggregateReactions(raw);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { emoji: '❤️', count: 2, senders: ['A', 'B'], fromMe: false });
    assert.deepEqual(out[1], { emoji: '👍', count: 1, senders: ['C'], fromMe: true });
});

test('aggregateReactions preserves first-seen emoji order', () => {
    const raw = [
        { emoji: '😂', sender: 'A' },
        { emoji: '👍', sender: 'B' },
        { emoji: '😂', sender: 'C' },
    ];
    const out = MsgUtils.aggregateReactions(raw);
    assert.deepEqual(out.map(r => r.emoji), ['😂', '👍']);
});

test('aggregateReactions sets fromMe when any contributor is me', () => {
    const raw = [
        { emoji: '😮', sender: 'A', fromMe: false },
        { emoji: '😮', sender: 'Me', fromMe: true },
    ];
    const out = MsgUtils.aggregateReactions(raw);
    assert.equal(out[0].fromMe, true);
});

test('aggregateReactions skips empty/malformed entries', () => {
    const raw = [
        null,
        { sender: 'x' },                  // no emoji
        { emoji: '   ', sender: 'y' },    // blank emoji
        { emoji: '🎉', sender: 'A' },
    ];
    const out = MsgUtils.aggregateReactions(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].emoji, '🎉');
});

test('aggregateReactions handles null/undefined/empty input', () => {
    assert.deepEqual(MsgUtils.aggregateReactions(null), []);
    assert.deepEqual(MsgUtils.aggregateReactions(undefined), []);
    assert.deepEqual(MsgUtils.aggregateReactions([]), []);
});

test('aggregateReactions tolerates missing sender names', () => {
    const out = MsgUtils.aggregateReactions([{ emoji: '🔥' }, { emoji: '🔥', sender: '' }]);
    assert.equal(out[0].count, 2);
    assert.deepEqual(out[0].senders, ['', '']);
});
