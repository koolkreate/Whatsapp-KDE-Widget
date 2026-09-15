'use strict';

/**
 * Incremental message helpers.
 *
 * getChatMessages accepts `since` ({id, t} or a bare timestamp) so the widget
 * only pulls messages newer than what it already has, instead of the full
 * history on every poll.
 */

// Resolve a `since` argument into a comparable timestamp (number) and id.
function parseSince(since) {
    if (!since) return null;
    if (typeof since === 'number' || typeof since === 'string') {
        const t = Number(since);
        return isNaN(t) ? null : { t: t, id: '' };
    }
    const t = Number(since.t || 0);
    if (!t) return null;
    return { t: t, id: String(since.id || '') };
}

// Return only messages newer than `since`. Prefers exact slicing when the
// known message is still in the list (robust against equal timestamps);
// otherwise falls back to a strict `t > since.t` filter.
function filterMessagesSince(allMessages, since) {
    const msgs = allMessages || [];
    const s = parseSince(since);
    if (!s || msgs.length === 0) return msgs;

    for (let i = 0; i < msgs.length; i++) {
        const id = msgs[i] && (msgs[i].id && msgs[i].id._serialized || msgs[i].id);
        if (id != null && String(id) === s.id) {
            return msgs.slice(i + 1);
        }
    }
    return msgs.filter(function (m) { return (m && m.t || 0) > s.t; });
}

// Page through a full asc-sorted message list for lazy loading.
// args: { limit, beforeId, beforeT } — `since` is handled upstream and is
// never combined with `before`. Anchor resolution: exact id first, then the
// first message at-or-after `beforeT`; if neither resolves, the page is empty
// with hasMore=false (safe no-op — e.g. unstable DOM-fallback ids).
function paginateMessages(allMessages, args) {
    const msgs = Array.isArray(allMessages) ? allMessages : [];
    const a = args || {};
    const limit = Math.max(1, Math.min(Number(a.limit) > 0 ? Number(a.limit) : 20, 200));

    const wantId = (a.beforeId != null && a.beforeId !== '') ? String(a.beforeId) : null;
    if (wantId != null) {
        let idx = -1;
        for (let i = 0; i < msgs.length; i++) {
            const m = msgs[i];
            const id = m && (m.id && m.id._serialized || m.id);
            if (id != null && String(id) === wantId) { idx = i; break; }
        }
        if (idx < 0 && a.beforeT) {
            const bt = Number(a.beforeT) || 0;
            for (let j = 0; j < msgs.length; j++) {
                if ((msgs[j] && msgs[j].t || 0) >= bt) { idx = j; break; }
            }
        }
        if (idx < 0) return { page: [], hasMore: false };
        const start = Math.max(0, idx - limit);
        return { page: msgs.slice(start, idx), hasMore: start > 0 };
    }

    const start = Math.max(0, msgs.length - limit);
    return { page: msgs.slice(start), hasMore: start > 0 };
}

module.exports = { parseSince, filterMessagesSince, paginateMessages };
