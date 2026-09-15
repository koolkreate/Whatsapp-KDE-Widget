/*
 * pollingUtils.js — pure polling/merge helpers shared by the widget UI (QML)
 * and the backend tests.
 *
 * Used from QML via:  import "pollingUtils.js" as PollUtils
 * Used from Node via: require('../../widget/contents/ui/pollingUtils.js')
 *
 * Keep this free of Qt/QML intrinsics so it stays require()-able in Node.
 */

// Adaptive message-poll backoff: base * 2^streak, capped at maxMs.
// A streak of 0 (something changed) returns the base interval.
function nextMessagePollInterval(baseMs, maxMs, unchangedStreak) {
    const base = baseMs > 0 ? baseMs : 5000;
    const max = maxMs > base ? maxMs : base;
    const streak = Math.max(0, unchangedStreak | 0);
    const interval = base * Math.pow(2, Math.min(streak, 8));
    return Math.min(interval, max);
}

// Merge freshly fetched messages into the existing list:
//  - new messages appended,
//  - existing messages updated in place (reactions, delivery state),
//  - result kept ordered by timestamp t (stable for equal t).
function mergeMessages(existingMsgs, freshMsgs) {
    const existing = existingMsgs || [];
    const fresh = freshMsgs || [];
    if (existing.length === 0) return fresh;
    if (fresh.length === 0) return existing;

    const byId = {};
    const out = [];
    for (let i = 0; i < existing.length; i++) {
        const m = existing[i];
        byId[m.id] = true;
        out.push(m);
    }
    for (let j = 0; j < fresh.length; j++) {
        const m = fresh[j];
        if (byId[m.id]) {
            for (let k = 0; k < out.length; k++) {
                if (out[k].id === m.id) { out[k] = m; break; }
            }
        } else {
            byId[m.id] = true;
            out.push(m);
        }
    }
    out.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
    return out;
}

// Prepend an older page of messages above the existing list (top-edge
// pagination). Dedupes by id, keeps everything, result sorted by t asc.
// Never mutates the inputs; returns the existing array untouched when the
// older page is empty or fully duplicated.
function prependOlder(existingMsgs, olderMsgs) {
    const existing = existingMsgs || [];
    const older = olderMsgs || [];
    if (older.length === 0 || existing.length === 0) return existing;

    const known = {};
    for (let i = 0; i < existing.length; i++) {
        if (existing[i] && existing[i].id != null) known[existing[i].id] = true;
    }
    const fresh = [];
    for (let j = 0; j < older.length; j++) {
        const m = older[j];
        if (m && m.id != null && !known[m.id]) {
            known[m.id] = true;
            fresh.push(m);
        }
    }
    if (fresh.length === 0) return existing;
    return fresh.concat(existing).sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
}

// Drop optimistic (temp_*) send bubbles that the server has confirmed.
// A temp message is "confirmed" when a real fromMe message with the same
// body exists within ±120s of the temp's timestamp. Each real message
// confirms at most one temp (handles the user sending the same text twice).
// Unconfirmed temps (send still in flight or failed) are kept.
function reconcileOptimistic(messages) {
    const msgs = messages || [];
    const out = [];
    const confirmedBy = {};
    for (let j = 0; j < msgs.length; j++) {
        const m = msgs[j];
        if (!m) continue;
        const id = m.id != null ? String(m.id) : '';
        if (id.indexOf('temp_') !== 0) { out.push(m); continue; }

        let confirmed = false;
        for (let k = 0; k < msgs.length; k++) {
            if (confirmedBy[k]) continue;
            const r = msgs[k];
            if (!r || !r.fromMe) continue;
            const rid = r.id != null ? String(r.id) : '';
            if (rid.indexOf('temp_') === 0) continue;
            const rb = String(r.body || '');
            if (!rb || rb !== String(m.body || '')) continue;
            if (Math.abs((r.t || 0) - (m.t || 0)) > 120) continue;
            confirmed = true;
            confirmedBy[k] = true;
            break;
        }
        if (!confirmed) out.push(m);
    }
    return out;
}

// Merge freshly fetched server messages into the LIVE list, preserving
// optimistic (temp_*) sends that are not yet confirmed by the server.
// Use this instead of a raw merge/replace whenever the model may have been
// mutated (optimistic send) while the request was in flight.
function settleMessages(currentMsgs, freshMsgs) {
    const merged = mergeMessages(currentMsgs, freshMsgs);
    return reconcileOptimistic(merged);
}

// Debounce delay for the search field (default 150ms).
function debounceDelay(ms) {
    return ms > 0 ? ms : 150;
}

// Node export (ignored by QML, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        nextMessagePollInterval: nextMessagePollInterval,
        mergeMessages: mergeMessages,
        prependOlder: prependOlder,
        reconcileOptimistic: reconcileOptimistic,
        settleMessages: settleMessages,
        debounceDelay: debounceDelay
    };
}
