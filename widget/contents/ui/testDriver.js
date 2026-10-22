/*
 * testDriver.js — agent test driver for the WhatsApp KDE widget.
 *
 * Inert in normal use: it only activates when a `test-config.json` sits next
 * to main.qml (the agent test workflow drops it into a scratch copy of the
 * widget package, never into the real installation). When present, the
 * driver drives the real UI — opens the mock chat, checks that captions
 * render, that background merges don't teleport the scroll position, that
 * top-edge pagination keeps its anchor, and that the fullscreen media viewer
 * opens/closes. Results are streamed to stdout as WIDTEST JSON lines that
 * agent_test.sh parses.
 *
 * Keep this free of Qt intrinsics beyond the QML objects passed in.
 */

function log(o) {
    var line = "";
    try { line = JSON.stringify(o); } catch (e) { line = "{}"; }
    try { console.warn("WIDTEST " + line); } catch (e) {}
    try {
        if (rootRef && rootRef.testCfg && rootRef.testCfg.apiHost) {
            var rep = new XMLHttpRequest();
            rep.open("POST", rootRef.testCfg.apiHost + "/api/widtest");
            rep.send(JSON.stringify({ args: { entry: o } }));
        }
    } catch (e) {}
}

// Module-level ref to the widget root, set when the driver runs (QML's JS
// engine forbids implicit globals, so declare it explicitly).
var rootRef = null;

// Verbose diagnostics (WIDDBG lines) — only when the config asks for them.
function dbg(s) {
    if (typeof rootRef !== 'undefined' && rootRef && rootRef.testCfg && rootRef.testCfg.debug) {
        console.warn("WIDDBG " + s);
    }
}

function maybeStart(root) {
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", "test-config.json");
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            // file:// loads may report status 0 or 200 depending on Qt build.
            if (xhr.status !== 200 && xhr.status !== 0) return;
            if (!xhr.responseText) return;
            var cfg;
            try { cfg = JSON.parse(xhr.responseText); } catch (e) { return; }
            if (!cfg || !cfg.scenario || !cfg.scenario.length) return;
            // Point the widget at the mock backend before its first status
            // poll loop tick (the poll Timer re-fires, so this always wins).
            if (cfg.apiHost) root.apiHost = cfg.apiHost;
            if (cfg.apiKey) root.apiKey = cfg.apiKey;
            root.testCfg = cfg;
            root.testMode = true;
            run(root, cfg);
        };
        xhr.send();
    } catch (e) {
        // Not a test run (or config unreadable) — stay inert.
    }
}

function run(root, cfg) {
    rootRef = root;
    log({ event: "driver-start", scenario: cfg.scenario, chatId: cfg.chatId || "" });
    var timer = Qt.createQmlObject(
        "import QtQuick; Timer { interval: 200; repeat: true; running: true }",
        root, "TestDriverTimer");
    var state = { idx: -1, t0: Date.now(), tries: 0, saved: {}, pass: 0, fail: 0 };
    nextStep(root, cfg, timer, state);
    timer.onTriggered.connect(function() { tick(root, cfg, timer, state); });
}

function finish(timer, state) {
    timer.stop();
    log({ event: "done", pass: state.pass, fail: state.fail });
}

function nextStep(root, cfg, timer, state) {
    state.idx++;
    state.t0 = Date.now();
    state.tries = 0;
    state.saved = {};
    var steps = cfg.scenario || [];
    if (state.idx >= steps.length) {
        finish(timer, state);
        return;
    }
    log({ event: "step", name: steps[state.idx] });
}

function stepTimedOut(cfg, state) {
    var limit = (cfg && cfg.stepTimeoutMs > 0) ? cfg.stepTimeoutMs : 25000;
    return (Date.now() - state.t0) > limit;
}

function passFail(root, cfg, timer, state, ok, detail) {
    var steps = cfg.scenario || [];
    var name = steps[state.idx] || ("step" + state.idx);
    if (ok) {
        state.pass++;
        log({ event: "result", name: name, pass: true, detail: detail || "" });
    } else {
        state.fail++;
        log({ event: "result", name: name, pass: false, detail: detail || "" });
    }
    nextStep(root, cfg, timer, state);
}

