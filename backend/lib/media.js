'use strict';

/**
 * Media helpers for POST /api/getMedia.
 *
 * Qt-free pure helpers (QML-importable style like lib/messages.js):
 * arg parsing, LRU cache-key formatting, and a byte-capped LRU for
 * downscaled jpeg data-URLs. The in-page extractor is fully
 * self-contained (serialized into the WA page via toString — this
 * puppeteer-core build does not forward page.evaluate args).
 */

const MEDIA_MAX_BYTES = 30 * 1024 * 1024;
const JPEG_QUALITY = 0.82;
const DEFAULT_MAX_EDGE = 480;

// Normalize a POST /api/getMedia body into { chatId, msgId, maxEdge }.
// Accepts { args: {...} } or a bare args object. Returns { error } on
// missing params. maxEdge=0 means full resolution; anything missing or
// invalid falls back to DEFAULT_MAX_EDGE (480).
function parseMediaArgs(body) {
    const args = (body && body.args) || body || {};
    const chatId = args.chatId;
    const msgId = args.msgId;
    if (!chatId || !msgId) return { error: 'Missing chatId or msgId' };
    let maxEdge = DEFAULT_MAX_EDGE;
    if (args.maxEdge != null && args.maxEdge !== '') {
        const n = Number(args.maxEdge);
        if (isFinite(n) && n >= 0) maxEdge = Math.floor(n);
    }
    return { chatId: String(chatId), msgId: String(msgId), maxEdge: maxEdge };
}

// LRU cache key: chatId|msgId|maxEdge.
function cacheKey(chatId, msgId, maxEdge) {
    return String(chatId) + '|' + String(msgId) + '|' + String(maxEdge);
}

// Sanitize a message id for safe use in a temp file name: keep only
// [A-Za-z0-9_-], replacing anything else with '_'. Falls back to 'media'
// when nothing safe remains. Pure (no fs access).
function sanitizeMsgId(msgId) {
    const s = String(msgId == null ? '' : msgId).replace(/[^A-Za-z0-9_-]/g, '_');
    const trimmed = s.slice(0, 64).replace(/^_+|_+$/g, '');
    return trimmed || 'media';
}

// Normalize a POST /api/openExternally body into { chatId, msgId }.
// Accepts { args: {...} } or a bare args object. Returns { error } on
// missing params. Unlike parseMediaArgs there is no maxEdge: callers
// always fetch full resolution (maxEdge 0).
function parseOpenArgs(body) {
    const args = (body && body.args) || body || {};
    const chatId = args.chatId;
    const msgId = args.msgId;
    if (!chatId || !msgId) return { error: 'Missing chatId or msgId' };
    return { chatId: String(chatId), msgId: String(msgId) };
}

// Byte-capped LRU over a Map (insertion order = oldest first).
// Entry shape: { dataUrl, width, height, bytes? } — bytes defaults to the
// utf8 length of the dataUrl string.
function createMediaCache(maxBytes) {
    const cap = Number(maxBytes) > 0 ? Number(maxBytes) : MEDIA_MAX_BYTES;
    const map = new Map(); // key -> entry
    let bytes = 0;

    function entrySize(entry) {
        if (entry && Number(entry.bytes) > 0) return Number(entry.bytes);
        const s = entry && entry.dataUrl ? String(entry.dataUrl) : '';
        return Buffer.byteLength(s, 'utf8');
    }

    function get(key) {
        const e = map.get(key);
        if (!e) return undefined;
        // Refresh recency.
        map.delete(key);
        map.set(key, e);
        return e;
    }

    function put(key, entry) {
        const k = String(key);
        const prev = map.get(k);
        if (prev) {
            bytes -= entrySize(prev);
            map.delete(k);
        }
        const stored = { dataUrl: entry.dataUrl, width: entry.width, height: entry.height };
        stored.bytes = entrySize(entry);
        map.set(k, stored);
        bytes += stored.bytes;
        while (bytes > cap && map.size > 0) {
            const oldest = map.keys().next().value;
            const evicted = map.get(oldest);
            map.delete(oldest);
            bytes -= entrySize(evicted);
            if (bytes < 0) bytes = 0;
        }
        return stored;
    }

    function clear() {
        map.clear();
        bytes = 0;
    }

    return {
        get: get,
        put: put,
        clear: clear,
        has: function (k) { return map.has(String(k)); },
        keys: function () { return Array.from(map.keys()); },
        get size() { return map.size; },
        get bytes() { return bytes; },
        get maxBytes() { return cap; },
    };
}

