'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const reply = require('../lib/reply');

// ── matchDataId ─────────────────────────────────────────────────────────────
test('matchDataId matches exact ids', () => {
    assert.equal(reply.matchDataId('true_123@g.us_ABC123', 'true_123@g.us_ABC123'), true);
});

test('matchDataId matches by containment (prefix-only target)', () => {
    assert.equal(reply.matchDataId('false_100@g.us_ABC123', '100@g.us_ABC123'), true);
});

test('matchDataId matches by trailing hash segment when jid differs', () => {
    assert.equal(reply.matchDataId('A_999XYZ99_ABCDEF', 'Q_ABCDEF'), true);
});

test('matchDataId returns false for unrelated ids', () => {
    assert.equal(reply.matchDataId('true_1@g.us_AAAA', 'false_9@g.us_BBBB'), false);
    assert.equal(reply.matchDataId('', 'x'), false);
});

// ── normalizeSendMsgArgs ─────────────────────────────────────────────────────
test('normalizeSendMsgArgs reads to/content from {args}', () => {
    assert.deepEqual(
        reply.normalizeSendMsgArgs({ args: { to: '123@g.us', content: 'hi', replyToId: 'A_B' } }),
        { chatId: '123@g.us', text: 'hi', replyToId: 'A_B' }
    );
});

test('normalizeSendMsgArgs accepts chatId/text as alternatives', () => {
    assert.deepEqual(
        reply.normalizeSendMsgArgs({ chatId: '44@s.whatsapp.net', text: 'yo' }),
        { chatId: '44@s.whatsapp.net', text: 'yo', replyToId: '' }
    );
});

test('normalizeSendMsgArgs co-erces numbers and nullish to strings', () => {
    const out = reply.normalizeSendMsgArgs({ to: 123, content: 42, replyToId: null });
    assert.equal(out.chatId, '123');
    assert.equal(out.text, '42');
    assert.equal(out.replyToId, '');
});

// ── validateSendArgs ─────────────────────────────────────────────────────────
test('validateSendArgs rejects when chatId missing', () => {
    assert.ok(reply.validateSendArgs({ chatId: '', text: 'hi' }));
});

test('validateSendArgs rejects when text empty/blank', () => {
    assert.ok(reply.validateSendArgs({ chatId: '123', text: '   ' }));
    assert.ok(reply.validateSendArgs({ chatId: '123', text: '' }));
});

test('validateSendArgs returns null for valid input', () => {
    assert.equal(reply.validateSendArgs({ chatId: '123', text: 'hi' }), null);
});

// ── isReply ──────────────────────────────────────────────────────────────────
test('isReply true only when replyToId present', () => {
    assert.equal(reply.isReply({ chatId: 'x', text: 'y', replyToId: 'A1' }), true);
    assert.equal(reply.isReply({ chatId: 'x', text: 'y', replyToId: '' }), false);
    assert.equal(reply.isReply({ chatId: 'x', text: 'y' }), false);
});

// ── probeReplyMessage ────────────────────────────────────────────────────────
function makeElement(dataId) {
    const events = [];
    return {
        _dataId: dataId,
        _events: events,
        getAttribute: function (name) {
            return name === 'data-id' ? this._dataId : null;
        },
        dispatchEvent: function (ev) {
            this._events.push(ev);
            return true;
        }
    };
}

function makeDocument(elements) {
    return {
        querySelector: function (sel) {
            const m = /data-id="([^"]*)"/.exec(sel);
            if (!m) return null;
            for (const el of elements) {
                if ((el._dataId || '') === m[1]) return el;
            }
            return null;
        },
        querySelectorAll: function () {
            return elements;
        }
    };
}

test('probeReplyMessage finds exact data-id and dispatches a right-click sequence', () => {
    const msg = makeElement('ABC123');
    const doc = makeDocument([msg]);
    const fakeME = function (type, init) { return { type: type, ...init }; };

    const out = reply.probeReplyMessage({ document: doc, MouseEvent: fakeME, msgId: 'ABC123' });
    assert.equal(out.found, true);
    assert.equal(msg._events.length, 3);
    assert.equal(msg._events[0].type, 'mousedown');
    assert.equal(msg._events[1].type, 'mouseup');
    assert.equal(msg._events[2].type, 'contextmenu');
});

test('probeReplyMessage finds message via trailing-hash match against rendered data-id', () => {
    // Rendered row uses a (remapped) jid; target only carries the hash tail.
    const msg = makeElement('false_135789837070555@lid_AC69BDB04FCD8');
    const doc = makeDocument([msg]);
    const fakeME = function (type, init) { return { type, ...init }; };

    const out = reply.probeReplyMessage({ document: doc, MouseEvent: fakeME, msgId: 'AC69BDB04FCD8' });
    assert.equal(out.found, true);
    assert.equal(msg._events.length, 3);
});

test('probeReplyMessage falls back to prefix match among rendered messages', () => {
    const msg = makeElement('123456@g.us_1_fullid');
    const doc = makeDocument([msg]);
    const fakeME = function (type, init) { return { type, ...init }; };

    const out = reply.probeReplyMessage({ document: doc, MouseEvent: fakeME, msgId: '1_fullid' });
    assert.equal(out.found, true);
});

