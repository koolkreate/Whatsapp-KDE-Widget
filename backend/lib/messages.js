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

module.exports = { parseSince, filterMessagesSince };
