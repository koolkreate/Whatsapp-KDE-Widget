'use strict';

/**
 * Testable helpers for the "reply" (quoted-message) feature.
 *
 * Contains:
 *  - Pure argument/validation helpers (unit-testable anywhere).
 *  - In-page DOM routines that are passed directly to puppeteer
 *    `page.evaluate(...)`. They read their DOM / event ctor from an injected
 *    `req` object when present (used by unit tests) or fall back to the browser
 *    globals `document` / `MouseEvent` at runtime.
 *
 * The DOM routines must NOT close over module scope so puppeteer can serialize
 * their source and run them in the page context.
 */

// ── Argument normalization (pure) ────────────────────────────────────────────
function normalizeSendMsgArgs(body) {
    const args = (body && body.args) || body || {};
    const chatId = args.to || args.chatId;
    const text = args.content || args.text;
    const replyToId = args.replyToId || args.replyTo || args.replyMsgId || '';
    return {
        chatId: chatId != null ? String(chatId) : '',
        text: text != null ? String(text) : '',
        replyToId: replyToId != null ? String(replyToId) : ''
    };
}

// ── Validation (pure) ────────────────────────────────────────────────────────
// Returns an error string, or null when valid.
function validateSendArgs(a) {
    if (!a) return 'Missing body';
    if (!a.chatId) return 'Missing to/chatId';
    if (!String(a.text || '').trim()) return 'Missing content/text';
    return null;
}

// ── Reply detection (pure) ───────────────────────────────────────────────────
function isReply(a) {
    return !!(a && a.replyToId && String(a.replyToId).trim());
}

