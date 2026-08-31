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

// Node export (ignored by QML, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isMediaMessage: isMediaMessage,
        mediaLabel: mediaLabel,
        copyTextForMessage: copyTextForMessage,
        replyPreviewText: replyPreviewText,
        aggregateReactions: aggregateReactions
    };
}