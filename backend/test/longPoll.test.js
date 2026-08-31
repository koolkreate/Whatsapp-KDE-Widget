'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const longPoll = require('../lib/longPoll');

// ── waitForSigChange ─────────────────────────────────────────────────────────
test('resolves immediately when the signature already changed', async () => {
    let calls = 0;
    const out = await longPoll.waitForSigChange({
        getSig: function () { calls++; return 'sig2'; },
        knownSig: 'sig1',
        intervalMs: 10,
        timeoutMs: 1000,
        sleep: function () { return Promise.resolve(); }
    });
    assert.equal(out.changed, true);
    assert.equal(out.sig, 'sig2');
    assert.equal(calls, 1);
});

test('resolves immediately when knownSig is empty (first attach)', async () => {
    const out = await longPoll.waitForSigChange({
        getSig: function () { return 'sig1'; },
        knownSig: '',
        intervalMs: 10,
        timeoutMs: 1000,
        sleep: function () { return Promise.resolve(); }
    });
    assert.equal(out.changed, true);
    assert.equal(out.sig, 'sig1');
});

test('keeps polling until the signature changes', async () => {
    const sigs = ['a', 'a', 'a', 'b'];
    let i = 0;
    let sleeps = 0;
    const out = await longPoll.waitForSigChange({
        getSig: function () { return sigs[Math.min(i++, sigs.length - 1)]; },
        knownSig: 'a',
        intervalMs: 10,
        timeoutMs: 10000,
        sleep: function () { sleeps++; return Promise.resolve(); }
    });
    assert.equal(out.changed, true);
    assert.equal(out.sig, 'b');
    assert.ok(sleeps >= 2);
});

test('times out with changed=false when nothing changes', async () => {
    const out = await longPoll.waitForSigChange({
        getSig: function () { return 'same'; },
        knownSig: 'same',
        intervalMs: 10,
        timeoutMs: 50,
        sleep: function (ms) { return new Promise(r => setTimeout(r, ms)); }
    });
    assert.equal(out.changed, false);
    assert.equal(out.sig, 'same');
});

test('getSig errors are treated as "no change" and retried', async () => {
    let fail = true;
    const out = await longPoll.waitForSigChange({
        getSig: function () {
            if (fail) throw new Error('scrape failed');
            return 'done';
        },
        knownSig: 'x',
        intervalMs: 5,
        timeoutMs: 400,
        sleep: function (ms) { return new Promise(r => setTimeout(r, ms)); }
    }).then(function (v) { return v; }, function () { return { error: true }; });

    // Must NOT reject; it either recovers or times out gracefully.
    assert.ok(!out.error);
    assert.equal(out.changed, false);
    assert.equal(fail, true);
});