// ── Data-id matching (pure) ─────────────────────────────────────────────────
// Returns true when a rendered `data-id` corresponds to the target msg id.
// WhatsApp can render the id with a slightly different prefix (e.g. the remote
// jid may be LID/regular remapped), so we match on exact text, on containment
// in either direction, and on the trailing hash segment.
function matchDataId(rendered, target) {
    if (!rendered || !target) return false;
    const r = String(rendered);
    const t = String(target);
    if (r === t) return true;
    if (r.indexOf(t) !== -1 || t.indexOf(r) !== -1) return true;
    const rTail = r.indexOf('_') !== -1 ? r.split('_').pop() : r;
    const tTail = t.indexOf('_') !== -1 ? t.split('_').pop() : t;
    return !!(rTail && tTail && rTail === tTail);
}
// ── In-page: locate message bubble & open its context menu ──────────────────
// Returns { found:boolean }.
function probeReplyMessage(req) {
    const msgId = (req && (req.msgId || req.id)) || (typeof req === 'string' ? req : null);
    if (!msgId) return { found: false };

    const doc = (req && req.document) || (typeof document !== 'undefined' ? document : null);
    const MouseEventCtor = (req && req.MouseEvent) || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
    if (!doc) return { found: false };

    const escaped = String(msgId).replace(/"/g, '\\"');
    let el = null;
    try { el = doc.querySelector('div[data-id="' + escaped + '"], [data-id="' + escaped + '"]'); } catch (e) { /* ignore */ }

    // 2) Fallback: fuzzy match among all rendered message rows. Modern WhatsApp
    //    drops `data-pre-plain-text`, so we must scan `[data-id]` in #main and
    //    NOT restrict the search to text-only rows.
    if (!el) {
        try {
            const all = doc.querySelectorAll('#main [data-id], #main [data-pre-plain-text], [data-id]');
            for (let i = 0; i < all.length; i++) {
                const row = all[i];
                const d = row.getAttribute && row.getAttribute('data-id');
                const dataId = d != null ? String(d) : '';
                if (!dataId) continue;
                // Inline match (module-scope helpers are not serialized into
                // the page): exact, containment, or trailing-hash equality.
                const same = dataId === msgId ||
                    dataId.indexOf(msgId) !== -1 || msgId.indexOf(dataId) !== -1 ||
                    (dataId.indexOf('_') !== -1 && msgId.indexOf('_') !== -1 &&
                     dataId.split('_').pop() === msgId.split('_').pop());
                if (same) { el = row; break; }
            }
        } catch (e) { /* ignore */ }
    }

    if (!el) return { found: false };

    // Bring the bubble into view first (WhatsApp only opens the context menu
    // reliably on a visible message).
    if (typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
    }

    // Open WhatsApp's native right-click menu on the message. Simulate a full
    // right-click sequence (mousedown/mouseup/contextmenu with button:2) which
    // some build variations require, then fall back to contextmenu / click.
    if (MouseEventCtor && el.dispatchEvent) {
        try {
            if (typeof MouseEventCtor === 'function') {
                el.dispatchEvent(new MouseEventCtor('mousedown', { bubbles: true, cancelable: true, button: 2 }));
                el.dispatchEvent(new MouseEventCtor('mouseup',   { bubbles: true, cancelable: true, button: 2 }));
            }
            el.dispatchEvent(new MouseEventCtor('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        } catch (e) {
            if (el.click) el.click();
        }
    } else if (el.click) {
        el.click();
    }
    return { found: true };
}

// ── In-page: click the "Reply" item of the open context menu ────────────────
// Returns { clicked:boolean }.
function clickReplyMenuItem(req) {
    const doc = (req && req.document) || (typeof document !== 'undefined' ? document : null);
    const MouseEventCtor = (req && req.MouseEvent) || (typeof MouseEvent !== 'undefined' ? MouseEvent : null);
    if (!doc) return { clicked: false };

    let target = null;

    // 1) Prefer the stable WhatsApp data-testid.
    try {
        target = doc.querySelector('[data-testid="reply"], div[data-testid="reply"], li[data-testid="reply"], [role="menuitem"][data-testid="reply"], div[aria-label="Reply"], [aria-label="Reply"]');
    } catch (e) { /* ignore */ }

    // 2) Fallback: match a menu item by its label text.
    if (!target) {
        try {
            const items = doc.querySelectorAll('[role="menuitem"], li[role="menuitem"]');
            for (let i = 0; i < items.length; i++) {
                const t = (items[i].textContent || '').trim().toLowerCase();
                if (t === 'reply' || t.indexOf('reply') === 0) { target = items[i]; break; }
            }
        } catch (e) { /* ignore */ }
    }

    // 3) Last resort: title attribute.
    if (!target) {
        try { target = doc.querySelector('[title="Reply"]'); } catch (e) { /* ignore */ }
    }

    if (!target) return { clicked: false };

    if (typeof target.click === 'function') {
        target.click();
    } else if (MouseEventCtor && target.dispatchEvent) {
        target.dispatchEvent(new MouseEventCtor('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new MouseEventCtor('mouseup',   { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(new MouseEventCtor('click', { bubbles: true, cancelable: true, button: 0 }));
    }
    return { clicked: true };
}

// ── In-page: send a quoted reply via WhatsApp's own webpack modules ─────────
// This bypasses the fragile right-click/context-menu simulation entirely.
// It is verified: we only report success when a NEW message actually appears
// in the chat's message collection after the call.
// Returns { sent:boolean, quoted:boolean, reason:string }.
function sendNativeReply(req) {
    const win = (req && req.window) || (typeof window !== 'undefined' ? window : null);
    const chatId = req && (req.chatId || req.to);
    const text = req && req.text;
    const msgId = req && (req.msgId || req.replyToId);
    if (!win || !win.require) return Promise.resolve({ sent: false, quoted: false, reason: 'no-webpack' });
    if (!chatId || !text || !msgId) return Promise.resolve({ sent: false, quoted: false, reason: 'args' });

    try {
        // ── Locate the chat model ──────────────────────────────────────────
        let chatMod = null;
        const chatNames = ['WAWebChatCollection', 'WAWebStore', 'Store'];
        for (let i = 0; i < chatNames.length; i++) {
            try {
                const m = win.require(chatNames[i]);
                const coll = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                if (coll && typeof coll.get === 'function') { chatMod = coll; break; }
            } catch (e) { }
        }
        const chat = chatMod ? chatMod.get(chatId) : null;
        if (!chat) return Promise.resolve({ sent: false, quoted: false, reason: 'no-chat' });

        const msgsColl = (chat.msgs && typeof chat.msgs.get === 'function') ? chat.msgs : null;
        const msgsArr = (chat.msgs && typeof chat.msgs.getModelsArray === 'function')
            ? chat.msgs.getModelsArray() : [];

        // ── Locate the quoted message model ────────────────────────────────
        let target = msgsColl ? msgsColl.get(msgId) : null;
        if (!target) {
            for (let i = 0; i < msgsArr.length; i++) {
                const mid = msgsArr[i].id && msgsArr[i].id._serialized || String(msgsArr[i].id || '');
                const r = String(mid);
                const t = String(msgId);
                const same = r === t || r.indexOf(t) !== -1 || t.indexOf(r) !== -1 ||
                    (r.indexOf('_') !== -1 && t.indexOf('_') !== -1 && r.split('_').pop() === t.split('_').pop());
                if (same) { target = msgsArr[i]; break; }
            }
        }
        if (!target) return Promise.resolve({ sent: false, quoted: false, reason: 'no-msg' });

        // ── Locate the send module (same one plain sending already uses) ───
        let sendFn = null;
        const sendNames = ['WAWebSendTextMsgChatAction', 'WAWebSendTextMsgAction', 'WAWebChatSend', 'SendTextMsgToChat'];
        for (let i = 0; i < sendNames.length; i++) {
            try {
                const m = win.require(sendNames[i]);
                const f = m && (m.sendTextMsgToChat || (m.default && m.default.sendTextMsgToChat));
                if (typeof f === 'function') { sendFn = f; break; }
            } catch (e) { }
        }
        if (!sendFn) return Promise.resolve({ sent: false, quoted: false, reason: 'no-send' });

        const before = msgsArr.length;
        const p = sendFn(chat, text, { quotedMsg: target, quotedMessage: target });
        const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        const toArr = wait(1500).then(function () {
            return (chat.msgs && typeof chat.msgs.getModelsArray === 'function')
                ? chat.msgs.getModelsArray() : [];
        });

        return Promise.resolve(p)
            .then(function () { return wait(800); }, function () { return wait(0); })
            .then(function () { return toArr; })
            .then(function (after) {
                if (after.length <= before) return { sent: false, quoted: false, reason: 'no-new-msg' };
                // Verify the newest outgoing message actually carries the quote.
                let quoted = false;
                for (let i = after.length - 1; i >= 0; i--) {
                    const m = after[i];
                    const fromMe = !!(m.id && m.id.fromMe);
                    if (!fromMe) continue;
                    quoted = !!(m.quotedMsg || m.quotedRemoteJid || m.quotedParentMsgKey ||
                                m.quotedStanzaID || (m.quotedMsgId && m.quotedMsgId._serialized));
                    break;
                }
                return { sent: true, quoted: quoted, reason: quoted ? 'ok' : 'quote-unverified' };
            });
    } catch (e) {
        return Promise.resolve({ sent: false, quoted: false, reason: 'error:' + (e && e.message) });
    }
}

module.exports = {
    normalizeSendMsgArgs,
    validateSendArgs,
    isReply,
    matchDataId,
    probeReplyMessage,
    clickReplyMenuItem,
    sendNativeReply
};