function shotStep(root, cfg, timer, state, name) {
    if (!cfg.shotDir) {
        passFail(root, cfg, timer, state, false, "shot step needs shotDir in test-config.json");
        return;
    }
    if (state.saved.armed) return;
    state.saved.armed = true;
    var safe = String(name || "shot").replace(/[^A-Za-z0-9_-]/g, "_");
    var path = cfg.shotDir + "/" + safe + ".png";
    try {
        root.grabToImage(function(result) {
            var ok = false;
            try { ok = result.saveToFile(path); } catch (e) { ok = false; }
            passFail(root, cfg, timer, state, ok, ok ? ("saved " + path) : ("saveToFile failed: " + path));
        });
    } catch (e) {
        passFail(root, cfg, timer, state, false, "grabToImage threw: " + e);
    }
}

function findByName(item, name) {
    if (!item) return null;
    if (item.objectName === name) return item;
    var kids = item.children || [];
    for (var i = 0; i < kids.length; i++) {
        var hit = findByName(kids[i], name);
        if (hit) return hit;
    }
    return null;
}

function findList(root) {
    return findByName(root, "messageListView");
}

function findDelegates(item, out) {
    if (!item) return out;
    if (item.objectName === "msgBubbleDelegate") out.push(item);
    var kids = item.children || [];
    for (var i = 0; i < kids.length; i++) findDelegates(kids[i], out);
    return out;
}

// Message id of the topmost visible bubble, or "" when none is visible.
function topVisibleMsgId(lv) {
    var dels = findDelegates(lv.contentItem, []);
    var best = null;
    var bestY = Infinity;
    for (var i = 0; i < dels.length; i++) {
        var y = dels[i].mapToItem(lv.contentItem, 0, 0).y;
        var h = dels[i].height || 1;
        if (y + h > lv.contentY + 10 && y < bestY && y + h > lv.contentY) {
            bestY = y;
            best = dels[i];
        }
    }
    return best ? best.testMsgId : "";
}

