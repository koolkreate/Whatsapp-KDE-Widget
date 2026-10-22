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

// ── Cold-open queue (never silently drop a chat open) ───────────────────────
test('shouldQueueColdOpen queues a cold open blocked by an in-flight poll', () => {
    assert.equal(poll.shouldQueueColdOpen(true, false), true);
    assert.equal(poll.shouldQueueColdOpen(true, undefined), true);
});

test('shouldQueueColdOpen never queues background polls', () => {
    assert.equal(poll.shouldQueueColdOpen(true, true), false);
    assert.equal(poll.shouldQueueColdOpen(false, false), false);
});

test('consumePendingOpen drains only when the pending chat is still open', () => {
    assert.equal(poll.consumePendingOpen('chatB', 'chatB'), 'chatB');
    assert.equal(poll.consumePendingOpen('chatB', 'chatC'), '');
    assert.equal(poll.consumePendingOpen('', 'chatB'), '');
});

// ── Wait-loop generation ─────────────────────────────────────────────────────
test('isStaleLoop detects a loop from a previous chat', () => {
    assert.equal(poll.isStaleLoop(1, 2), true);
    assert.equal(poll.isStaleLoop(2, 2), false);
});
test('debounceDelay returns the configured delay', () => {
    assert.equal(poll.debounceDelay(150), 150);
    assert.equal(poll.debounceDelay(0), 150); // falls back to default
});

// ── prependOlder (top-edge pagination, Slice 2) ──────────────────────────────
test('prependOlder puts the older page above and keeps t order', () => {
    const existing = [{ id: 'm31', t: 310 }, { id: 'm32', t: 320 }];
    const older = [{ id: 'm29', t: 290 }, { id: 'm30', t: 300 }];
    const out = poll.prependOlder(existing, older);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m29', 'm30', 'm31', 'm32']);
    assert.equal(existing.length, 2); // inputs untouched
});

test('prependOlder dedupes overlapping messages', () => {
    const existing = [{ id: 'm30', t: 300 }, { id: 'm31', t: 310 }];
    const older = [{ id: 'm29', t: 290 }, { id: 'm30', t: 300 }];
    const out = poll.prependOlder(existing, older);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m29', 'm30', 'm31']);
});

test('prependOlder is a no-op for an empty or fully-duplicate page', () => {
    const existing = [{ id: 'm30', t: 300 }];
    assert.equal(poll.prependOlder(existing, []), existing);
    assert.equal(poll.prependOlder(existing, [{ id: 'm30', t: 300 }]), existing);
    assert.deepEqual(poll.prependOlder([], [{ id: 'm1', t: 1 }]), []);
});

test('prependOlder backfills correctly even when ids arrive unordered', () => {
    const existing = [{ id: 'm10', t: 100 }];
    const older = [{ id: 'm9', t: 90 }, { id: 'm5', t: 50 }, { id: 'm7', t: 70 }];
    const out = poll.prependOlder(existing, older);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m5', 'm7', 'm9', 'm10']);
});

// ── reconcileOptimistic / settleMessages (send-vs-poll race) ─────────────────

test('reconcileOptimistic drops a temp once the server confirmed it', () => {
    const msgs = [
        { id: 'm1', body: 'hi', t: 100, fromMe: false },
        { id: 'temp_1', body: 'my reply', t: 150, fromMe: true },
        { id: 'real_1', body: 'my reply', t: 151, fromMe: true },
    ];
    const out = poll.reconcileOptimistic(msgs);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m1', 'real_1']);
});

test('reconcileOptimistic keeps a temp the server has not confirmed yet', () => {
    const msgs = [
        { id: 'm1', body: 'hi', t: 100, fromMe: false },
        { id: 'temp_1', body: 'my reply', t: 150, fromMe: true },
    ];
    const out = poll.reconcileOptimistic(msgs);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m1', 'temp_1']);
});

test('reconcileOptimistic ignores real messages outside the time window', () => {
    const msgs = [
        { id: 'temp_1', body: 'brb', t: 150, fromMe: true },
        { id: 'real_old', body: 'brb', t: 100, fromMe: true }, // 50s+ apart... within? 50 <= 120
        { id: 'real_far', body: 'brb', t: 1500, fromMe: true }, // way outside
    ];
    const out = poll.reconcileOptimistic(msgs);
    // real_old (dt=50) confirms the temp; real_far stays
    assert.deepEqual(out.map(function (m) { return m.id; }), ['real_old', 'real_far']);
});

test('reconcileOptimistic requires one real message per temp (double send)', () => {
    const msgs = [
        { id: 'temp_1', body: 'same', t: 100, fromMe: true },
        { id: 'temp_2', body: 'same', t: 101, fromMe: true },
        { id: 'real_1', body: 'same', t: 102, fromMe: true },
    ];
    const out = poll.reconcileOptimistic(msgs);
    // Only one temp is confirmed; the other stays until its own real arrives.
    assert.equal(out.filter(function (m) { return String(m.id).indexOf('temp_') === 0; }).length, 1);
    assert.equal(out.filter(function (m) { return m.id === 'real_1'; }).length, 1);
});

test('reconcileOptimistic does not match incoming messages or different bodies', () => {
    const msgs = [
        { id: 'temp_1', body: 'hello', t: 100, fromMe: true },
        { id: 'r1', body: 'hello!', t: 101, fromMe: true },  // different body
        { id: 'r2', body: 'hello', t: 102, fromMe: false },  // not mine
    ];
    const out = poll.reconcileOptimistic(msgs);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['temp_1', 'r1', 'r2']);
});

test('settleMessages merges against the live list and reconciles temps', () => {
    // Live list gained a temp AFTER the poll request captured nothing;
    // fresh contains the real send + an incoming message.
    const live = [{ id: 'm1', body: 'hi', t: 100, fromMe: false },
                  { id: 'temp_1', body: 'my reply', t: 150, fromMe: true }];
    const fresh = [{ id: 'm1', body: 'hi', t: 100, fromMe: false },
                   { id: 'm2', body: 'incoming!', t: 160, fromMe: false },
                   { id: 'real_1', body: 'my reply', t: 155, fromMe: true }];
    const out = poll.settleMessages(live, fresh);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m1', 'real_1', 'm2']);
});

test('settleMessages preserves an in-flight temp across a poll', () => {
    const live = [{ id: 'm1', t: 100, fromMe: false },
                  { id: 'temp_1', body: 'still sending', t: 150, fromMe: true }];
    const fresh = [{ id: 'm1', t: 100, fromMe: false },
                   { id: 'm2', body: 'someone else', t: 160, fromMe: false }];
    const out = poll.settleMessages(live, fresh);
    assert.deepEqual(out.map(function (m) { return m.id; }), ['m1', 'temp_1', 'm2']);
});
