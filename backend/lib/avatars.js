'use strict';

/**
 * Avatar (profile picture) helpers.
 *
 * Strategy: scrape the small data-URI avatars WhatsApp already renders in the
 * chat list (no extra network requests), hash them, and only ever ship the
 * bytes when the hash changed for a chat. The widget caches by hash and asks
 * for the bytes via /api/avatar/<hash>.
 *
 * The DOM routine takes an injectable `doc` so it can be unit tested; at
 * runtime the real `document` is used inside page.evaluate.
 */

// FNV-1a 32-bit hash, hex encoded. Deterministic and dependency-free.
function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
}

// Build the per-chat payload for the API response. `prevHashes` maps
// chatId -> last sent hash. Bytes are only included when changed.
function avatarPayload(chatId, base64, prevHashes) {
    let data = '';
    if (base64) {
        const s = String(base64);
        // Accept either a full data URI ("data:image/png;base64,AAAA") or raw
        // base64 that was already stripped upstream.
        data = s.indexOf('data:image') === 0 ? (s.split(',')[1] || '') : s;
    }
    if (!data) {
        return { id: chatId, hash: '', changed: false, data: null };
    }
    const hash = fnv1a(data);
    const changed = !prevHashes || prevHashes[chatId] !== hash;
    return { id: chatId, hash: hash, changed: changed, data: changed ? data : null };
}

// Normalize a display name for matching DOM rows to chat models.
function normalizeName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Map DOM-scraped avatars [{name, base64}] onto chat models [{id, name}].
function matchAvatarsToChats(chats, domAvatars) {
    const byName = new Map();
    (domAvatars || []).forEach(function (a) {
        if (a && a.base64) byName.set(normalizeName(a.name), a.base64);
    });
    const out = new Map();
    (chats || []).forEach(function (c) {
        const b64 = byName.get(normalizeName(c && c.name));
        if (b64) out.set(c.id, b64);
    });
    return out;
}

// Classify an <img src> value found in the chat list.
// 'data'  — inline data URI (base64 directly usable)
// 'blob'  — in-page blob URL (fetchable in page context)
// 'https' — WhatsApp media CDN URL (fetchable in page context with cookies)
// 'empty'/'none' — nothing usable
function classifyImageSrc(src) {
    if (src == null) return 'none';
    const s = String(src);
    if (s === '') return 'empty';
    if (s.indexOf('data:') === 0) return 'data';
    if (s.indexOf('blob:') === 0) return 'blob';
    if (s.indexOf('https:') === 0) return 'https';
    return 'other';
}

// Normalize a src into raw base64 when possible without fetching.
// Returns { base64 } for data URIs, or { kind, src } when a fetch is needed.
function toAvatarEntry(name, src) {
    const kind = classifyImageSrc(src);
    if (kind === 'data') {
        return { name: name, kind: kind, base64: String(src).split(',')[1] || '' };
    }
    if (kind === 'https' || kind === 'blob') {
        return { name: name, kind: kind, src: String(src) };
    }
    return null;
}

// In-page: scrape chat-list avatars. Returns entries of two shapes:
//   { name, kind:'data', base64 }        — bytes ready
//   { name, kind:'https'|'blob', src }   — needs an in-page fetch
// NOTE: must be fully self-contained (no module-scope references) because it
// is serialized into the page via page.evaluate.
function extractAvatars(doc) {
    try {
        if (!doc || typeof doc.querySelectorAll !== 'function') return [];
        function classify(s) {
            if (s == null) return 'none';
            const v = String(s);
            if (v === '') return 'empty';
            if (v.indexOf('data:') === 0) return 'data';
            if (v.indexOf('blob:') === 0) return 'blob';
            if (v.indexOf('https:') === 0) return 'https';
            return 'other';
        }
        const rows = doc.querySelectorAll('[data-testid="cell-frame-container"]');
        const out = [];
        for (let i = 0; i < rows.length; i++) {
            try {
                const titleEl = rows[i].querySelector('[data-testid="cell-frame-title"] span') ||
                                rows[i].querySelector('span[title]');
                const name = titleEl ? (titleEl.title || titleEl.textContent || '') : '';
                const img = rows[i].querySelector('img');
                const src = img ? img.getAttribute('src') : null;
                if (!name || !src) continue;
                const kind = classify(src);
                if (kind === 'data') {
                    const base64 = String(src).split(',')[1] || '';
                    // Skip trivial 1x1 placeholders (e.g. unread-marker gifs).
                    if (!base64 || base64.length < 128) continue;
                    out.push({ name: name, kind: kind, base64: base64 });
                } else if (kind === 'https' || kind === 'blob') {
                    out.push({ name: name, kind: kind, src: String(src) });
                }
            } catch (e) { /* ignore row */ }
        }
        return out;
    } catch (e) {
        return [];
    }
}

// In-page: fetch an image URL (CDN or blob:) and return raw base64.
// Runs inside the WhatsApp page, so session cookies/origin apply.
// Returns '' on any failure (caller skips that avatar).
function fetchImageAsBase64(url) {
    return fetch(url)
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
        })
        .then(function (buf) {
            const bytes = new Uint8Array(buf);
            let bin = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            return btoa(bin);
        })
        .catch(function () { return ''; });
}

module.exports = { fnv1a, avatarPayload, normalizeName, matchAvatarsToChats, classifyImageSrc, extractAvatars, fetchImageAsBase64 };