function tick(root, cfg, timer, state) {
    if (stepTimedOut(cfg, state)) {
        passFail(root, cfg, timer, state, false, "timeout");
        return;
    }
    var lv = findList(root);
    var steps = cfg.scenario || [];
    var step = steps[state.idx];
    state.tries++;
    if (step && step.indexOf("shot:") === 0) {
        shotStep(root, cfg, timer, state, step.substring(5));
        return;
    }

    switch (step) {
        case "backendReady":
            if (root.isConnected) passFail(root, cfg, timer, state, true, "backend connected");
            break;

        case "chatsLoaded":
            if ((root.allChats || []).length > 0)
                passFail(root, cfg, timer, state, true, root.allChats.length + " chats in list");
            break;

        case "refreshChats":
            if (!state.saved.fired) {
                root.fetchChats();
                state.saved.fired = true;
                break;
            }
            if (!root.chatsInFlight)
                passFail(root, cfg, timer, state, true, "chat list refreshed");
            break;

        case "relayout": {
            var clv = findByName(root, "chatListView");
            if (!clv) { passFail(root, cfg, timer, state, false, "chat ListView not found"); break; }
            clv.forceLayout();
            passFail(root, cfg, timer, state, true, "chat list relaid out");
            break;
        }

        case "scrollChats": {
            var slv = findByName(root, "chatListView");
            if (!slv) { passFail(root, cfg, timer, state, false, "chat ListView not found"); break; }
            slv.contentY = 300;
            passFail(root, cfg, timer, state, true, "scrolled to y=" + Math.round(slv.contentY));
            break;
        }

        case "openChat": {
            if (state.saved.opened) {
                if (root.activeChat && root.activeChat.id === state.saved.opened)
                    passFail(root, cfg, timer, state, true, "chat opened: " + state.saved.opened);
                break;
            }
            var chats = root.allChats || [];
            if (chats.length === 0) break;
            var target = null;
            for (var i = 0; i < chats.length; i++) {
                if (!cfg.chatId || chats[i].id === cfg.chatId) { target = chats[i]; break; }
            }
            if (!target) { passFail(root, cfg, timer, state, false, "chatId not in getAllChats"); break; }
            state.saved.opened = target.id;
            root.activeChat = {
                id: target.id,
                name: target.name || target.formattedTitle || "Unknown",
                isGroup: target.isGroup || false
            };
            break;
        }

        case "messagesLoaded":
            if (root.activeChatMessages.length > 0)
                passFail(root, cfg, timer, state, true, root.activeChatMessages.length + " messages");
            break;

        case "caption": {
            var dels = findDelegates(lv.contentItem, []);
            var hit = null;
            for (var d = 0; d < dels.length; d++) {
                if (dels[d].testMsgId === cfg.captionMsgId) { hit = dels[d]; break; }
            }
            if (!hit) {
                // The caption bubble may sit just outside the instantiate
                // window (viewport + cacheBuffer) when the chat opens at the
                // bottom. Scroll it into view once — deterministic, and it
                // also exercises the real "scroll to a media message" path.
                if (!state.saved.scrolledToCaption && lv && root.activeChatMessages) {
                    state.saved.scrolledToCaption = true;
                    for (var ci = 0; ci < root.activeChatMessages.length; ci++) {
                        if (String(root.activeChatMessages[ci].id) === String(cfg.captionMsgId)) {
                            lv.positionViewAtIndex(ci, ListView.Center);
                            break;
                        }
                    }
                    break;
                }
                var seen = [];
                for (var s = 0; s < dels.length; s++) seen.push(dels[s].testMsgId);
                if (state.tries > 50) passFail(root, cfg, timer, state, false,
                    "delegate not found for " + cfg.captionMsgId + " (instantiated: " + seen.join(",") + ")");
                break;
            }
            var ok = hit.testHasCaption && hit.testCaptionText === cfg.expectedCaption;
            passFail(root, cfg, timer, state, ok,
                ok ? ("caption rendered under media: \"" + hit.testCaptionText + "\"")
                   : ("caption mismatch: visible=" + hit.testHasCaption +
                      " text=\"" + hit.testCaptionText + "\" expected=\"" + cfg.expectedCaption + "\""));
            break;
        }

        case "followBottom":
            followBottomStep(root, cfg, timer, state, lv);
            break;

        case "preserveMidScroll":
            preserveMidScrollStep(root, cfg, timer, state, lv);
            break;

        case "prependAnchor":
            prependAnchorStep(root, cfg, timer, state, lv);
            break;

        case "viewer":
            viewerStep(root, cfg, timer, state);
            break;

        case "audioUI":
            audioUiStep(root, cfg, timer, state, lv);
            break;

        case "audioPlay":
            audioPlayStep(root, cfg, timer, state);
            break;

        case "audioSpeed":
            audioSpeedStep(root, cfg, timer, state);
            break;

        case "audioExclusive":
            audioExclusiveStep(root, cfg, timer, state);
            break;

        case "voiceSend":
            voiceSendStep(root, cfg, timer, state);
            break;

        case "viewProbe":
            viewProbeStep(root, cfg, timer, state);
            break;

        case "forceEnd":
            forceEndStep(root, cfg, timer, state);
            break;

        case "reopenAtLatest":
            reopenAtLatestStep(root, cfg, timer, state, lv);
            break;

        case "voiceSend":
            voiceSendStep(root, cfg, timer, state);

        default:
            passFail(root, cfg, timer, state, false, "unknown step " + step);
    }
}

// Background merge with the user at the bottom must follow the newest
// message (and never teleport mid-gesture).
function fireTestInject(root, cfg, label) {
    try {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", root.testCfg.apiHost + "/api/testInject");
        xhr.send(JSON.stringify({ args: { chatId: cfg.chatId, label: label } }));
    } catch (e) {}
}
function followBottomStep(root, cfg, timer, state, lv) {
    if (!lv) {
        if (state.tries > 50) passFail(root, cfg, timer, state, false, "message ListView not found");
        return;
    }
    if (!state.saved.count) {
        if (!state.saved.parked) {
            state.saved.parked = true;
            root.restoreAtEndSettle(lv);
            return;
        }
        var endNow = false;
        try {
            // originY-aware: the content origin drifts below 0 after model
            // swaps (prepends leave delegates above the y=0 line), so the
            // true bottom edge is originY + contentHeight.
            endNow = lv.contentY >= lv.originY + lv.contentHeight - lv.height - 8;
        } catch (e) {}
        if (!endNow) {
            if (state.tries > 60) passFail(root, cfg, timer, state, false,
                "park never reached end: y=" + Math.round(lv.contentY) +
                " oy=" + Math.round(lv.originY) +
                " ch=" + Math.round(lv.contentHeight) + " h=" + Math.round(lv.height));
            return;
        }
        state.saved.endN = (state.saved.endN || 0) + 1;
        if (state.saved.endN < 3) return;
        state.saved.count = root.activeChatMessages.length;
        return;
    }
    if (!state.saved.injected) {
        state.saved.injected = true;
        fireTestInject(root, cfg, "follow");
        return;
    }
    var now = root.activeChatMessages.length;
    if (now > state.saved.count) {
        var stillEnd = false;
        try {
            stillEnd = lv.contentY >= lv.originY + lv.contentHeight - lv.height - 8;
        } catch (e) { stillEnd = lv.atYEnd; }
        passFail(root, cfg, timer, state, stillEnd,
            stillEnd ? ("followed new message (" + now + " msgs, view at end)")
                     : ("new message arrived but view left the end"));
    } else if (state.tries > 100) {
        passFail(root, cfg, timer, state, false,
            "merge never landed: msgs=" + now + " want>" + state.saved.count);
    }
}

