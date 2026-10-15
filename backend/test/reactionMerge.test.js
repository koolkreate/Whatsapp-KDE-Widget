'use strict';

// Reaction merge-in-place coverage (AC-001/002/003): a reaction-only diff
// (same id, only reactions differ) must update the merged row without
// disturbing order or timestamps. Pure unit tests over pollingUtils +
// messageUtils, matching the style of pollingUtils.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poll = require('../../widget/contents/ui/pollingUtils.js');
const MsgUtils = require('../../widget/contents/ui/messageUtils.js');

// ── mergeMessages with reaction-only diffs ────────────────────────────────────
test('mergeMessages carries new reactions onto the existing row, order/t stable', () => {
    const existing = [
        { id: 'm1', t: 100, body: 'one', reactions: [] },
        { id: 'm2', t: 200, body: 'two', reactions: [] },
    ];
    const fresh = [
        { id: 'm1', t: 100, body: 'one', reactions: [{ emoji: '👍', sender: '', fromMe: true }] },
        { id: 'm2', t: 200, body: 'two', reactions: [] },
    ];
    const out = poll.mergeMessages(existing, fresh);
    assert.deepEqual(out.map(m => m.id), ['m1', 'm2']);
    assert.deepEqual(out.map(m => m.t), [100, 200]);
    assert.deepEqual(out[0].reactions, [{ emoji: '👍', sender: '', fromMe: true }]);
    assert.deepEqual(out[1].reactions, []);
});

test('mergeMessages replaces the emoji set (multi-emoji add and toggle-off removal)', () => {
    const existing = [
        {
            id: 'm1', t: 100, reactions: [
                { emoji: '❤️', sender: 'Kwame', fromMe: false },
                { emoji: '👍', sender: '', fromMe: true },
            ],
        },
    ];
    // Own 👍 toggled off server-side; other 👍 plus a new 😂 remain.
    const fresh = [
        {
            id: 'm1', t: 100, reactions: [
                { emoji: '❤️', sender: 'Kwame', fromMe: false },
                { emoji: '👍', sender: 'Ama', fromMe: false },
                { emoji: '😂', sender: '', fromMe: true },
            ],
        },
    ];
    const out = poll.mergeMessages(existing, fresh);
    assert.equal(out.length, 1);
    const chips = MsgUtils.aggregateReactions(out[0].reactions);
    assert.deepEqual(chips.map(c => c.emoji), ['❤️', '👍', '😂']);
    assert.equal(chips[1].count, 1);
    assert.equal(chips[1].fromMe, false);
    assert.equal(chips[2].fromMe, true);
});

test('mergeMessages appends a brand-new reacted message in t order', () => {
    const existing = [{ id: 'm1', t: 100, reactions: [] }];
    const fresh = [
        { id: 'm1', t: 100, reactions: [] },
        { id: 'm2', t: 200, reactions: [{ emoji: '🎉', sender: 'Ama', fromMe: false }] },
    ];
    const out = poll.mergeMessages(existing, fresh);
    assert.deepEqual(out.map(m => m.id), ['m1', 'm2']);
    assert.equal(MsgUtils.aggregateReactions(out[1].reactions)[0].emoji, '🎉');
});

test('mergeMessages leaves rows absent from fresh untouched', () => {
    const existing = [
        { id: 'm1', t: 100, reactions: [{ emoji: '👍', sender: '', fromMe: true }] },
        { id: 'm2', t: 200, reactions: [{ emoji: '❤️', sender: 'A', fromMe: false }] },
    ];
    // Incremental since-poll returns only the touched row.
    const fresh = [
        { id: 'm2', t: 200, reactions: [
            { emoji: '❤️', sender: 'A', fromMe: false },
            { emoji: '❤️', sender: '', fromMe: true },
        ] },
    ];
    const out = poll.mergeMessages(existing, fresh);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].reactions, [{ emoji: '👍', sender: '', fromMe: true }]);
    assert.equal(MsgUtils.aggregateReactions(out[1].reactions)[0].count, 2);
});

// ── settleMessages with reaction updates ──────────────────────────────────────
test('settleMessages applies a reaction-only update while preserving in-flight temps', () => {
    const live = [
        { id: 'm1', t: 100, body: 'hi', fromMe: false, reactions: [] },
        { id: 'temp_1', t: 150, body: 'my reply', fromMe: true },
    ];
    const fresh = [
        { id: 'm1', t: 100, body: 'hi', fromMe: false,
          reactions: [{ emoji: '👍', sender: '', fromMe: true }] },
    ];
    const out = poll.settleMessages(live, fresh);
    assert.deepEqual(out.map(m => m.id), ['m1', 'temp_1']);
    assert.deepEqual(out[0].reactions, [{ emoji: '👍', sender: '', fromMe: true }]);
});
