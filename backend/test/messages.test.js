'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const messages = require('../lib/messages');

const HISTORY = [
    { id: 'm1', t: 100, body: 'one' },
    { id: 'm2', t: 200, body: 'two' },
    { id: 'm3', t: 300, body: 'three' },
];

// ── filterMessagesSince ──────────────────────────────────────────────────────
test('filterMessagesSince returns everything when since is null', () => {
    assert.deepEqual(messages.filterMessagesSince(HISTORY, null), HISTORY);
});

test('filterMessagesSince slices after the known message id', () => {
    const out = messages.filterMessagesSince(HISTORY, { id: 'm2', t: 200 });
    assert.deepEqual(out, [HISTORY[2]]);
});

test('filterMessagesSince falls back to timestamp when id is unknown', () => {
    const out = messages.filterMessagesSince(HISTORY, { id: 'nope', t: 200 });
    assert.deepEqual(out, [HISTORY[2]]);
});

test('filterMessagesSince accepts a bare timestamp number', () => {
    const out = messages.filterMessagesSince(HISTORY, 200);
    assert.deepEqual(out, [HISTORY[2]]);
});

test('filterMessagesSince returns empty when nothing is new', () => {
    assert.deepEqual(messages.filterMessagesSince(HISTORY, { id: 'm3', t: 300 }), []);
});

test('filterMessagesSince on empty history is empty', () => {
    assert.deepEqual(messages.filterMessagesSince([], { id: 'm3', t: 300 }), []);
});