// Background merge while scrolled up must NOT move the reading position.
// Measured semantically: the topmost visible bubble must stay the same
// message. Absolute contentY comparisons are useless here because
// contentHeight is partly ESTIMATED (off-screen delegates are not
// instantiated) and legitimately shifts across a model swap.
function preserveMidScrollStep(root, cfg, timer, state, lv) {
    if (!lv) {
        if (state.tries > 50) passFail(root, cfg, timer, state, false, "message ListView not found");
        return;
    }
    if (!state.saved.armed) {
        if (!root.activeChatMessages.length) return;
        // Park near the top (instantiated delegates => stable geometry).
        lv.contentY = 150;
        state.saved.armed = true;
        state.saved.parkN = 0;
        return;
    }
    if (!state.saved.parkedOk) {
        // Closed-loop park: a park write issued mid-settle can lose to the
        // ListView's own reset, so rewrite until the position sticks.
        if (Math.abs(lv.contentY - 150) > 25) {
            lv.contentY = 150;
            state.saved.parkN = 0;
            return;
        }
        state.saved.parkN = (state.saved.parkN || 0) + 1;
        if (state.saved.parkN < 3) return;
        state.saved.parkedOk = true;
        return;
    }
    if (!state.saved.y) {
        // Second beat: the ListView has applied the scroll; capture anchor.
        state.saved.y = lv.contentY;
        state.saved.count = root.activeChatMessages.length;
        state.saved.topId = topVisibleMsgId(lv);
        dbg("arm: y=" + state.saved.y + " ch=" + Math.round(lv.contentHeight) +
            " topId=" + state.saved.topId + " msgs=" + state.saved.count);
        if (!state.saved.topId) state.saved.y = 0; // no anchor yet — retry next tick
        return;
    }
    if (!state.saved.injected) {
        state.saved.injected = true;
        fireTestInject(root, cfg, "preserve");
        return;
    }
    dbg("wait: y=" + Math.round(lv.contentY) + " ch=" + Math.round(lv.contentHeight) +
        " atEnd=" + lv.atYEnd + " atBegin=" + lv.atYBeginning +
        " msgs=" + root.activeChatMessages.length + " hasMore=" + root.msgsHasMore +
        " loading=" + root.msgsLoadingOlder + " inflight=" + root.messagesInFlight +
        " topId=" + topVisibleMsgId(lv));
    var cnt = root.activeChatMessages.length;
    if (cnt > state.saved.count) {
        // Give the scroll-restore settle loop (~600ms) time to converge and
        // require the reading position to be stable before judging.
        var nowTop = topVisibleMsgId(lv);
        if (nowTop === state.saved.stableTop) state.saved.stableN = (state.saved.stableN || 0) + 1;
        else { state.saved.stableTop = nowTop; state.saved.stableN = 1; }
        dbg("judge-wait: n=" + state.saved.stableN + " top=" + nowTop + " y=" + Math.round(lv.contentY));
        if (state.saved.stableN < 4) return;
        var sameTop = nowTop === state.saved.topId;
        passFail(root, cfg, timer, state, sameTop,
            sameTop ? ("reading position preserved (still at " + state.saved.topId + ")")
                    : ("reading position jumped: " + state.saved.topId + " -> " + nowTop));
    }
}