test('probeReplyMessage returns found=false when message absent', () => {
    const doc = makeDocument([]);
    const out = reply.probeReplyMessage({ document: doc, MouseEvent: function () {}, msgId: 'ZZZ' });
    assert.equal(out.found, false);
});

test('probeReplyMessage uses browser globals when no deps injected (page.evaluate path)', () => {
    const msg = makeElement('G1');
    const doc = makeDocument([msg]);
    const orig = { document: global.document, MouseEvent: global.MouseEvent };
    global.document = doc;
    global.MouseEvent = function (type, init) { return { type, ...init }; };
    try {
        const out = reply.probeReplyMessage('G1');
        assert.equal(out.found, true);
    } finally {
        global.document = orig.document;
        global.MouseEvent = orig.MouseEvent;
    }
});

// ── clickReplyMenuItem ───────────────────────────────────────────────────────
function makeClickable(text) {
    const el = { textContent: text || '' };
    el._clicks = 0;
    el.click = function () { el._clicks++; };
    return el;
}

test('clickReplyMenuItem clicks the reply item by data-testid', () => {
    const item = makeClickable('Reply');
    const doc = {
        querySelector: function (sel) {
            return /data-testid="reply"/.test(sel) ? item : null;
        },
        querySelectorAll: function () { return []; }
    };
    const out = reply.clickReplyMenuItem({ document: doc });
    assert.equal(out.clicked, true);
    assert.equal(item._clicks, 1);
});

test('clickReplyMenuItem falls back to role=menuitem text match', () => {
    const notReply = makeClickable('Archive');
    const replyItem = makeClickable('Reply');
    const doc = {
        querySelector: function () { return null; },
        querySelectorAll: function () { return [notReply, replyItem]; }
    };
    const out = reply.clickReplyMenuItem({ document: doc });
    assert.equal(out.clicked, true);
    assert.equal(replyItem._clicks, 1);
    assert.equal(notReply._clicks, 0);
});

test('clickReplyMenuItem returns clicked=false when nothing found', () => {
    const doc = {
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; }
    };
    assert.equal(reply.clickReplyMenuItem({ document: doc }).clicked, false);
});

// ── sendNativeReply ──────────────────────────────────────────────────────────
function makeFakeWindow(opts) {
    const target = { id: { _serialized: opts.msgId, fromMe: false }, body: 'hello' };
    const sentMsgs = [];
    let msgs = [target];

    const sendFn = function (chat, text, o) {
        sendFn._calls.push({ chat: chat, text: text, opts: o });
        if (opts.sendFails) return Promise.reject(new Error('boom'));
        // The new outgoing message appears after the call resolves.
        setTimeout(function () {
            const m = { id: { _serialized: 'true_1@g.us_NEW', fromMe: true }, body: text };
            if (opts.newMsgQuoted !== false) m.quotedMsg = target;
            msgs = msgs.concat([m]);
        }, 50);
        return Promise.resolve();
    };
    sendFn._calls = [];

    const chat = {
        msgs: {
            get: function (id) { return String(id) === opts.msgId ? target : null; },
            getModelsArray: function () { return msgs; }
        }
    };
    const win = {
        require: function (name) {
            if (name === 'WAWebChatCollection') return { ChatCollection: { get: function () { return chat; } } };
            if (name === 'WAWebSendTextMsgChatAction') return { sendTextMsgToChat: sendFn };
            throw new Error('unknown module ' + name);
        }
    };
    return { win: win, sendFn: sendFn, msgId: opts.msgId };
}

test('sendNativeReply sends quoted message via webpack and verifies the quote', async () => {
    const f = makeFakeWindow({ msgId: 'false_1@g.us_ABC' });
    const out = await reply.sendNativeReply({
        window: f.win, chatId: '1@g.us', text: 'reply text', msgId: f.msgId
    });
    assert.equal(out.sent, true);
    assert.equal(out.quoted, true);
    assert.equal(f.sendFn._calls.length, 1);
    assert.equal(f.sendFn._calls[0].opts.quotedMsg.body, 'hello');
});

test('sendNativeReply reports quote-unverified when the new msg has no quote', async () => {
    const f = makeFakeWindow({ msgId: 'false_1@g.us_ABC', newMsgQuoted: false });
    const out = await reply.sendNativeReply({
        window: f.win, chatId: '1@g.us', text: 'reply text', msgId: f.msgId
    });
    assert.equal(out.sent, true);
    assert.equal(out.quoted, false);
});

test('sendNativeReply fails cleanly when the target message is missing', async () => {
    const f = makeFakeWindow({ msgId: 'false_1@g.us_ABC' });
    const out = await reply.sendNativeReply({
        window: f.win, chatId: '1@g.us', text: 'x', msgId: 'false_9@g.us_MISSING'
    });
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'no-msg');
});

test('sendNativeReply fails cleanly when args are missing', async () => {
    const out = await reply.sendNativeReply({ window: { require: function () {} }, chatId: '', text: 'x', msgId: 'y' });
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'args');
});

test('sendNativeReply fails cleanly when no webpack require exists', async () => {
    const out = await reply.sendNativeReply({ window: null, chatId: '1@g.us', text: 'x', msgId: 'y' });
    assert.equal(out.sent, false);
    assert.equal(out.reason, 'no-webpack');
});