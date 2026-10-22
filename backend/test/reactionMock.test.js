'use strict';

// Reaction round-trip through test/mockBackend.js (AC-001/002/003/005):
// send → fetch → aggregate → toggle-off, plus the sig + since-poll
// analog for reaction-only edits. Spawns the mock as a child process so
// these tests exercise the real HTTP surface (the mock binds a port on
// require, so it cannot be required in-process).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const MsgUtils = require('../../widget/contents/ui/messageUtils.js');

const PORT = 18083;
const BASE = 'http://127.0.0.1:' + PORT;
const CHAT_A = 'mock_chat_a@s.whatsapp.net';

let child = null;

async function post(apiPath, args) {
    const res = await fetch(BASE + apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: args || {} }),
    });
    assert.equal(res.status, 200);
    return res.json();
}

async function fetchAll() {
    const out = await post('/api/getChatMessages', { chatId: CHAT_A, limit: 200 });
    assert.ok(Array.isArray(out.response));
    return out;
}

function byId(msgs, id) {
    return msgs.find(m => String(m.id) === String(id));
}

function parseSig(sig) {
    // Prod-shaped: len:lastId:lastT:rxCount:rxMarkers…
    const parts = String(sig).split(':');
    return {
        len: Number(parts[0]),
        lastId: parts[1],
        lastT: Number(parts[2]),
        rxCount: Number(parts[3]),
    };
}

before(async () => {
    const mockPath = path.join(__dirname, '..', '..', 'test', 'mockBackend.js');
    child = spawn(process.execPath, [mockPath, String(PORT)], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 10000;
    for (;;) {
        try {
            const res = await fetch(BASE + '/api/status');
            if (res.ok) {
                const body = await res.json();
                if (body && body.ready) return;
            }
        } catch (e) { /* not up yet */ }
        if (Date.now() > deadline) throw new Error('mockBackend did not start on ' + PORT);
        await new Promise(r => setTimeout(r, 100));
    }
});

after(async () => {
    if (child) {
        child.kill('SIGKILL');
        child = null;
    }
});

// ── Reacted fixtures ─────────────────────────────────────────────────────────
test('mock ships reacted fixtures: own, others-only and multi-emoji', async () => {
    const { response } = await fetchAll();

    const own = byId(response, 'mock_msg_5');
    assert.deepEqual(own.reactions, [{ emoji: '👍', sender: '', fromMe: true }]);
    assert.deepEqual(MsgUtils.aggregateReactions(own.reactions),
        [{ emoji: '👍', count: 1, senders: [''], fromMe: true }]);

    const others = byId(response, 'mock_msg_6');
    assert.deepEqual(others.reactions, [{ emoji: '❤️', sender: 'Alice', fromMe: false }]);
    const othersAgg = MsgUtils.aggregateReactions(others.reactions);
    assert.equal(othersAgg.length, 1);
    assert.equal(othersAgg[0].fromMe, false);

    const multi = byId(response, 'mock_msg_7');
    const multiAgg = MsgUtils.aggregateReactions(multi.reactions);
    assert.deepEqual(multiAgg.map(r => r.emoji), ['❤️', '👍']);
    assert.equal(multiAgg[0].count, 1);
    assert.equal(multiAgg[1].count, 2);
    assert.equal(multiAgg[1].fromMe, true);

    // The unreacted majority is intact.
    const plain = byId(response, 'mock_msg_10');
    assert.deepEqual(plain.reactions, []);
});

// ── Send → fetch → aggregate (AC-001) ─────────────────────────────────────────
test('sendReaction adds own reaction; next fetch aggregates a chip', async () => {
    const sent = await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_10', reaction: '👍' });
    assert.deepEqual(sent.response, { ok: true });
    assert.ok(sent.method, 'method-like field mirrors prod {response, method} shape');

    const { response } = await fetchAll();
    const msg = byId(response, 'mock_msg_10');
    assert.ok(msg.reactions.some(r => r.emoji === '👍' && r.fromMe === true));
    const chips = MsgUtils.aggregateReactions(msg.reactions);
    assert.equal(chips.length, 1);
    assert.deepEqual(chips[0], { emoji: '👍', count: 1, senders: [''], fromMe: true });
});

// ── Toggle-off with remove=true (AC-002) ─────────────────────────────────────
test('toggle-off with remove=true clears the own chip', async () => {
    const sent = await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_10', reaction: '👍', remove: true });
    assert.deepEqual(sent.response, { ok: true });

    const { response } = await fetchAll();
    const msg = byId(response, 'mock_msg_10');
    assert.ok(!msg.reactions.some(r => r.emoji === '👍' && r.fromMe),
        'own 👍 entry removed, got: ' + JSON.stringify(msg.reactions));
    assert.deepEqual(MsgUtils.aggregateReactions(msg.reactions), []);
});

// ── Others-only chip + own add (AC-003) ───────────────────────────────────────
test('clicking an others-only chip adds own reaction (count grows, not removed)', async () => {
    await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_6', reaction: '❤️' });

    let out = await fetchAll();
    let msg = byId(out.response, 'mock_msg_6');
    let chips = MsgUtils.aggregateReactions(msg.reactions);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].emoji, '❤️');
    assert.equal(chips[0].count, 2);
    assert.equal(chips[0].fromMe, true);

    // Toggle-off afterwards removes only the own entry (AC-002 on a shared chip).
    await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_6', reaction: '❤️', remove: true });
    out = await fetchAll();
    msg = byId(out.response, 'mock_msg_6');
    chips = MsgUtils.aggregateReactions(msg.reactions);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].count, 1);
    assert.equal(chips[0].fromMe, false);
    assert.deepEqual(chips[0].senders, ['Alice']);
});

// ── Sig changes on reaction-only edit (AC-001/005) ────────────────────────────
test('reaction-only edit changes the mock sig (count/lastId/lastT stable)', async () => {
    const beforeSig = parseSig((await fetchAll()).sig);
    await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_11', reaction: '❤️' });
    const afterSig = parseSig((await fetchAll()).sig);

    assert.equal(afterSig.len, beforeSig.len);
    assert.equal(afterSig.lastId, beforeSig.lastId);
    assert.equal(afterSig.lastT, beforeSig.lastT);
    assert.equal(afterSig.rxCount, beforeSig.rxCount + 1);
});

// ── Since-poll delivers the reaction-touched row (AC-001/005) ─────────────────
test('since-poll still delivers a reaction-only touched row', async () => {
    const all = (await fetchAll()).response;
    const last = all[all.length - 1];

    await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_12', reaction: '🎉' });

    const out = await post('/api/getChatMessages',
        { chatId: CHAT_A, since: { id: last.id, t: last.t } });
    const touched = byId(out.response, 'mock_msg_12');
    assert.ok(touched, 'touched row delivered, got ids: ' +
        out.response.map(m => m.id).join(','));
    assert.ok(touched.reactions.some(r => r.emoji === '🎉' && r.fromMe === true));
    assert.ok(out.sig, 'since response still carries a sig');

    // Leave the dataset clean for any later consumer of this mock process.
    await post('/api/sendReaction',
        { chatId: CHAT_A, msgId: 'mock_msg_12', reaction: '🎉', remove: true });
});