// Top-edge pagination must keep the reading position anchored. Measured
// semantically: after the older page prepends, the bubble the user was
// reading (captured once the view is settled at the top) must still be
// the topmost visible one. contentHeight is partly estimated, so pixel
// arithmetic drifts; delegate identity does not.
function prependAnchorStep(root, cfg, timer, state, lv) {
    // Fail fast only when there were never any older pages to begin with.
    // Once our own fetches have run (hasMore flips false after the last
    // page lands), the count growth below is what matters, not the flag.
    if (state.saved.entryChecked === undefined) {
        state.saved.entryChecked = true;
        if (!root.msgsHasMore) { passFail(root, cfg, timer, state, false, "no older pages to load"); return; }
    }
    if (!state.saved.settled) {
        // Scroll to the top and wait until it sticks across several ticks
        // (the previous step's scroll-restore timers may still be re-pinning).
        lv.contentY = 0;
        if (lv.contentY > 5) { state.saved.zeroStreak = 0; return; }
        state.saved.zeroStreak = (state.saved.zeroStreak || 0) + 1;
        if (state.saved.zeroStreak < 3) return;
        state.saved.settled = true;
        return;
    }
    if (!state.saved.topId) {
        // Settled at the top: capture the reading anchor BEFORE the prepend.
        state.saved.topId = topVisibleMsgId(lv);
        if (!state.saved.topId) return; // nothing instantiated yet — retry
        state.saved.count = root.activeChatMessages.length;
        state.saved.nudged = false;
        dbg("arm: topId=" + state.saved.topId + " msgs=" + state.saved.count +
            " hasMore=" + root.msgsHasMore);
        return;
    }
    dbg("wait: y=" + Math.round(lv.contentY) + " atBegin=" + lv.atYBeginning +
        " msgs=" + root.activeChatMessages.length + " hasMore=" + root.msgsHasMore +
        " loading=" + root.msgsLoadingOlder + " inflight=" + root.messagesInFlight +
        " swap=" + root.swapInFlight + " topId=" + topVisibleMsgId(lv));
    if (root.msgsLoadingOlder || root.messagesInFlight) { state.saved.sawLoading = true; return; }
    var cnt = root.activeChatMessages.length;
    if (!state.saved.sawLoading && cnt >= state.saved.count + 5) {
        // A prepend already landed (adds ~20 msgs; injections add 1).
        state.saved.sawLoading = true;
    }
    if (!state.saved.sawLoading) {
        // Persistently hold the top until the prepend fires: settle timers
        // from unrelated merges may re-pin the view for ~1s, and dropped
        // atYBeginningChanged triggers must not stall the step. Fire once —
        // refiring every tick would chain-load page after page (the mock
        // answers in ms, so every call consumes a full page).
        lv.contentY = 0;
        if (lv.atYBeginning) {
            root.fetchOlderMessages();
            state.saved.sawLoading = true;
        }
        return;
    }
    if (cnt > state.saved.count) {
        // Wait for the prepend's anchor restore to converge before judging.
        var nowTop = topVisibleMsgId(lv);
        if (nowTop === state.saved.stableTop) state.saved.stableN = (state.saved.stableN || 0) + 1;
        else { state.saved.stableTop = nowTop; state.saved.stableN = 1; }
        dbg("judge-wait: n=" + state.saved.stableN + " top=" + nowTop + " y=" + Math.round(lv.contentY));
        if (state.saved.stableN < 4) return;
        var sameTop = nowTop === state.saved.topId;
        passFail(root, cfg, timer, state, sameTop,
            sameTop ? ("anchor kept (still reading " + state.saved.topId + ", " +
                       (cnt - state.saved.count) + " older msgs loaded)")
                    : ("anchor lost: " + state.saved.topId + " -> " + nowTop));
    }
}

function liveMsgById(root, msgId) {
    var msgs = root.activeChatMessages || [];
    for (var i = 0; i < msgs.length; i++) {
        if (msgs[i] && String(msgs[i].id) === String(msgId)) return msgs[i];
    }
    return null;
}

function audioUiStep(root, cfg, timer, state, lv) {
    if (!lv) {
        if (state.tries > 50) passFail(root, cfg, timer, state, false, "message ListView not found");
        return;
    }
    if (!state.saved.scrolled) {
        lv.positionViewAtEnd();
        state.saved.scrolled = true;
        return;
    }
    var dels = findDelegates(lv.contentItem, []);
    var hit = null;
    for (var d = 0; d < dels.length; d++) {
        if (dels[d].testMsgId === cfg.audioMsgId) { hit = dels[d]; break; }
    }
    if (!hit) {
        if (state.tries > 50) passFail(root, cfg, timer, state, false, "audio delegate not found for " + cfg.audioMsgId);
        return;
    }
    var ok = hit.testHasAudio && hit.testWaveBars === 64 && String(hit.testAudioDuration).indexOf("0:18") !== -1;
    passFail(root, cfg, timer, state, ok,
        ok ? ("audio bubble: play + 64 bars + 0:18")
           : ("audio UI mismatch: hasAudio=" + hit.testHasAudio +
              " bars=" + hit.testWaveBars + " dur=\"" + hit.testAudioDuration + "\""));
}

