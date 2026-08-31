'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poll = require('../../widget/contents/ui/pollingUtils.js');

// ── nextMessagePollInterval ──────────────────────────────────────────────────
test('nextMessagePollInterval starts at the base interval', () => {
    assert.equal(poll.nextMessagePollInterval(5000, 30000, 0), 5000);
});

test('nextMessagePollInterval backs off exponentially and caps', () => {
    assert.equal(poll.nextMessagePollInterval(5000, 30000, 1), 10000);
    assert.equal(poll.nextMessagePollInterval(5000, 30000, 2), 20000);
    assert.equal(poll.nextMessagePollInterval(5000, 30000, 3), 30000);
    assert.equal(poll.nextMessagePollInterval(5000, 30000, 10), 30000);
});

// ── mergeMessages ────────────────────────────────────────────────────────────
test('mergeMessages appends new messages after the existing ones', () => {
    const existing = [{ id: 'm1', t: 100 }, { id: 'm2', t: 200 }];
    const fresh = [{ id: 'm3', t: 300 }];
    const out = poll.mergeMessages(existing, fresh);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m1', 'm2', 'm3']);
});

test('mergeMessages updates in place (e.g. reactions changed)', () => {
    const existing = [{ id: 'm1', t: 100, reactions: [] }, { id: 'm2', t: 200 }];
    const fresh = [{ id: 'm1', t: 100, reactions: [{ emoji: '❤️' }] }];
    const out = poll.mergeMessages(existing, fresh);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].reactions, [{ emoji: '❤️' }]);
});

test('mergeMessages inserts a backfilled message in t order', () => {
    const existing = [{ id: 'm2', t: 200 }];
    const fresh = [{ id: 'm1', t: 100 }];
    const out = poll.mergeMessages(existing, fresh);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m1', 'm2']);
});

test('mergeMessages returns the fresh list when existing is empty', () => {
    const fresh = [{ id: 'm1', t: 100 }];
    assert.deepEqual(poll.mergeMessages([], fresh), fresh);
});

test('mergeMessages is a no-op when fresh is empty', () => {
    const existing = [{ id: 'm1', t: 100 }];
    assert.deepEqual(poll.mergeMessages(existing, []), existing);
});

// ── debounce decision (pure helper for the search bar) ──────────────────────
test('debounceDelay returns the configured delay', () => {
    assert.equal(poll.debounceDelay(150), 150);
    assert.equal(poll.debounceDelay(0), 150); // falls back to default
});
