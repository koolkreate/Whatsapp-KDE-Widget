'use strict';

/**
 * Chat last-message preview extraction.
 *
 * getAllChats used to read only `chat.lastMessage.body`, which comes back
 * null/undefined for most chats on current WhatsApp Web builds. This module
 * provides a resilient, pure extractor that falls back through the model
 * graph (chat.lastMessage -> last chat.msgs model -> chat.previewMessage)
 * and normalises the result into the shape the widget's QML consumes:
 *
 *   { body, type, t, fromMe, isRevoked, senderName } | null
 *
 * NOTE: extractLastMessage and extractChatListRows must be fully
 * self-contained (no module-scope references) because they are serialized
 * into the WhatsApp page via page.evaluate.
 */

function extractLastMessage(chat) {
    try {
        if (!chat) return null;

        // 1. Preferred: the chat's own lastMessage model.
        let lm = chat.lastMessage || null;

        // 2. Fall back to the last message model in the chat's msg collection.
        if (!lm && chat.msgs && typeof chat.msgs.getModelsArray === 'function') {
            const arr = chat.msgs.getModelsArray();
            if (arr && arr.length) lm = arr[arr.length - 1];
        }

        // 3. Last resort: WhatsApp's own preview model for unopened chats.
        if (!lm && chat.previewMessage && typeof chat.previewMessage === 'object') {
            lm = chat.previewMessage;
        }

        if (!lm) return null;

        let body = lm.body || lm.caption || lm.quotedBody || '';
        if (typeof body !== 'string') body = String(body || '');
        // Media messages on current WA Web can carry the raw media bytes as a
        // base64 string in `body` (e.g. JPEG "/9j/...", PNG "iVBOR..."). Those
        // are never useful preview text — blank them so the QML shows the
        // media icon instead of a wall of base64.
        if (/^(\/9j\/|iVBORw0KGgo|UklGR|R0lGOD|data:image\/|data:video\/|data:audio\/)/.test(body) ||
            (body.length > 512 && !/\s/.test(body))) {
            body = '';
        }

        let senderName = '';
        const snd = lm.sender;
        if (snd && typeof snd === 'object') {
            senderName = snd.formattedTitle || snd.pushname || snd.name || snd.shortName || '';
        }
        if (!senderName) senderName = lm.senderTitle || lm.notifyName || '';

        return {
            body: body,
            type: lm.type || lm.mtype || 'chat',
            t: lm.t || 0,
            fromMe: !!(lm.sent_by_me || (lm.id && lm.id.fromMe) || lm.self === 'out'),
            isRevoked: !!(lm.isRevoked || lm.isMsgRevoked),
            senderName: senderName,
        };
    } catch (e) {
        return null;
    }
}

// In-page: scrape chat-list rows for name + subtitle (last-message preview
// text). Used as the ID-less DOM fallback when no chat model is reachable.
// Returns [{ name, body }] with body possibly '' (e.g. media with no caption).
function extractChatListRows(doc) {
    try {
        if (!doc || typeof doc.querySelectorAll !== 'function') return [];
        const rows = doc.querySelectorAll('[data-testid="cell-frame-container"]');
        const out = [];
        for (let i = 0; i < rows.length; i++) {
            try {
                const row = rows[i];
                const titleEl = row.querySelector('[data-testid="cell-frame-title"] span') ||
                                row.querySelector('span[title]');
                const name = titleEl ? (titleEl.title || titleEl.textContent || '') : '';
                if (!name) continue;

                // Subtitle: dedicated testids first, else the second titled
                // span in the row (current WA DOM titles both name and preview).
                let body = '';
                const subEl = row.querySelector('[data-testid="cell-frame-sub"]') ||
                              row.querySelector('[data-testid="cell-frame-secondary"]');
                if (subEl) body = (subEl.title || subEl.textContent || '').trim();
                if (!body) {
                    const spans = row.querySelectorAll('span[title]');
                    for (let j = 0; j < spans.length; j++) {
                        const t = (spans[j].title || spans[j].textContent || '').trim();
                        if (t && t !== name && !/^\d+$/.test(t)) { body = t; break; }
                    }
                }
                if (body === name) body = '';

                out.push({ name: name, body: body });
            } catch (e) { /* ignore row */ }
        }
        return out;
    } catch (e) {
        return [];
    }
}

module.exports = { extractLastMessage, extractChatListRows };