function audioPlayStep(root, cfg, timer, state) {
    if (!state.saved.fired) {
        var msg = liveMsgById(root, cfg.audioMsgId);
        if (!msg) {
            if (state.tries > 50) passFail(root, cfg, timer, state, false, "audio message not in live list");
            return;
        }
        root.toggleAudioPlayback(msg);
        state.saved.fired = true;
        return;
    }
    var live = liveMsgById(root, cfg.audioMsgId);
    var fetched = !!(live && live.fullUrl);
    if (root.audioIsPlaying || fetched) {
        passFail(root, cfg, timer, state, true,
            "play path: playing=" + root.audioIsPlaying + " bytes=" + fetched);
        return;
    }
    if (root.audioErrorMsgId) {
        passFail(root, cfg, timer, state, false, "player error: " + root.audioError);
        return;
    }
    if (state.tries > 60) passFail(root, cfg, timer, state, false, "play never started nor fetched");
}

function audioSpeedStep(root, cfg, timer, state) {
    root.cycleAudioSpeed();
    root.cycleAudioSpeed();
    var two = "";
    try { two = root.audioSpeedLabel(); } catch (e) {}
    root.cycleAudioSpeed();
    var one = "";
    try { one = root.audioSpeedLabel(); } catch (e) {}
    var ok = (two === "2x" && one === "1x");
    passFail(root, cfg, timer, state, ok, ok ? "speed 1x -> 1.5x -> 2x -> 1x" : ("speed cycle broke: " + two + "/" + one));
}

function audioExclusiveStep(root, cfg, timer, state) {
    if (!state.saved.fired) {
        var msg = liveMsgById(root, cfg.audioMsgId2);
        if (!msg) {
            if (state.tries > 50) passFail(root, cfg, timer, state, false, "second audio message not in live list");
            return;
        }
        root.toggleAudioPlayback(msg);
        state.saved.fired = true;
        return;
    }
    if (String(root.audioPlayingMsgId) === String(cfg.audioMsgId2)) {
        passFail(root, cfg, timer, state, true, "second play took over: " + root.audioPlayingMsgId);
    } else if (state.tries > 30) {
        passFail(root, cfg, timer, state, false, "playingMsgId stuck at " + root.audioPlayingMsgId);
    }
}

function voiceSendStep(root, cfg, timer, state) {
    if (!cfg.voiceFile) {
        passFail(root, cfg, timer, state, false, "voiceSend needs voiceFile in test-config.json");
        return;
    }
    if (!state.saved.sent) {
        if (!root.activeChat) return;
        root.sendFile(root.activeChat.id, cfg.voiceFile, "");
        state.saved.sent = true;
        return;
    }
    if (root.sendInFlight) {
        if (state.tries > 60) passFail(root, cfg, timer, state, false, "send never completed");
        return;
    }
    if (state.saved.checked) return;
    state.saved.checked = true;
    var xhr = new XMLHttpRequest();
    xhr.open("GET", root.apiHost.replace(/\/$/, "") + "/api/testSentFiles?key=" + root.apiKey);
    xhr.onreadystatechange = function() {
        if (xhr.readyState !== XMLHttpRequest.DONE) return;
        var ok = false;
        var detail = "no ledger";
        try {
            var r = JSON.parse(xhr.responseText);
            var list = r.response || r || [];
            for (var i = list.length - 1; i >= 0; i--) {
                var e = list[i] || {};
                if (String(e.file || "") === String(cfg.voiceFile)) {
                    ok = !!e.exists && Number(e.size) > 0 && /\.(ogg|wav|mp3|m4a)$/i.test(e.file);
                    detail = "exists=" + e.exists + " size=" + e.size;
                    break;
                }
            }
            if (!ok && detail === "no ledger") detail = "file not in ledger (" + list.length + " entries)";
        } catch (e) { detail = "ledger parse failed"; }
        passFail(root, cfg, timer, state, ok, ok ? ("voice file handed off: " + detail) : ("voice send failed: " + detail));
    };
    try { xhr.send(); } catch (e) {
        passFail(root, cfg, timer, state, false, "ledger request threw");
    }
}

