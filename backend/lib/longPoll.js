'use strict';

/**
 * Long-poll helper: resolves as soon as a signature changes (or on timeout).
 *
 * Used by /api/waitMessages so the widget can be notified of new messages
 * within ~1s instead of blind 5s polling. All timing is injectable so the
 * logic is unit-testable without real timers.
 */

function defaultSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * waitForSigChange({ getSig, knownSig, intervalMs, timeoutMs, sleep })
 *  - getSig:    () => sig (may be async; errors count as "no change")
 *  - knownSig:  the signature the caller already has ('' => attach now)
 *  - intervalMs: pause between checks (default 1000)
 *  - timeoutMs:  give up after this long, resolving {changed:false} (default 20000)
 *  - sleep:      injectable wait function (tests)
 * Resolves { changed: boolean, sig: string } — never rejects.
 */
function waitForSigChange(opts) {
    const o = opts || {};
    const getSig = o.getSig || function () { return ''; };
    const known = o.knownSig == null ? '' : String(o.knownSig);
    const intervalMs = o.intervalMs || 1000;
    const timeoutMs = o.timeoutMs == null ? 20000 : o.timeoutMs;
    const sleep = o.sleep || defaultSleep;
    const startedAt = Date.now();

    return new Promise(function (resolve) {
        function attempt() {
            Promise.resolve()
                .then(function () { return getSig(); })
                .then(function (sig) {
                    const s = sig == null ? '' : String(sig);
                    if (known === '' || s !== known) {
                        resolve({ changed: true, sig: s });
                        return;
                    }
                    if (Date.now() - startedAt >= timeoutMs) {
                        resolve({ changed: false, sig: s });
                        return;
                    }
                    return sleep(intervalMs).then(attempt);
                })
                .catch(function () {
                    // Scrape hiccup: treat as "no change" and keep waiting.
                    if (Date.now() - startedAt >= timeoutMs) {
                        resolve({ changed: false, sig: known });
                        return;
                    }
                    return sleep(intervalMs).then(attempt);
                });
        }
        attempt();
    });
}

module.exports = { waitForSigChange, defaultSleep };
