'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSince, filterMessagesSince, paginateMessages } = require('../lib/messages');

// ── paginateMessages: tail window (no beforeId) ─────────────────────────────

function mkMsgs(n) {
    const out = [];
    for (let i = 1; i <= n; i++) out.push({ id: 'm' + i, body: 'msg ' + i, t: i });
    return out;
}

test('paginateMessages returns the last page with hasMore', () => {
    const r = paginateMessages(mkMsgs(50), { limit: 20 });
    assert.equal(r.page.length, 20);
    assert.equal(r.page[0].id, 'm31');
    assert.equal(r.page[19].id, 'm50');
    assert.equal(r.hasMore, true);
});

test('paginateMessages returns everything when fewer than limit', () => {
    const r = paginateMessages(mkMsgs(12), { limit: 20 });
    assert.equal(r.page.length, 12);
    assert.equal(r.page[0].id, 'm1');
    assert.equal(r.hasMore, false);
});

test('paginateMessages defaults to limit 20 and caps at 200', () => {
    assert.equal(paginateMessages(mkMsgs(30), {}).page.length, 20);
    assert.equal(paginateMessages(mkMsgs(500), { limit: 9999 }).page.length, 200);
    assert.equal(paginateMessages(mkMsgs(30), { limit: -5 }).page.length, 20);
});

test('paginateMessages handles an empty list', () => {
    const r = paginateMessages([], { limit: 20 });
    assert.deepEqual(r.page, []);
    assert.equal(r.hasMore, false);
    assert.equal(paginateMessages(null, { limit: 20 }).hasMore, false);
});

// ── paginateMessages: beforeId window ───────────────────────────────────────

test('paginateMessages returns the 20 messages before the anchor', () => {
    const r = paginateMessages(mkMsgs(50), { limit: 20, beforeId: 'm30' });
    assert.equal(r.page.length, 20);
    assert.equal(r.page[0].id, 'm10');
    assert.equal(r.page[19].id, 'm29');
    assert.equal(r.hasMore, true);
});

test('paginateMessages clamps at the start of the list', () => {
    const r = paginateMessages(mkMsgs(25), { limit: 20, beforeId: 'm10' });
    assert.equal(r.page.length, 9);
    assert.equal(r.page[0].id, 'm1');
    assert.equal(r.page[8].id, 'm9');
    assert.equal(r.hasMore, false);
});

test('paginateMessages: anchor at index 0 yields an empty page', () => {
    const r = paginateMessages(mkMsgs(50), { limit: 20, beforeId: 'm1' });
    assert.deepEqual(r.page, []);
    assert.equal(r.hasMore, false);
});

test('paginateMessages: unknown beforeId is a safe empty no-op', () => {
    const r = paginateMessages(mkMsgs(50), { limit: 20, beforeId: 'dom_msg_7' });
    assert.deepEqual(r.page, []);
    assert.equal(r.hasMore, false);
    assert.equal(paginateMessages(mkMsgs(50), { limit: 20, beforeId: '' }).page.length, 20);
});

test('paginateMessages: beforeT anchors when the id is missing', () => {
    // Anchor on the first message with t >= 30 (i.e. m30).
    const r = paginateMessages(mkMsgs(50), { limit: 5, beforeId: 'gone', beforeT: 30 });
    assert.equal(r.page.length, 5);
    assert.equal(r.page[0].id, 'm25');
    assert.equal(r.page[4].id, 'm29');
    assert.equal(r.hasMore, true);
});

test('paginateMessages: since-style filtering still works alongside', () => {
    const msgs = mkMsgs(50);
    const filtered = filterMessagesSince(msgs, { id: 'm45', t: 45 });
    assert.equal(filtered.length, 5);
    const p = paginateMessages(filtered, { limit: 20 });
    assert.equal(p.page.length, 5);
    assert.equal(p.hasMore, false);
    assert.equal(parseSince('123').t, 123);
});