function viewProbeStep(root, cfg, timer, state) {
    var lv = findByName(root, "messageListView");
    var lvCount = 0;    var lvDetail = [];
    (function walk(it, depth) {
        if (!it || depth > 12) return;
        if (it.objectName === "messageListView") {
            lvCount++;
            try {
                lvDetail.push("{y:" + Math.round(it.contentY) + ",h:" + Math.round(it.contentHeight) +
                    ",vis:" + it.visible + ",op:" + Math.round(it.opacity * 100) / 100 +
                    ",w:" + Math.round(it.width) + ",H:" + Math.round(it.height) + "}");
            } catch (e) { lvDetail.push("{err}"); }
        }
        var kids = it.children || [];
        for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    })(root, 0);
    var outer = "";
    try {
        var p = lv ? lv.parent : null;
        var d = 0;
        while (p && d < 4) {
            outer += (p.toString().split("(")[0].split("_")[0]) +
                "[y=" + Math.round(p.y || 0) + ",cy=" + Math.round(p.contentY || 0) +
                ",ch=" + Math.round(p.contentHeight || 0) + ",H=" + Math.round(p.height || 0) + "] ";
            p = p.parent;
            d++;
        }
    } catch (e) { outer = "err"; }
    var delCount = 0;
    var delIds = [];
    try {
        var all = findDelegates(lv.contentItem, []);
        delCount = all.length;
        for (var di = 0; di < all.length; di++) delIds.push(all[di].testMsgId);
    } catch (e) {}
    var m = {
        event: "viewprobe",
        n: state.tries,
        lvCount: lvCount,
        lvDetail: lvDetail.join(" "),
        outer: outer,
        delegates: delCount,
        firstDel: delIds.length ? delIds[0] : "",
        lastDel: delIds.length ? delIds[delIds.length - 1] : "",
        hasLv: !!lv,
        contentY: lv ? Math.round(lv.contentY) : -1,
        contentH: lv ? Math.round(lv.contentHeight) : -1,
        h: lv ? Math.round(lv.height) : -1,
        atEnd: lv ? !!lv.atYEnd : false,
        count: (root.activeChatMessages || []).length,
        swap: !!root.swapInFlight,
        hold: !!root.anchorHold,
        hasMore: !!root.msgsHasMore,
        loadingOlder: !!root.msgsLoadingOlder,
        msgInflight: !!root.messagesInFlight,
        mode: String(root.restoreMode || ""),
        rchat: String(root.restoreChat || "").slice(-8)
    };
    try {
        var rep = new XMLHttpRequest();
        rep.open("POST", root.testCfg.apiHost + "/api/widtest");
        rep.send(JSON.stringify({ args: { entry: m } }));
    } catch (e) {}
    if (state.tries >= 30) passFail(root, cfg, timer, state, true, "probed 30 ticks");
}

function forceEndStep(root, cfg, timer, state) {
    var lv = findByName(root, "messageListView");
    if (!lv) {
        if (state.tries > 10) passFail(root, cfg, timer, state, false, "message ListView not found");
        return;
    }
    if (!state.saved.pushed) {
        state.saved.before = Math.round(lv.contentY);
        try { lv.positionViewAtEnd(); } catch (e) { state.saved.threw = String(e); }
        try {
            state.saved.preH = Math.round(lv.contentHeight);
            lv.forceLayout();
            state.saved.postH = Math.round(lv.contentHeight);
            var mx = Math.round(lv.contentHeight - lv.height);
            lv.contentY = mx;
            state.saved.afterWrite = Math.round(lv.contentY);
            state.saved.maxWanted = mx;
        } catch (e) { state.saved.threw = String(e); }
        state.saved.pushed = true;
        return;
    }
    var m = {
        event: "forceend",
        before: state.saved.before,
        after: Math.round(lv.contentY),
        threw: state.saved.threw || "",
        atEnd: !!lv.atYEnd,
        contentH: Math.round(lv.contentHeight),
        preH: state.saved.preH,
        postH: state.saved.postH,
        afterWrite: state.saved.afterWrite,
        maxWanted: state.saved.maxWanted
    };
    try {
        var rep = new XMLHttpRequest();
        rep.open("POST", root.testCfg.apiHost + "/api/widtest");
        rep.send(JSON.stringify({ args: { entry: m } }));
    } catch (e) {}
    passFail(root, cfg, timer, state, true,
        "end push: " + state.saved.before + " -> " + Math.round(lv.contentY) + " atEnd=" + lv.atYEnd);
}

