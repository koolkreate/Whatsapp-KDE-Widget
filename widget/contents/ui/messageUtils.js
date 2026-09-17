/*
 * messageUtils.js — pure helpers shared by the widget UI (QML) and the backend tests.
 *
 * Used from QML via:  import "messageUtils.js" as MsgUtils
 * Used from Node via: require('../.../messageUtils.js')
 *
 * Keep this free of Qt/QML intrinsics so it stays require()-able in Node.
 */

function isMediaMessage(msg) {
    if (!msg) return false;
    var type = msg.type || '';
    if (type === 'image' || type === 'video' || type === 'audio' ||
        type === 'document' || type === 'sticker') return true;
    var b = msg.body || '';
    // Raw media bodies rendered as an image by the widget.
    return b.indexOf('/9j/') === 0 || b.indexOf('data:image') === 0 || b.indexOf('iVBORw0KGgo') === 0;
}

function mediaLabel(type) {
    switch (type) {
        case 'image':    return '📷 Photo';
        case 'video':    return '🎥 Video';
        case 'audio':    return '🎵 Audio';
        case 'document': return '📄 Document';
        case 'sticker':  return '🪄 Sticker';
        case 'location': return '📍 Location';
        case 'contact':  return '👤 Contact';
        default:         return '';
    }
}

// Text that is actually copied to the clipboard for a message.
function copyTextForMessage(msg) {
    if (!msg) return '';
    if (isMediaMessage(msg)) {
        var label = mediaLabel(msg.type);
        // Raw media bodies (e.g. base64) have no dedicated type label yet.
        return label || '📷 Photo';
    }
    var body = msg.body || msg.content || '';
    return String(body);
}

// Shortened preview shown in the "Replying to…" quote bar.
function replyPreviewText(msg, maxChars) {
    if (!msg) return '';
    var max = (maxChars && maxChars > 0) ? maxChars : 60;
    if (isMediaMessage(msg)) {
        return mediaLabel(msg.type) || '📷 Photo';
    }
    var body = String(msg.body || msg.content || '');
    if (!body) return '';
    if (body.length > max) {
        return body.substring(0, max - 1) + '…';
    }
    return body;
}

// Aggregate raw reaction objects into display chips.
// Input:  [{emoji, sender, fromMe}] as produced by the backend.
// Output: [{emoji, count, senders: string[], fromMe}] in first-seen order.
// Defensive: nulls, non-objects, and blank emojis are skipped.
function aggregateReactions(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const byEmoji = {};
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r || typeof r !== 'object') continue;
        const emoji = String(r.emoji || '').trim();
        if (!emoji) continue;
        const sender = r.sender != null ? String(r.sender) : '';
        if (byEmoji[emoji] === undefined) {
            byEmoji[emoji] = { emoji: emoji, count: 0, senders: [], fromMe: false };
            out.push(byEmoji[emoji]);
        }
        const agg = byEmoji[emoji];
        agg.count++;
        agg.senders.push(sender);
        if (r.fromMe) agg.fromMe = true;
    }
    return out;
}

// Thumbnail-safe copy for the MRU chat cache: replace huge base64 media
// bodies (> maxLen chars) with a lightweight placeholder so cached copies
// stay small. Small payloads and text bodies are kept as-is.
function thumbnailize(msg, maxLen) {
    if (!msg || typeof msg !== 'object') return msg;
    var body = typeof msg.body === 'string' ? msg.body : '';
    if (body.length <= (maxLen > 0 ? maxLen : 4096)) return msg;
    var copy = {};
    for (var k in msg) copy[k] = msg[k];
    copy._thumb = true;
    copy.body = '';
    return copy;
}

// Whether a bubble needs a 480p thumb fetch: image/video/sticker msgs that
// lack both a usable full body and a thumbUrl. Text msgs and msgs already
// carrying a thumbUrl or a non-empty body do not need a fetch.
function needsThumb(msg) {
    if (!msg || typeof msg !== 'object') return false;
    var type = msg.type || '';
    if (type !== 'image' && type !== 'video' && type !== 'sticker') return false;
    var tu = typeof msg.thumbUrl === 'string' ? msg.thumbUrl : (msg.thumbUrl ? String(msg.thumbUrl) : '');
    if (tu.length > 0) return false;
    var b = typeof msg.body === 'string' ? msg.body : (msg.body ? String(msg.body) : '');
    if (b.length > 0) return false;
    return true;
}

// Build a data-URL for a media message body (extracted from the QML
// msgImage.source logic). Fallback order: full body data-URL when the body
// is non-empty, else thumbUrl when present, else ''.
function mediaSource(msg) {
    if (!msg) return '';
    var b = typeof msg.body === 'string' ? msg.body : '';
    if (b) {
        if (b.indexOf('data:') === 0) return b;
        var prefix = 'data:image/jpeg;base64,';
        if (b.indexOf('iVBORw0KGgo') === 0) prefix = 'data:image/png;base64,';
        return prefix + b;
    }
    var tu = typeof msg.thumbUrl === 'string' ? msg.thumbUrl : (msg.thumbUrl ? String(msg.thumbUrl) : '');
    if (tu) return tu;
    return '';
}

// All image/video/sticker messages in chat order — used for the fullscreen
// viewer's list and prev/next navigation. Typed media is included even with
// an empty body and no thumbUrl: tapping it still opens the viewer, which
// resolves the full bytes on demand via /api/getMedia. Plain text without a
// media-looking body is excluded.
function buildMediaList(msgs) {
    const out = [];
    const list = Array.isArray(msgs) ? msgs : [];
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m || typeof m !== 'object') continue;
        const b = typeof m.body === 'string' ? m.body : '';
        const looksMedia = b.indexOf('/9j/') === 0 || b.indexOf('data:image') === 0 ||
                           b.indexOf('iVBORw0KGgo') === 0;
        if (m.type === 'image' || m.type === 'video' || m.type === 'sticker' || looksMedia) {
            out.push(m);
        }
    }
    return out;
}

// Recency key for chat ordering. Any activity (inbound OR outbound) bumps a
// chat — matches WhatsApp's bump-on-any-activity behaviour.
function chatRecency(c) {
    if (!c) return 0;
    var t1 = Number(c.t || 0);
    var t2 = (c.lastMessage && Number(c.lastMessage.t)) || 0;
    return Math.max(t1, t2);
}

// Chat list comparator: pinned first, then most recent activity, then name-asc
// as a stable tiebreak. `isPinned` is an injectable resolver (QML passes
// root.isChatPinned, which consults both chat.isPinned and the pins list).
function compareChats(a, b, isPinned) {
    function pinned(x) {
        if (typeof isPinned === 'function') return !!isPinned(x);
        return !!(x && x.isPinned);
    }
    var pa = pinned(a) ? 1 : 0;
    var pb = pinned(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    var ra = chatRecency(a), rb = chatRecency(b);
    if (ra > rb) return -1;
    if (ra < rb) return 1;
    var na = String((a && (a.name || a.formattedTitle)) || '').toLowerCase();
    var nb = String((b && (b.name || b.formattedTitle)) || '').toLowerCase();
    if (na !== nb) return na < nb ? -1 : 1;
    return 0;
}

// Node export (ignored by QML, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isMediaMessage: isMediaMessage,
        mediaLabel: mediaLabel,
        copyTextForMessage: copyTextForMessage,
        replyPreviewText: replyPreviewText,
        aggregateReactions: aggregateReactions,
        chatRecency: chatRecency,
        compareChats: compareChats,
        thumbnailize: thumbnailize,
        mediaSource: mediaSource,
        buildMediaList: buildMediaList,
        needsThumb: needsThumb
    };
}