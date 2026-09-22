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
        type === 'ptt' || type === 'document' || type === 'sticker') return true;
    return isMediaBody(msg.body);
}

// Whether a raw body string IS the media bytes themselves (base64 jpeg/png
// or a data: URL) rather than human-readable text. WhatsApp media messages
// carry their caption in `body`, so the body content — not just the type —
// decides how a message must be rendered.
function isMediaBody(body) {
    var b = typeof body === 'string' ? body : '';
    if (!b) return false;
    return b.indexOf('/9j/') === 0 || b.indexOf('data:image') === 0 ||
           b.indexOf('data:video') === 0 || b.indexOf('iVBORw0KGgo') === 0;
}

// Human-readable caption of a media message: the body when it is real text
// (photo/video captions, audio transcriptions), '' when the body is the
// media bytes themselves or empty.
function mediaCaption(msg) {
    if (!msg) return '';
    var b = typeof msg.body === 'string' ? msg.body : (msg.caption ? String(msg.caption) : '');
    return isMediaBody(b) ? '' : b;
}

function mediaLabel(type) {
    switch (type) {
        case 'image':    return '📷 Photo';
        case 'video':    return '🎥 Video';
        case 'audio':    return '🎵 Audio';
        case 'ptt':      return '🎵 Voice note';
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
        // A captioned photo/video copies its caption text, like WhatsApp
        // does. Documents keep the type label (their body is the file name,
        // which the bubble already shows as text).
        var visual = msg.type === 'image' || msg.type === 'video' || msg.type === 'sticker' ||
                     isMediaBody(typeof msg.body === 'string' ? msg.body : '');
        if (visual) {
            var cap = mediaCaption(msg);
            if (cap) return cap;
        }
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
        var visual = msg.type === 'image' || msg.type === 'video' || msg.type === 'sticker' ||
                     isMediaBody(typeof msg.body === 'string' ? msg.body : '');
        if (visual) {
            var cap = mediaCaption(msg);
            if (cap) {
                if (cap.length > max) return cap.substring(0, max - 1) + '…';
                return cap;
            }
        }
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

// Bodies shorter than this are WhatsApp's inline ~37×60 "micro-thumb"
// (unreadable when upscaled to bubble size), not a usable preview. Anything
// longer is a real inline image worth showing as-is.
var MICRO_BODY_MAX = 4096;

// Whether a bubble needs a 480p thumb fetch: image/video/sticker msgs that
// lack a thumbUrl and have no usable preview body — i.e. an empty body OR
// only WhatsApp's micro-thumb (short base64 body). Text msgs, msgs already
// carrying a thumbUrl, and msgs with a large inline image body do not need
// a fetch.
function needsThumb(msg) {
    if (!msg || typeof msg !== 'object') return false;
    var type = msg.type || '';
    if (type !== 'image' && type !== 'video' && type !== 'sticker') return false;
    var tu = typeof msg.thumbUrl === 'string' ? msg.thumbUrl : (msg.thumbUrl ? String(msg.thumbUrl) : '');
    if (tu.length > 0) return false;
    var b = typeof msg.body === 'string' ? msg.body : (msg.body ? String(msg.body) : '');
    return b.length < MICRO_BODY_MAX;
}

// Build a data-URL for a media message body. Fallback order: full body
// data-URL when the body actually IS image bytes, else thumbUrl when
// present, else ''. A captioned media message (body is text) must never be
// prefixed into a broken "data:image/jpeg;base64,<caption>" URL — it renders
// via its thumbUrl instead.
function mediaSource(msg) {
    if (!msg) return '';
    var b = typeof msg.body === 'string' ? msg.body : '';
    if (isMediaBody(b)) {
        if (b.indexOf('data:') === 0) return b;
        var prefix = 'data:image/jpeg;base64,';
        if (b.indexOf('iVBORw0KGgo') === 0) prefix = 'data:image/png;base64,';
        return prefix + b;
    }
    var tu = typeof msg.thumbUrl === 'string' ? msg.thumbUrl : (msg.thumbUrl ? String(msg.thumbUrl) : '');
    if (tu) return tu;
    return '';
}

// Best available still preview for bubbles and viewer placeholders.
// Priority: a fetched 480p thumbUrl beats WhatsApp's micro-thumb/empty body;
// a large inline body (> MICRO_BODY_MAX chars, a real preview) beats the
// thumb; whatever exists wins otherwise.
function mediaPreviewSource(msg) {
    if (!msg) return '';
    var b = typeof msg.body === 'string' ? msg.body : '';
    var tu = typeof msg.thumbUrl === 'string' ? msg.thumbUrl : (msg.thumbUrl ? String(msg.thumbUrl) : '');
    if (tu && b.length < MICRO_BODY_MAX) return tu;
    var s = mediaSource(msg);
    if (s) return s;
    return tu;
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

// Voice notes and audio attachments (WhatsApp marks voice notes `ptt`).
function isAudioMessage(msg) {
    if (!msg || typeof msg !== 'object') return false;
    var type = msg.type || '';
    return type === 'audio' || type === 'ptt';
}

// Duration seconds for an audio message: explicit duration field first,
// else 0 (unknown — the bubble shows the player's live duration instead).
function audioDuration(msg) {
    if (!msg || typeof msg !== 'object') return 0;
    var d = Number(msg.duration);
    if (isFinite(d) && d > 0) return Math.floor(d);
    return 0;
}

function formatDuration(totalSecs) {
    var s = Math.max(0, Math.floor(Number(totalSecs) || 0));
    var m = Math.floor(s / 60);
    return m + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
}

// Node export (ignored by QML, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isMediaBody: isMediaBody,
        mediaCaption: mediaCaption,
        isMediaMessage: isMediaMessage,
        isAudioMessage: isAudioMessage,
        audioDuration: audioDuration,
        formatDuration: formatDuration,
        mediaLabel: mediaLabel,
        copyTextForMessage: copyTextForMessage,
        replyPreviewText: replyPreviewText,
        aggregateReactions: aggregateReactions,
        chatRecency: chatRecency,
        compareChats: compareChats,
        thumbnailize: thumbnailize,
        mediaSource: mediaSource,
        mediaPreviewSource: mediaPreviewSource,
        buildMediaList: buildMediaList,
        needsThumb: needsThumb
    };
}