function viewerStep(root, cfg, timer, state) {
    if (!state.saved.opened) {
        root.openMediaViewer(0);
        state.saved.opened = true;
        return;
    }
    if (!root.viewerVisible) {
        if (state.tries > 25) passFail(root, cfg, timer, state, false, "viewer did not open");
        return;
    }
    var n = root.mediaList.length;
    var okOpen = n > 0;
    root.viewerStep(1);
    var okStep = n > 1 ? root.mediaIndex === 1 : root.mediaIndex === 0;
    root.closeMediaViewer();
    var okClose = !root.viewerVisible;
    passFail(root, cfg, timer, state, okOpen && okStep && okClose,
        "viewer: " + n + " media, open=" + okOpen + " step=" + okStep + " close=" + okClose);
}

// Opening a chat must land on the newest message even when the previous chat
// was left scrolled up (cold fetch) and when the chat paints instantly from
// the MRU cache. Phases are bounded, so a chat that never loads reports which
// phase stalled instead of a bare step timeout.
function reopenAtLatestStep(root, cfg, timer, state, lv) {
    if (!lv) {
        if (state.tries > 50) passFail(root, cfg, timer, state, false, "message ListView not found");
        return;
    }
    if (!root.activeChatMessages.length) return;
    var s = state.saved;
    var atEnd = function() { return lv.contentY >= lv.contentHeight - lv.height - 2; };
    var where = function() {
        return "y=" + Math.round(lv.contentY) + " ch=" + Math.round(lv.contentHeight) +
               " h=" + Math.round(lv.height);
    };
    function phase(p) { s.phase = p; s.pt = 0; dbg("reopen phase " + p); }

    if (s.phase === undefined) {
        s.origin = root.activeChat.id;
        lv.contentY = 150;                       // user reading older messages
        s.cands = [];
        var chats = root.allChats || [];
        for (var i = 0; i < chats.length && s.cands.length < 4; i++) {
            if (chats[i].id !== s.origin) s.cands.push(chats[i]);
        }
        phase(1);
        return;
    }
    s.pt++;

    if (s.phase === 1) {                         // closed-loop park: a settle can steal the write
        if (Math.abs(lv.contentY - 150) > 25) {
            lv.contentY = 150;
            s.pt = 0;
            return;
        }
        if (s.pt < 3) return;
        s.candIdx = 0;
        if (!s.cands.length) { passFail(root, cfg, timer, state, false, "no second chat to switch to"); return; }
        switchTo(root, s.cands[0]);
        phase(2);
        return;
    }

    if (s.phase === 2) {                         // cold switch (no cache) -> newest
        if (root.activeChat.id !== s.cands[s.candIdx].id) return;
        if (root.activeChatMessages.length > 0) {
            if (atEnd()) {
                s.coldY = Math.round(lv.contentY);
                root.activeChat = { id: s.origin, name: "origin", isGroup: false };
                phase(3);
                return;
            }
            if (s.pt > 20) passFail(root, cfg, timer, state, false,
                "cold switch stayed off the newest message (" + where() + ")");
            return;
        }
        // Empty chat: move on once its load settled (or it dawdles).
        var settled = !root.isLoadingMessages && !root.messagesInFlight;
        if ((settled || s.pt > 25) && !atEnd()) {
            s.candIdx++;
            if (s.candIdx >= s.cands.length) {
                passFail(root, cfg, timer, state, false, "no chat with history to switch to");
                return;
            }
            switchTo(root, s.cands[s.candIdx]);
            phase(2);
        }
        return;
    }

    if (root.activeChat.id !== s.origin) return;  // phase 3: cached switch (MRU paint, then revalidate)
    if (root.activeChatMessages.length > 0 && atEnd()) {
        passFail(root, cfg, timer, state, true,
            "chat switch lands on newest (cold y=" + s.coldY + ", cached " + where() + ")");
        return;
    }
    if (s.pt > 20) passFail(root, cfg, timer, state, false,
        "cached switch stayed off the newest message (" + where() + ")");
}

// Switch chats the way the chat list does, so the open path (MRU cache paint
// plus revalidate fetch) runs for real.
function switchTo(root, chat) {
    root.activeChat = {
        id: chat.id,
        name: chat.name || chat.formattedTitle || "Unknown",
        isGroup: chat.isGroup || false
    };
}

// Node export (no-op; kept for lint parity with the other UI helpers).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { maybeStart: maybeStart };
}