// Shared process-wide cache (~30MB of jpeg data-URL bytes).
const mediaCache = createMediaCache(MEDIA_MAX_BYTES);

// ── In-page extractor (serialized via toString — NO module-scope refs) ─────
// opts: { chatId, msgId, maxEdge }. Returns { dataUrl, width, height } or
// { error: 'NOT_FOUND...' | 'DOWNLOAD_FAILED[:detail]' }. maxEdge=0 = full.
// Media bytes are fetched from mmg and decrypted in-page with WebCrypto:
// HKDF-SHA256(mediaKey, empty salt, 'WhatsApp <Type> Keys', 112B) →
// iv[0:16] + cipherKey[16:48], AES-256-CBC, verified against filehash.
async function getMediaInPage(opts) {
    var o = opts || {};
    var chatId = o.chatId;
    var msgId = o.msgId;
    var maxEdge = Number(o.maxEdge) || 0;

    function b64ToBytes(s) {
        var bin = atob(s);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // Find the chat collection.
    var coll = null;
    var names = ['WAWebChatCollection', 'WAWebStore', 'Store'];
    for (var i = 0; i < names.length; i++) {
        try {
            var m = window.require(names[i]);
            var c = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
            if (c && typeof c.get === 'function') { coll = c; break; }
        } catch (_) { }
    }
    if (!coll) return { error: 'NOT_FOUND:no-collection' };
    var chat = null;
    try {
        chat = coll.get(chatId);
        if (!chat && typeof coll.find === 'function') chat = await coll.find(chatId);
    } catch (_) { }
    if (!chat || !chat.msgs || typeof chat.msgs.getModelsArray !== 'function') {
        return { error: 'NOT_FOUND:no-chat-msgs' };
    }

    // Match the message by serialized id (newest models may expose the id
    // without _serialized — fall back to its string form like getChatMessages).
    var msg = null;
    var scanned = 0;
    try {
        var arr = chat.msgs.getModelsArray();
        scanned = arr.length;
        for (var j = 0; j < arr.length; j++) {
            var raw = arr[j] && arr[j].id;
            var mid = raw && (raw._serialized || String(raw));
            if (mid && mid !== 'undefined' && String(mid) === String(msgId)) { msg = arr[j]; break; }
        }
    } catch (_) { }
    if (!msg) return { error: 'NOT_FOUND:no-msg:' + scanned };

    // Harvest crypto inputs + signed URL (fresh per request — mmg URLs expire).
    var url = msg.deprecatedMms3Url || msg.clientUrl || null;
    if (!url && msg.directPath) url = 'https://mmg.whatsapp.net' + msg.directPath;
    var mediaKeyB64 = msg.mediaKey || null;
    var filehashB64 = msg.filehash || null;
    var mtype = msg.mtype || msg.type || 'image';
    if (!url || !mediaKeyB64) return { error: 'DOWNLOAD_FAILED:no-url-or-key' };

    // Download the ciphertext (last 10 bytes are the mac).
    var fileBuf = null;
    try {
        var resp = await fetch(url);
        if (!resp.ok) return { error: 'DOWNLOAD_FAILED:http-' + resp.status };
        fileBuf = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
        return { error: 'DOWNLOAD_FAILED:fetch:' + String((e && e.message) || e) };
    }
    if (!fileBuf || fileBuf.length <= 10) return { error: 'DOWNLOAD_FAILED:short-file' };
    var enc = fileBuf.slice(0, fileBuf.length - 10);

    // HKDF-expand the media key, AES-CBC decrypt, verify SHA256(filehash).
    var plainBuf = null;
    try {
        var infoName = 'Image';
        if (mtype === 'video') infoName = 'Video';
        else if (mtype === 'audio' || mtype === 'ptt') infoName = 'Audio';
        else if (mtype === 'document') infoName = 'Document';
        var infoBytes = new TextEncoder().encode('WhatsApp ' + infoName + ' Keys');
        var hk = await crypto.subtle.importKey('raw', b64ToBytes(mediaKeyB64), 'HKDF', false, ['deriveBits']);
        var okm = new Uint8Array(await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: infoBytes }, hk, 896));
        var ck = await crypto.subtle.importKey('raw', okm.slice(16, 48), { name: 'AES-CBC' }, false, ['decrypt']);
        plainBuf = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: okm.slice(0, 16) }, ck, enc));
        if (filehashB64) {
            var dg = new Uint8Array(await crypto.subtle.digest('SHA-256', plainBuf));
            var want = b64ToBytes(filehashB64);
            var match = dg.length === want.length;
            for (var v = 0; match && v < dg.length; v++) { if (dg[v] !== want[v]) match = false; }
            if (!match) return { error: 'DOWNLOAD_FAILED:hash-mismatch' };
        }
    } catch (e) {
        return { error: 'DOWNLOAD_FAILED:crypto:' + String((e && e.message) || e) };
    }

    // Audio (incl. voice notes): no bitmap step — ship the raw bytes as a
    // data URL. Canvas decode would fail on non-image payloads.
    if (mtype === 'audio' || mtype === 'ptt') {
        try {
            var mime = 'audio/ogg';
            try {
                var mt = String(msg.mimetype || '');
                if (mt.indexOf('audio/') === 0) mime = mt.split(';')[0];
            } catch (_) { }
            var bin = '';
            var chunk = 0x8000;
            for (var b = 0; b < plainBuf.length; b += chunk) {
                bin += String.fromCharCode.apply(null, plainBuf.subarray(b, b + chunk));
            }
            return { dataUrl: 'data:' + mime + ';base64,' + btoa(bin), width: 0, height: 0 };
        } catch (e) {
            return { error: 'DOWNLOAD_FAILED:encode:' + String((e && e.message) || e) };
        }
    }

    // Decode, downscale on canvas (longest edge capped at maxEdge), jpeg out.
    var bmp = null;
    try {
        bmp = await createImageBitmap(new Blob([plainBuf], { type: 'image/jpeg' }));
    } catch (e) {
        return { error: 'DOWNLOAD_FAILED:decode:' + String((e && e.message) || e) };
    }
    var w = bmp.width || 0;
    var h = bmp.height || 0;
    var tw = w;
    var th = h;
    if (maxEdge > 0 && w > 0 && h > 0) {
        var edge = Math.max(w, h);
        if (edge > maxEdge) {
            var s = maxEdge / edge;
            tw = Math.max(1, Math.round(w * s));
            th = Math.max(1, Math.round(h * s));
        }
    }
    try {
        var canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, tw, th);
        if (bmp.close) { try { bmp.close(); } catch (_) { } }
        var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        return { dataUrl: dataUrl, width: tw, height: th };
    } catch (e) {
        return { error: 'DOWNLOAD_FAILED:encode:' + String((e && e.message) || e) };
    }
}

module.exports = {
    MEDIA_MAX_BYTES: MEDIA_MAX_BYTES,
    JPEG_QUALITY: JPEG_QUALITY,
    DEFAULT_MAX_EDGE: DEFAULT_MAX_EDGE,
    parseMediaArgs: parseMediaArgs,
    parseOpenArgs: parseOpenArgs,
    sanitizeMsgId: sanitizeMsgId,
    cacheKey: cacheKey,
    createMediaCache: createMediaCache,
    mediaCache: mediaCache,
    getMediaInPage: getMediaInPage,
};
