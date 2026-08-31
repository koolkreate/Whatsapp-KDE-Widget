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

// Debounce delay for the search field (default 150ms).
function debounceDelay(ms) {
    return ms > 0 ? ms : 150;
}

// Node export (ignored by QML, where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        nextMessagePollInterval: nextMessagePollInterval,
        mergeMessages: mergeMessages,
        debounceDelay: debounceDelay
    };
}
