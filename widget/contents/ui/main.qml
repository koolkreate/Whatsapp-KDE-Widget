import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import QtQuick.Controls
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
import QtQuick.Dialogs
import "messageUtils.js" as MsgUtils
import "pollingUtils.js" as PollUtils

PlasmoidItem {
    id: root

    // ── Sizing ──────────────────────────────────────────────────────────────
    width:  340
    height: 520

    Plasmoid.icon:  "im-whatsapp"
    Plasmoid.title: "WhatsApp Quick"

    // ── State ────────────────────────────────────────────────────────────────
    property string apiHost:      "http://127.0.0.1:8002"
    property string apiKey:       "KDE_WHATSAPP_SECRET_KEY"
    property Item messageInputRef: null
    property var    allChats:     []
    property var    filteredChats: []
    property string searchQuery:  ""
    property var    activeChat:   null   // { id, name, isGroup }
    property var    activeChatMessages: []
    property bool   isLoadingMessages: false
    property bool   isConnected:  false
    property bool   isLoading:    false
    property bool   hasQrCode:    false
    property int    qrSeq:        0
    property string statusMessage: "Connecting to backend…"
    property int    totalUnread:  0
    property bool   sendInFlight: false
    property bool   chatsInFlight: false
    property bool   messagesInFlight: false
    property string lastMsgSig: ""   // change signature of the open chat
    property int    pollStreak: 0          // consecutive unchanged polls (backoff)
    property int    authFailStreak: 0      // consecutive data-load failures (auth watch)
    property bool   autoLogoutInFlight: false // /api/logout request guard
    property int    pollsSinceFull: 0      // incremental fetches since last full refresh
    property bool   waitLoopRunning: false // long-poll chain guard
    property var    chatAvatarHashes: ({}) // chatId -> avatar hash
    signal messageSent(bool success)
    property bool   emojiPickerVisible: false
    property string activeReactionMsgId: ""  // msg id for reaction popup
    property string pendingReplyId: ""     // msg id being replied to (quoted send)
    property string replyPreviewLabel: ""  // short preview shown in the quote bar
    property var    contextReplyMsg: null  // message that was right-clicked
    property var    contextChat: null      // chat that was right-clicked
    property var    pinnedChats: []        // list of pinned chat IDs
    property string pendingAttachmentPath: "" // pasted image waiting to be sent
    property bool   copyToastVisible: false

    // ── Lazy-load + MRU cache + media viewer (Slices 2–4) ────────────────────
    property int    chatsShown: 20          // chat-list window size (scroll grows it)
    property bool   msgsHasMore: false      // older messages exist for the open chat
    property bool   msgsLoadingOlder: false // top-edge page in flight
    property string msgsTopError: ""        // failed top-edge page (retry row)
    property var    msgCache: ({})          // chatId -> { messages, sig, savedAt } (MRU-3)
    property var    mruOrder: []            // most-recent-first chatIds, max 3
    property bool   viewerVisible: false    // fullscreen media overlay
    property var    mediaList: []           // viewable media msgs of the open chat
    property int    mediaIndex: 0
    property var    _thumbInflight: ({})    // msgId|maxEdge -> true (getMedia dedupe)
    property bool   viewerFullLoading: false // full-res fetch in flight for viewer
    property bool   viewerFullFailed: false // full-res fetch failed (retry cue)
    property string viewerFullSource: ""    // dataUrl of the full-res viewer image
    property string viewerFullMsgId: ""     // msg id the viewerFullSource belongs to
    property string viewerOpenError: ""     // transient openExternally failure text
    property string _pendingOpenChatId: ""  // cold open queued while a poll is in flight
    property int    _waitGen: 0             // wait-loop generation (chat switches)

    function isChatPinned(chat) {
        if (!chat) return false;
        if (typeof chat === "object" && chat.isPinned) return true;
        var cid = (typeof chat === "string") ? chat : (chat.id || "");
        if (!cid || !root.pinnedChats) return false;
        for (var i = 0; i < root.pinnedChats.length; i++) {
            if (root.pinnedChats[i] === cid) return true;
        }
        return false;
    }

    function sortAndFilterChats() {
        if (!root.allChats || root.allChats.length === 0) {
            root.filteredChats = [];
            return;
        }
        root.allChats.sort(function(a, b) {
            return MsgUtils.compareChats(a, b, root.isChatPinned);
        });
        filterChats();
    }

    function fetchPinnedChats() {
        if (!root.isConnected) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getPinnedChats");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    root.pinnedChats = r.response || [];
                    sortAndFilterChats();
                } catch(e) { }
            }
        };
        xhr.send(JSON.stringify({ args: {} }));
    }

    function togglePinChat(chatId) {
        if (!root.isConnected || !chatId) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/togglePinChat");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    root.pinnedChats = r.response || [];
                    sortAndFilterChats();
                } catch(e) { }
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: chatId } }));
    }

    // Emoji-supporting font - use Noto Color Emoji if available, fallback to default
    readonly property string emojiFont: "Noto Color Emoji, emoji, monospace"

    onMediaIndexChanged: {
        if (viewerVisible) viewerLoadFull();
    }

    onActiveChatChanged: {
        root.clearPendingReply();
        root.clearPendingAttachment();
        root.lastMsgSig = "";
        root.pollStreak = 0;
        root.pollsSinceFull = 0;
        root.msgsTopError = "";
        if (activeChat !== null) {
            root._waitGen++;
            root.waitLoopRunning = false;
            root._pendingOpenChatId = "";
            root.mruTouch(activeChat.id);
            var cached = root.msgCache[activeChat.id];
            if (cached && cached.messages && cached.messages.length > 0) {
                // MRU hit: paint the cached copy instantly, then revalidate in
                // the background — never present stale data as final.
                root.activeChatMessages = cached.messages;
                root.msgsHasMore = true;
                root.isLoadingMessages = false;
                fetchMessages(activeChat.id);
            } else {
                root.activeChatMessages = [];
                root.msgsHasMore = false;
                fetchMessages(activeChat.id);
            }
            messageWaitLoop();
        } else {
            root.activeChatMessages = [];
            root.msgsHasMore = false;
        }
    }

    // ── Colour palette (WhatsApp dark) ───────────────────────────────────────
    readonly property color colBg:        "#0b141a"
    readonly property color colSurface:   "#111b21"
    readonly property color colPanel:     "#202c33"
    readonly property color colBorder:    "#374248"
    readonly property color colAccent:    "#00a884"
    readonly property color colAccentDim: "#006653"
    readonly property color colText:      "#e9edef"
    readonly property color colSub:       "#8696a0"
    readonly property color colGreen:     "#25d366"
    readonly property color colHeader:    "#1f2c34"

    // ── Avatar colour palette (12 distinct hues) ────────────────────────────
    readonly property var avatarColors: [
        "#ef5350","#ab47bc","#42a5f5","#26a69a",
        "#d4e157","#ff7043","#ec407a","#7e57c2",
        "#29b6f6","#66bb6a","#ffa726","#26c6da"
    ]

    function avatarColor(name) {
        if (!name) return colAccent;
        var h = 0;
        for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xfffff;
        return avatarColors[h % avatarColors.length];
    }

    function chatInitial(chat) {
        var n = chat.name || chat.formattedTitle || "?";
        return n.charAt(0).toUpperCase();
    }

    function formatTime(ts) {
        if (!ts) return "";
        var d = new Date(ts * 1000);
        var now = new Date();
        if (d.toDateString() === now.toDateString()) {
            var h = d.getHours(), m = d.getMinutes();
            return (h < 10 ? "0"+h : h) + ":" + (m < 10 ? "0"+m : m);
        }
        var diff = Math.floor((now - d) / 86400000);
        if (diff === 1) return "Yesterday";
        if (diff < 7)  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()];
        return d.toLocaleDateString(undefined, { day:"numeric", month:"short" });
    }

    function lastPreview(chat) {
        var msg = chat.lastMessage;
        if (!msg) return "";
        if (msg.isRevoked) return "🚫 Deleted message";

        // Media type icons (caption shown alongside when present).
        var mediaLabel = "";
        if (msg.type === "image")         mediaLabel = "📷 Photo";
        else if (msg.type === "video")    mediaLabel = "🎥 Video";
        else if (msg.type === "audio" || msg.type === "ptt") mediaLabel = "🎵 Audio";
        else if (msg.type === "document") mediaLabel = "📄 Document";
        else if (msg.type === "sticker")  mediaLabel = "🪄 Sticker";

        var body = msg.caption || msg.body || msg.content || "";
        var text;
        if (mediaLabel !== "") {
            text = body !== "" ? mediaLabel + " " + body : mediaLabel;
        } else {
            text = body;
        }

        // Group chats: prefix the sender for incoming messages ("Ada: hello").
        if (!msg.fromMe && chat.isGroup && msg.senderName && text !== "") {
            text = msg.senderName + ": " + text;
        }
        // Own messages: minimal "sent" tick prefix.
        if (msg.fromMe && text !== "") {
            text = "✓ " + text;
        }

        return text.length > 48 ? text.substring(0, 48) + "…" : text;
    }

    // ── Reply & copy helpers ──────────────────────────────────────────────────
    function clearPendingReply() {
        root.pendingReplyId = "";
        root.replyPreviewLabel = "";
    }

    function startReplyFromContext() {
        if (!root.contextReplyMsg) return;
        var m = root.contextReplyMsg;
        root.pendingReplyId = m.id || "";
        root.replyPreviewLabel = MsgUtils.replyPreviewText(m);
        if (root.messageInputRef) root.messageInputRef.forceActiveFocus();
    }

    function copyToClipboard(text) {
        if (!text) return;
        clipTextEdit.text = text;
        clipTextEdit.selectAll();
        clipTextEdit.copy();
        clipTextEdit.deselect();
        root.copyToastVisible = true;
        copyToastTimer.restart();
    }

    function copyContextMessage() {
        if (!root.contextReplyMsg) return;
        root.copyToClipboard(MsgUtils.copyTextForMessage(root.contextReplyMsg));
    }

    // ── API ──────────────────────────────────────────────────────────────────
    function checkStatus() {
        var xhr = new XMLHttpRequest();
        xhr.open("GET", apiHost + "/api/status");
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var res = JSON.parse(xhr.responseText);
                    if (res.ready) {
                        root.isConnected = true;
                        root.hasQrCode = false;
                        root.statusMessage = "";
                        fetchPinnedChats();
                        fetchChats();
                    } else {
                        root.isConnected = false;
                        root.hasQrCode = !!res.hasQr;
                        root.statusMessage = "Backend starting up…\nScan QR code to link WhatsApp.";
                    }
                } catch(e) {
                    root.isConnected = false;
                    root.statusMessage = "Unexpected server response.";
                }
            } else {
                root.isConnected = false;
                root.statusMessage = "Cannot reach backend.\nRun: ./manage.sh start-backend  in the project folder.";
            }
        };
        xhr.send();
    }

    // ── Auto-logout / auth recovery ──────────────────────────────────────────
    // When data loads fail because the WhatsApp session lost auth (401 from
    // the backend, or repeated 5xx while connected), reset the backend to the
    // QR login flow and drop the widget back to the connection screen so a
    // fresh QR can be scanned.
    function triggerAutoLogout() {
        if (root.autoLogoutInFlight) return;
        root.autoLogoutInFlight = true;
        root.statusMessage = "Session expired — reconnecting…";
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/logout");
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.autoLogoutInFlight = false;
            root.isConnected = false;
            root.activeChat = null;
            root.activeChatMessages = [];
            root.hasQrCode = false;
            root.authFailStreak = 0;
            root.pollStreak = 0;
            root.lastMsgSig = "";
            root.waitLoopRunning = false;
            root.statusMessage = "WhatsApp session ended.\nScan the QR code to link again.";
            checkStatus();
        };
        try {
            xhr.send(JSON.stringify({ args: {} }));
        } catch (e) {
            root.autoLogoutInFlight = false;
        }
    }

    function fetchChats() {
        if (!root.isConnected || root.chatsInFlight) return;
        root.chatsInFlight = true;
        root.isLoading = true;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getAllChats");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.chatsInFlight = false;
            root.isLoading = false;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    var chats = r.response || r || [];
                    root.allChats = chats;
                    root.chatsShown = 20;
                    root.authFailStreak = 0;
                    var u = 0;
                    for (var i = 0; i < chats.length; i++) u += chats[i].unreadCount || 0;
                    root.totalUnread = u;
                    sortAndFilterChats();
                    fetchAvatars();
                } catch(e) {
                    console.log("Parse error:", e);
                }
            } else if (xhr.status === 401) {
                // WhatsApp session lost auth — reset to the QR login flow.
                triggerAutoLogout();
            } else if (xhr.status === 503) {
                // A single 503 is normal during a backend restart; repeated
                // failures while we believe we're connected mean lost auth.
                root.authFailStreak++;
                if (root.authFailStreak >= 3) {
                    triggerAutoLogout();
                } else {
                    root.isConnected = false;
                    root.statusMessage = "WhatsApp client initializing…";
                }
            }
        };
        xhr.send(JSON.stringify({ args: {} }));
    }

    // ── Avatars ──────────────────────────────────────────────────────────────
    // Asks the backend for avatar hashes; only changed images ship bytes and
    // are then served by GET /api/avatar/<hash> (cached by the image loader).
    function fetchAvatars() {
        if (!root.isConnected || root.allChats.length === 0) return;
        var req = [];
        var hashes = {};
        for (var i = 0; i < root.allChats.length; i++) {
            var c = root.allChats[i];
            req.push({ id: c.id, name: c.name });
            if (root.chatAvatarHashes[c.id]) hashes[c.id] = root.chatAvatarHashes[c.id];
        }
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getAvatars");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status !== 200) return;
            try {
                var r = JSON.parse(xhr.responseText);
                var items = r.response || [];
                var updated = {};
                for (var k in root.chatAvatarHashes) updated[k] = root.chatAvatarHashes[k];
                for (var j = 0; j < items.length; j++) {
                    if (items[j].changed && items[j].hash) updated[items[j].id] = items[j].hash;
                }
                root.chatAvatarHashes = updated;
            } catch (e) {
                console.log("Avatars parse error:", e);
            }
        };
        xhr.send(JSON.stringify({ args: { chats: req, hashes: hashes } }));
    }

    function avatarSource(chatId) {
        var h = root.chatAvatarHashes[chatId];
        return h ? apiHost + "/api/avatar/" + h + "?key=" + apiKey : "";
    }

    // ── Long-poll message loop ───────────────────────────────────────────────
    // Replaces blind 5s polling: the backend resolves as soon as the open
    // chat changes (or after ~20s), then we do an incremental fetch. On
    // errors we fall back to an adaptive poll interval.
    function messageWaitLoop() {
        if (!root.isConnected || root.activeChat === null || root.waitLoopRunning) return;
        root.waitLoopRunning = true;
        var chatId = root.activeChat.id;
        var gen = root._waitGen;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/waitMessages");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.timeout = 25000;
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (PollUtils.isStaleLoop(gen, root._waitGen)) return;
            root.waitLoopRunning = false;
            var changed = false;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    changed = !!r.changed;
                    if (r.sig && r.sig !== root.lastMsgSig) root.lastMsgSig = r.sig;
                } catch (e) { }
            }
            if (xhr.status === 200 && changed && root.activeChat && root.activeChat.id === chatId) {
                fetchMessages(chatId, true);
                messageWaitLoop(); // keep the chain going
            } else if (xhr.status === 401) {
                // Session lost auth mid-conversation — reset to QR flow.
                triggerAutoLogout();
            } else if (xhr.status !== 200) {
                // Error path: exponential backoff via messageWaitBackoff timer.
                root.pollStreak++;
                messageWaitBackoff.restart();
            } else {
                // Timeout with no change — immediately re-attach.
                messageWaitLoop();
            }
        };
        try {
            xhr.send(JSON.stringify({ args: { chatId: chatId, sig: root.lastMsgSig } }));
        } catch (e) {
            root.waitLoopRunning = false;
            messageWaitBackoff.restart();
        }
    }

    function fetchMessages(chatId, background) {
        if (!root.isConnected || !chatId) return;
        if (root.messagesInFlight) {
            if (PollUtils.shouldQueueColdOpen(true, background)) {
                root._pendingOpenChatId = chatId;
                root.isLoadingMessages = true;
            }
            return;
        }
        root.messagesInFlight = true;
        if (!background) root.isLoadingMessages = true;

        // Background polls ask the backend only for messages newer than what
        // we already hold (with a periodic full refresh as a safety net).
        var existing = root.activeChatMessages;
        var useSince = background && existing.length > 0 && root.pollsSinceFull < 12;
        var args = { chatId: chatId };
        if (useSince) {
            var lastKnown = existing[existing.length - 1];
            args.since = { id: lastKnown.id, t: lastKnown.t || 0 };
        } else if (!background) {
            // Cold open: only the most recent page; older history loads on
            // scroll-up via beforeId (fetchOlderMessages).
            args.limit = 20;
        }

        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getChatMessages");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.messagesInFlight = false;
            var pending = PollUtils.consumePendingOpen(root._pendingOpenChatId, root.activeChat ? root.activeChat.id : "");
            root._pendingOpenChatId = "";
            if (pending) {
                fetchMessages(pending, false);
                return;
            }
            // Discard responses for a chat that is no longer open — they must
            // never merge into another chat's view.
            if (root.activeChat === null || root.activeChat.id !== chatId) return;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    var fresh = r.response || r || [];
                    // Cheap change check: skip the (expensive) model swap and
                    // scroll jump when the poll returned nothing new.
                    var sig = r.sig || (fresh.length + ":" + (fresh.length ? fresh[fresh.length - 1].id : ""));
                    if (background && sig === root.lastMsgSig) return;
                    root.lastMsgSig = sig;
                    root.pollStreak = 0;
                    var wasAtEnd = (typeof messageListView !== "undefined" && messageListView && messageListView.atYEnd);
                    // Always merge against the LIVE list (not the snapshot
                    // taken at request time): an optimistic send may have
                    // appended a temp bubble while this request was in flight.
                    // settleMessages() preserves unconfirmed temp sends and
                    // drops temps the server has confirmed — no duplicates or
                    // vanishing bubbles when sends and incoming polls race.
                    if (useSince) {
                        root.pollsSinceFull++;
                        var mergedInc = PollUtils.settleMessages(root.activeChatMessages, fresh);
                        root.activeChatMessages = root.carryMediaUrls(root.activeChatMessages, mergedInc);
                    } else {
                        root.pollsSinceFull = 0;
                        var mergedFull = PollUtils.settleMessages(root.activeChatMessages, fresh);
                        root.activeChatMessages = root.carryMediaUrls(root.activeChatMessages, mergedFull);
                        if (!background) root.msgsHasMore = (r.hasMore === true);
                    }
                    // Keep this chat's MRU cache copy fresh (thumbnailized).
                    if (root.activeChat && root.activeChat.id === chatId) {
                        root.mruStore(chatId, root.activeChatMessages, sig);
                    }
                    // Scroll to bottom after updating, but only when the user
                    // was already reading the latest messages.
                    if (wasAtEnd) {
                        Qt.callLater(function() {
                            if (typeof messageListView !== "undefined" && messageListView) {
                                messageListView.positionViewAtEnd();
                            }
                        });
                    }
                } catch(e) {
                    console.log("Parse messages error:", e);
                }
            } else if (xhr.status === 401) {
                // Session lost auth — reset to the QR login flow.
                triggerAutoLogout();
            } else if (xhr.status > 0) {
                // Repeated server errors while connected point at lost auth.
                root.authFailStreak++;
                if (root.authFailStreak >= 3) triggerAutoLogout();
            }
        };
        xhr.send(JSON.stringify({ args: args }));
    }

    // ── Top-edge pagination: load 20 older messages on scroll-up ─────────────
    function fetchOlderMessages() {
        if (!root.isConnected || root.activeChat === null || root.msgsLoadingOlder || !root.msgsHasMore) return;
        if (root.messagesInFlight) return; // serialize with background polls
        var msgs = root.activeChatMessages;
        if (msgs.length === 0) return;
        var oldest = null;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && msgs[i].id && String(msgs[i].id).indexOf("temp_") !== 0) { oldest = msgs[i]; break; }
        }
        if (!oldest) return;

        var chatId = root.activeChat.id;
        root.msgsLoadingOlder = true;
        root.msgsTopError = "";
        root.messagesInFlight = true;

        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getChatMessages");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.timeout = 30000;
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.msgsLoadingOlder = false;
            root.messagesInFlight = false;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    if (root.activeChat === null || root.activeChat.id !== chatId) return;
                    var older = r.response || [];
                    root.msgsHasMore = (r.hasMore === true);
                    if (older.length === 0) return;
                    var oldH = (typeof messageListView !== "undefined" && messageListView) ? messageListView.contentHeight : 0;
                    root.activeChatMessages = PollUtils.prependOlder(root.activeChatMessages, older);
                    // Keep the visual anchor: shift by the height we added at
                    // the top so the view doesn't jump.
                    if (oldH > 0) {
                        Qt.callLater(function() {
                            if (typeof messageListView !== "undefined" && messageListView) {
                                messageListView.contentY += messageListView.contentHeight - oldH;
                            }
                        });
                    }
                } catch(e) {
                    root.msgsTopError = "Couldn't load older messages";
                }
            } else if (xhr.status === 401) {
                triggerAutoLogout();
            } else if (xhr.status > 0) {
                // Failure keeps everything already loaded; the retry row shows.
                root.msgsTopError = "Couldn't load older messages";
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: chatId, limit: 20, beforeId: oldest.id, beforeT: oldest.t || 0 } }));
    }

    // ── MRU-3 chat cache: instant render + background revalidate ─────────────
    function mruTouch(chatId) {
        var ord = [];
        for (var i = 0; i < root.mruOrder.length; i++) {
            if (root.mruOrder[i] !== chatId) ord.push(root.mruOrder[i]);
        }
        ord.unshift(chatId);
        while (ord.length > 3) {
            var evict = ord.pop();
            var next = {};
            for (var k in root.msgCache) {
                if (k !== evict) next[k] = root.msgCache[k];
            }
            root.msgCache = next;
        }
        root.mruOrder = ord;
    }

    function mruStore(chatId, messages, sig) {
        if (!chatId || !messages || messages.length === 0) return;
        var thumbs = [];
        for (var i = 0; i < messages.length; i++) {
            var t = MsgUtils.thumbnailize(messages[i], 4096);
            // Persist thumbUrl on the placeholder copy so MRU-cached chats
            // repaint 480p thumbs instantly (never strip it).
            if (messages[i] && messages[i].thumbUrl && !t.thumbUrl) {
                t.thumbUrl = messages[i].thumbUrl;
            }
            thumbs.push(t);
        }
        var next = {};
        for (var k in root.msgCache) next[k] = root.msgCache[k];
        next[chatId] = { messages: thumbs, sig: sig || "", savedAt: Date.now() };
        root.msgCache = next;
        root.mruTouch(chatId);
    }

    // ── 480p media thumbnails via POST /api/getMedia (Slices 2–3) ────────────
    // Contract: POST {apiHost}/api/getMedia, headers Content-Type
    // application/json + X-API-Key, body {args:{chatId,msgId,maxEdge}};
    // success {response:{dataUrl,width,height}}; maxEdge 480 = thumb, 0 = full.
    function fetchMedia(chatId, msgId, maxEdge, onDone) {
        if (!root.isConnected || !chatId || !msgId) {
            if (onDone) onDone("");
            return;
        }
        var key = msgId + "|" + maxEdge;
        if (root._thumbInflight[key]) return;
        root._thumbInflight[key] = true;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getMedia");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            var next = {};
            for (var k in root._thumbInflight) {
                if (k !== key) next[k] = root._thumbInflight[k];
            }
            root._thumbInflight = next;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    var resp = r.response || {};
                    var url = resp.dataUrl || "";
                    if (onDone) onDone(url, resp.width || 0, resp.height || 0);
                } catch(e) {
                    if (onDone) onDone("");
                }
            } else {
                if (onDone) onDone("");
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: chatId, msgId: msgId, maxEdge: maxEdge } }));
    }

    // Lazy 480p thumb for one bubble: fetch once when the delegate becomes
    // visible, then write the dataUrl back onto the live message + MRU copy.
    function requestThumb(msg) {
        if (!msg || msg.thumbUrl) return;
        var need = false;
        try {
            need = MsgUtils.needsThumb(msg);
        } catch(e) {
            return;
        }
        if (!need) return;
        if (!root.activeChat || !msg.id) return;
        var chatId = root.activeChat.id;
        var mid = msg.id;
        root.fetchMedia(chatId, mid, 480, function(url) {
            if (!url) return;
            root.applyThumbUrl(mid, url);
        });
    }

    // Write a fetched thumbUrl back onto the live list (reassign to notify
    // the ListView) and onto the MRU cached copy for instant repaint.
    function applyThumbUrl(msgId, dataUrl) {
        if (!msgId || !dataUrl) return;
        var found = false;
        var msgs = root.activeChatMessages;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && msgs[i].id === msgId) {
                msgs[i].thumbUrl = dataUrl;
                found = true;
                break;
            }
        }
        if (!found) return;
        root.activeChatMessages = msgs.slice();
        if (root.activeChat) {
            var cid = root.activeChat.id;
            var entry = root.msgCache[cid];
            if (entry && entry.messages) {
                for (var j = 0; j < entry.messages.length; j++) {
                    if (entry.messages[j] && entry.messages[j].id === msgId) {
                        entry.messages[j].thumbUrl = dataUrl;
                        break;
                    }
                }
                var next = {};
                for (var k in root.msgCache) next[k] = root.msgCache[k];
                root.msgCache = next;
            }
        }
    }

    // Carry cached thumbUrl/fullUrl across poll merges so a revalidate
    // never blanks already-resolved 480p thumbs (poll payloads carry no
    // media URLs). Pure overlay: message set, order and sort untouched.
    function carryMediaUrls(oldMsgs, merged) {
        if (!merged) return merged;
        var cache = {};
        for (var i = 0; i < (oldMsgs || []).length; i++) {
            var o = oldMsgs[i];
            if (o && o.id && (o.thumbUrl || o.fullUrl)) {
                cache[o.id] = o;
            }
        }
        for (var j = 0; j < merged.length; j++) {
            var mm = merged[j];
            if (mm && mm.id && cache[mm.id]) {
                if (!mm.thumbUrl && cache[mm.id].thumbUrl) mm.thumbUrl = cache[mm.id].thumbUrl;
                if (!mm.fullUrl && cache[mm.id].fullUrl) mm.fullUrl = cache[mm.id].fullUrl;
            }
        }
        return merged;
    }

    // ── Fullscreen media viewer (Slice 4) ────────────────────────────────────
    function openMediaViewer(startIndex) {
        var list = MsgUtils.buildMediaList(root.activeChatMessages);
        if (!list || list.length === 0 || startIndex < 0 || startIndex >= list.length) return;
        root.mediaList = list;
        root.mediaIndex = startIndex;
        root.viewerVisible = true;
        root.viewerOpenError = "";
        root.viewerFullFailed = false;
        root.viewerLoadFull();
    }

    function closeMediaViewer() {
        root.viewerVisible = false;
        root.viewerFullLoading = false;
        root.viewerFullFailed = false;
        root.viewerOpenError = "";
    }

    function viewerStep(d) {
        if (!root.mediaList || root.mediaList.length === 0) return;
        root.viewerFullFailed = false;
        root.viewerOpenError = "";
        root.mediaIndex = (root.mediaIndex + d + root.mediaList.length) % root.mediaList.length;
    }

    // Fetch full-res (maxEdge 0) for the current viewer index with a spinner;
    // the cached 480p thumb stays painted until the full image arrives.
    function viewerLoadFull() {
        var m = null;
        if (root.mediaList && root.mediaList.length > 0) {
            var ci = Math.max(0, Math.min(root.mediaIndex, root.mediaList.length - 1));
            m = root.mediaList[ci];
        }
        if (!m) {
            root.viewerFullLoading = false;
            return;
        }
        var mid = m.id || "";
        if (m.fullUrl) {
            root.viewerFullMsgId = mid;
            root.viewerFullSource = m.fullUrl;
            root.viewerFullLoading = false;
            root.viewerPrefetchNeighbours();
            return;
        }
        if (!root.isConnected || !root.activeChat || !mid) {
            root.viewerFullLoading = false;
            return;
        }
        root.viewerFullMsgId = mid;
        root.viewerFullSource = "";
        root.viewerFullLoading = true;
        root.viewerFullFailed = false;
        var chatId = root.activeChat.id;
        root.fetchMedia(chatId, mid, 0, function(url) {
            var cur = null;
            if (root.mediaList && root.mediaList.length > 0) {
                var ni = Math.max(0, Math.min(root.mediaIndex, root.mediaList.length - 1));
                cur = root.mediaList[ni];
            }
            if (!cur || (cur.id || "") !== mid) return;
            if (url && url !== "") {
                root.viewerFullSource = url;
                for (var i = 0; i < root.activeChatMessages.length; i++) {
                    if (root.activeChatMessages[i] && root.activeChatMessages[i].id === mid) {
                        root.activeChatMessages[i].fullUrl = url;
                        break;
                    }
                }
                root.viewerFullLoading = false;
                root.viewerFullFailed = false;
            } else {
                root.viewerFullSource = "";
                root.viewerFullLoading = false;
                root.viewerFullFailed = true;
            }
            root.viewerPrefetchNeighbours();
        });
    }

    // Low-priority prefetch of full-res for prev/next neighbours; failures
    // are silent (viewer still shows the cached thumb + retry on revisit).
    function viewerPrefetchNeighbours() {
        if (!root.isConnected || !root.activeChat) return;
        if (!root.mediaList || root.mediaList.length < 2) return;
        var idx = Math.max(0, Math.min(root.mediaIndex, root.mediaList.length - 1));
        var chatId = root.activeChat.id;
        var sides = [idx - 1, idx + 1];
        for (var s = 0; s < sides.length; s++) {
            (function(ni) {
                if (ni < 0 || ni >= root.mediaList.length) return;
                var nm = root.mediaList[ni];
                if (!nm || !nm.id || nm.fullUrl) return;
                var nid = nm.id;
                root.fetchMedia(chatId, nid, 0, function(url) {
                    if (!url) return;
                    for (var i = 0; i < root.mediaList.length; i++) {
                        if (root.mediaList[i] && root.mediaList[i].id === nid) {
                            root.mediaList[i].fullUrl = url;
                            break;
                        }
                    }
                });
            })(sides[s]);
        }
    }

    // Open the current viewer image in the system viewer via
    // POST /api/openExternally (full-res fetch + xdg-open server-side).
    // Failures show a brief inline footer error, never silent or fatal.
    function openExternallyCurrent() {
        var m = null;
        if (root.mediaList && root.mediaList.length > 0) {
            var ci = Math.max(0, Math.min(root.mediaIndex, root.mediaList.length - 1));
            m = root.mediaList[ci];
        }
        if (!m || !m.id || !root.isConnected || !root.activeChat) {
            root.viewerOpenError = "Couldn't open image";
            viewerOpenErrorTimer.restart();
            return;
        }
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/openExternally");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                root.viewerOpenError = "";
            } else {
                root.viewerOpenError = "Couldn't open in system viewer";
                viewerOpenErrorTimer.restart();
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: root.activeChat.id, msgId: m.id } }));
    }

    function sendMessage(chatId, text) {
        if (!text.trim() || root.sendInFlight) return;

        var originalText = text;
        if (root.messageInputRef) root.messageInputRef.text = "";

        // Create a local temporary message for instant display
        var tempMsgId = "temp_" + Date.now();
        var tempMsg = {
            id: tempMsgId,
            body: originalText,
            type: "chat",
            t: Math.floor(Date.now() / 1000),
            fromMe: true,
            senderName: "",
            reactions: []
        };

        var currentMsgs = [];
        for (var idx = 0; idx < root.activeChatMessages.length; idx++) {
            currentMsgs.push(root.activeChatMessages[idx]);
        }
        currentMsgs.push(tempMsg);
        root.activeChatMessages = currentMsgs;

        // Position at the bottom of the messages list
        Qt.callLater(function() {
            if (typeof messageListView !== "undefined" && messageListView) {
                messageListView.positionViewAtEnd();
            }
        });

        root.sendInFlight = true;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/sendText");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.sendInFlight = false;
            if (xhr.status === 200) {
                root.messageSent(true);
                root.clearPendingReply();
                fetchMessages(chatId);
            } else {
                root.messageSent(false);
                console.log("Send failed:", xhr.responseText);
                // Restore input text on failure
                if (root.messageInputRef && root.messageInputRef.text === "") {
                    root.messageInputRef.text = originalText;
                }
                // Remove the temporary message from history
                var msgs = [];
                for (var i = 0; i < root.activeChatMessages.length; i++) {
                    if (root.activeChatMessages[i].id !== tempMsgId) {
                        msgs.push(root.activeChatMessages[i]);
                    }
                }
                root.activeChatMessages = msgs;
            }
        };
        xhr.send(JSON.stringify({ args: { to: chatId, content: originalText, replyToId: root.pendingReplyId } }));
    }

    function sendFile(chatId, filePath, caption) {
        if (!filePath || root.sendInFlight) return;
        root.sendInFlight = true;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/sendFile");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.sendInFlight = false;
            if (xhr.status === 200) {
                root.messageSent(true);
                fetchMessages(chatId);
            } else {
                root.messageSent(false);
                console.log("Send file failed:", xhr.responseText);
            }
        };
        xhr.send(JSON.stringify({ args: { to: chatId, filePath: filePath.toString(), caption: caption || "" } }));
    }

    function restartBackend() {
        root.statusMessage = "Restarting backend daemon…\nPlease wait a moment.";
        root.isConnected = false;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/restart");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            statusCheckTimer.restart();
        };
        xhr.send(JSON.stringify({ args: {} }));
    }

    function sendReaction(chatId, msgId, reaction, remove) {
        if (!root.isConnected || !chatId || !msgId || !reaction) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/sendReaction");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                fetchMessages(root.activeChat.id);
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: chatId, msgId: msgId, reaction: reaction, remove: !!remove } }));
    }

    // Paste: save the clipboard image as a DRAFT attachment. It is NOT sent
    // until the user presses the send button (or Enter).
    function pasteImageFromClipboard() {
        if (!root.isConnected || root.sendInFlight) return;
        if (!root.activeChat) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/pasteImage");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var res = JSON.parse(xhr.responseText);
                    if (res.response === "saved" && res.path) {
                        root.pendingAttachmentPath = res.path;
                    } else if (res.response === "no_image") {
                        console.log("No image found in clipboard");
                    }
                } catch(e) {
                    console.log("Paste image error:", e);
                }
            } else {
                console.log("Paste image failed:", xhr.status, xhr.responseText);
            }
        };
        xhr.send(JSON.stringify({ args: { to: root.activeChat ? root.activeChat.id : "" } }));
    }

    function clearPendingAttachment() {
        root.pendingAttachmentPath = "";
    }

    // Send whatever is composed: a pasted image draft (with optional caption
    // from the input box) and/or plain text.
    function sendComposed() {
        if (!root.activeChat || root.sendInFlight) return;
        var text = root.messageInputRef ? root.messageInputRef.text.trim() : "";
        if (root.pendingAttachmentPath !== "") {
            var path = root.pendingAttachmentPath;
            root.clearPendingAttachment();
            if (root.messageInputRef) root.messageInputRef.text = "";
            root.sendFile(root.activeChat.id, path, text);
        } else if (text.length > 0) {
            sendMessage(root.activeChat.id, text);
        }
    }

    function filterChats() {
        if (!root.allChats || root.allChats.length === 0) { root.filteredChats = []; return; }
        var q = root.searchQuery.trim().toLowerCase();
        if (q === "") { root.filteredChats = root.allChats; return; }
        var res = [];
        for (var i = 0; i < root.allChats.length; i++) {
            var c = root.allChats[i];
            var n = (c.name || c.formattedTitle || "").toLowerCase();
            var phone = ((c.id || "").split("@")[0] || "").toLowerCase();
            if (n.indexOf(q) !== -1 || phone.indexOf(q) !== -1) res.push(c);
        }
        root.filteredChats = res;
    }

    // ── Commonly used emojis for picker ──────────────────────────────────────────────────
    readonly property var emojiList: [
        "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃","😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😋",
        "😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔","🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥","😌",
        "😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮","🥴","😵","🤯","🤠","🥳","🥸","😎","🤓","🧐","😕","😟",
        "🙁","😮","😯","😲","😳","🥺","😦","😧","😨","😰","😥","😢","😭","😱","😖","😣","😞","😓","😩","😫",
        "🥱","😤","😡","😠","🤬","👋","🤚","🖐","✋","🖖","👌","🤌","🤏","✌","🤞","🫰","🤟","🤘","🤙","👈",
        "👉","👆","🖕","👇","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✍","💅","🤳",
        "💪","🦵","🦶","👂","🦻","👃","🧠","🫀","🫁","🗣","👀","👁","👅","👄","❤","🧡","💛","💚","💙","💜",
        "🖤","🤍","🤎","💔","❣","💕","💞","💓","💗","💖","💘","💝","💟","☮","✝","☪","🕉","☸","✡","🔯",
        "🕎","☯","☦","🛐","⭐","🌟","✨","💫","⚡","🔥","💥","💦","💨","☀","🌤","⛅","🌥","☁","🌦","🌧","⛈",
        "🌩","🌨","☃","⛄","❄","🌊","💧","🫧","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑",
        "🥭","🍍","🥥","🥝","🍅","🍆","🥑","🥦","🥬","🥒","🌶","🫑","🌽","🥕","🫒","🧄","🧅","🥔","🍠","🫘",
        "🥐","🍞","🥖","🥨","🧀","🥚","🍳","🧈","🥞","🧇","🥓","🥩","🍗","🍖","🦴","🌭","🍔","🍟","🍕","🫓",
        "🥪","🥙","🧆","🌮","🌯","🫔","🥗","🥘","🫕","🥫","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🦪","🍤","🍙",
        "🍚","🍘","🍥","🥠","🥮","🫓","🍢","🍡","🍧","🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫","🍿",
        "🍩","🍪","🌰","🥜","🍯","🥛","🍼","🫖","☕","🍵","🧃","🥤","🧋","🍶","🍺","🍻","🥂","🍷","🫗","🥃",
        "🍸","🧊","🥄","🍴","🍽","🥣","🥡","🥢","🧂","🚗","🚕","🚙","🚌","🚎","🏎","🚓","🚑","🚒","🚐","🛻",
        "🚚","🚛","🚜","🏍","🛵","🛺","🚲","🛴","🛹","🛼","🚉","🚆","🚇","🚝","🚄","🚅","🚈","🚂","✈","🛩",
        "🛫","🛬","🚁","🚀","🛸","🚢","🛳","⛵","🛶","🚤","🛟","⚓","💈","🚏","🎠","🎡","🎢","🎪","🎭","🎨",
        "🎰","🚃","🚋","🚞","🚟","🚠","🚡","🏔","⛰","🌋","🗻","🏕","🏖","🏜","🏝","🏞","🏟","🏛","🏗","🛖",
        "🏘","🏚","🏠","🏡","🏢","🏣","🏤","🏥","🏦","🏨","🏩","🏪","🏫","🏬","🏭","🏯","🏰","💒","🗼","🗽",
        "⛪","🕌","🛕","🕍","🕋","⛩","🛤","🛣","🎠","🎡","🎢","🎪","🎭","🎨","🎰","🐶","🐱","🐭","🐹","🐰",
        "🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐒","🐔","🐧","🐦","🐤","🐣","🐥",
        "🦆","🦅","🦉","🦇","🐺","🐗","🐴","🦄","🐝","🪱","🐛","🦋","🐌","🐞","🐜","🪰","🪲","🪳","🦟","🦗",
        "🕷","🦂","🐢","🐍","🦎","🦖","🦕","🐙","🦑","🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈","🐊",
        "🐅","🐆","🦓","🦍","🦧","🐘","🦛","🦏","🐪","🐫","🦒","🦘","🦬","🐃","🐂","🐄","🐎","🐖","🐏","🐑",
        "🦙","🐐","🦌","🐕","🐩","🦮","🐕‍🦺","🐈","🐈‍⬛","🪶","🐓","🦃","🦤","🦚","🦜","🦢","🦩","🕊","🐇","🦝",
        "🦨","🦡","🦫","🦦","🦥","🐁","🐀","🐿","🦔","🐾","🐉","🐲","🌵","🎄","🌲","🌳","🌴","🪵","🌱","🌿",
        "☘","🍀","🎍","🪴","🎋","🍃","🍂","🍁","🍄","🐚","🪨","🌾","💐","🌷","🌹","🥀","🌺","🌸","🌼","🌻",
        "🌞","🌝","🌛","🌜","🌚","🌕","🌖","🌗","🌘","🌑","🌒","🌓","🌔","🌙","🌎","🌍","🌏","🪐","💫","⭐",
        "🌌","☄","⛱","🏳","🏴","🏁","🚩","🎌","🏴‍☠️","🇺🇳","🇺🇸","🇬🇧","🏴󠁧󠁢󠁥󠁮󠁧󠁿","🏴󠁧󠁢󠁳󠁣󠁴󠁿","🏴󠁧󠁢󠁷󠁬󠁳󠁿",
        "🎉","🎊","🎈","🎁","🎀","🪄","🪅","🪆","🎃","🎗","🎟","🎫","🎖","🏆","🏅","🥇","🥈","🥉","⚽","⚾",
        "🥎","🏀","🏐","🏈","🏉","🎾","🥏","🎳","🏏","🏑","🏒","🥍","🏓","🏸","🪃","🥅","⛳","🪁","🏹","🎣",
        "🤿","🥊","🥋","🎽","🛷","⛸","🥌","🎿","⛷","🏂","🪂","🏋","🤼","🤸","🤺","⛹","🤾","🏌","🏇","🧘",
        "🏄","🏊","🤽","🚣","🧗","🚵","🚴","🪂","🎪","🎭","🎨","🎬","🎤","🎧","🎼","🎹","🥁","🪘","🎷","🎺",
        "🪗","🎸","🪕","🎻","🎲","♟","🎯","🎳","🎮","🕹"
    ];

    // ── Timers ───────────────────────────────────────────────────────────────
    Timer {
        id: statusCheckTimer
        interval: 5000
        running:  !root.isConnected
        repeat:   true
        triggeredOnStart: true
        onTriggered: checkStatus()
    }
    Timer {
        id: qrRefreshTimer
        interval: 3000
        running: !root.isConnected && root.hasQrCode
        repeat: true
        onTriggered: root.qrSeq++
    }
    Timer {
        id: pollTimer
        interval: 20000
        running:  root.isConnected && root.activeChat === null
        repeat:   true
        triggeredOnStart: true
        onTriggered: fetchChats()
    }
    // Fallback retry when the long-poll loop errors (exponential backoff).
    Timer {
        id: messageWaitBackoff
        interval: PollUtils.nextMessagePollInterval(5000, 30000, root.pollStreak)
        running: false
        repeat: false
        onTriggered: {
            if (root.activeChat !== null) {
                fetchMessages(root.activeChat.id, true);
                messageWaitLoop();
            }
        }
    }
    // Debounced search: typing doesn't refilter on every keystroke.
    Timer {
        id: searchDebounceTimer
        interval: PollUtils.debounceDelay(150)
        running: false
        repeat: false
        onTriggered: filterChats()
    }

    FileDialog {
        id: fileDialog
        title: "Select an attachment"
        nameFilters: [
            "Images and Media (*.png *.jpg *.jpeg *.webp *.gif *.bmp *.mp4 *.mov *.avi)",
            "All Files (*)"
        ]
        onAccepted: {
            if (root.activeChat && selectedFile) {
                sendFile(root.activeChat.id, selectedFile.toString());
            }
        }
    }

    // ── Compact representation ────────────────────────────────────────────────
    compactRepresentation: Item {
        width:  plasmoid.formFactor === Plasmoid.Vertical ? parent.width : implicitWidth
        height: plasmoid.formFactor === Plasmoid.Horizontal ? parent.height : implicitHeight
        implicitWidth:  32
        implicitHeight: 32

        PlasmaComponents.ToolButton {
            anchors.fill: parent
            icon.name: "im-whatsapp"
            display: PlasmaComponents.ToolButton.IconOnly
            onClicked: root.expanded = !root.expanded
        }

        // Unread badge
        Rectangle {
            visible:  root.totalUnread > 0
            width:  18; height: 18; radius: 9
            color:  root.colGreen
            anchors { top: parent.top; right: parent.right; topMargin: -2; rightMargin: -2 }
            PlasmaComponents.Label {
                anchors.centerIn: parent
                text:  root.totalUnread > 99 ? "99+" : root.totalUnread
                font.pointSize: 6
                font.bold: true
                color: "#ffffff"
            }
        }
    }

    // ── Full representation ───────────────────────────────────────────────────
    fullRepresentation: Rectangle {
        width:  340
        height: 520
        color:  root.colBg
        clip:   true

        Connections {
            target: root
            function onMessageSent(success) {
                if (success) {
                    sentFeedback.show();
                } else {
                    failFeedback.show();
                }
            }
        }

        Rectangle {
            id: sentFeedback
            anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: 90 }
            width: 180; height: 34; radius: 6
            color: root.colAccent; visible: false; opacity: 0; z: 999
            function show() { visible = true; showAnim.start(); }
            SequentialAnimation {
                id: showAnim
                NumberAnimation { target: sentFeedback; property: "opacity"; to: 1; duration: 200 }
                PauseAnimation { duration: 2500 }
                NumberAnimation { target: sentFeedback; property: "opacity"; to: 0; duration: 300 }
                PropertyAction  { target: sentFeedback; property: "visible"; value: false }
            }
            RowLayout {
                anchors.centerIn: parent
                spacing: 6
                PlasmaComponents.Label { text: "✓"; color: "#ffffff"; font.bold: true; font.pointSize: 12 }
                PlasmaComponents.Label { text: "Message sent"; color: "#ffffff"; font.bold: true }
            }
        }

        Rectangle {
            id: failFeedback
            anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: 90 }
            width: 220; height: 34; radius: 6
            color: "#c0392b"; visible: false; opacity: 0; z: 999
            function show() { visible = true; failAnim.start(); }
            SequentialAnimation {
                id: failAnim
                NumberAnimation { target: failFeedback; property: "opacity"; to: 1; duration: 200 }
                PauseAnimation { duration: 2500 }
                NumberAnimation { target: failFeedback; property: "opacity"; to: 0; duration: 300 }
                PropertyAction  { target: failFeedback; property: "visible"; value: false }
            }
            PlasmaComponents.Label {
                anchors.centerIn: parent
                text: "✗  Failed to send message"
                color: "#ffffff"; font.bold: true
            }
        }

        StackLayout {
            anchors.fill: parent
            currentIndex: !root.isConnected ? 0 : (root.activeChat !== null ? 2 : 1)

            // ═══════════════════════════════════════════════════
            // PAGE 0 — Connection / Loading
            // ═══════════════════════════════════════════════════
            Item {
                ColumnLayout {
                    anchors.centerIn: parent
                    spacing: 18
                    width: parent.width * 0.8

                    // Animated logo ring
                    Item {
                        width: 80; height: 80
                        Layout.alignment: Qt.AlignHCenter

                        Rectangle {
                            anchors.fill: parent
                            radius: 40
                            color: root.colPanel
                            border.color: root.colAccent
                            border.width: 2

                            PlasmaComponents.Label {
                                anchors.centerIn: parent
                                text: "💬"
                                font.pointSize: 32
                            }
                        }

                        // Spinner ring
                        Rectangle {
                            id: spinnerRing
                            anchors.fill: parent
                            anchors.margins: -4
                            radius: 44
                            color: "transparent"
                            border.color: root.colAccent
                            border.width: 3
                            opacity: 0.5

                            RotationAnimation on rotation {
                                from: 0; to: 360
                                duration: 2000
                                loops: Animation.Infinite
                                running: !root.isConnected
                            }
                        }
                    }

                    PlasmaComponents.Label {
                        text: "WhatsApp Quick"
                        font.bold: true
                        font.pointSize: 16
                        color: root.colText
                        Layout.alignment: Qt.AlignHCenter
                    }

                    Rectangle {
                        visible: root.hasQrCode
                        width: 200; height: 200; radius: 12
                        color: "white"
                        Layout.alignment: Qt.AlignHCenter
                        Image {
                            anchors.fill: parent
                            anchors.margins: 12
                            fillMode: Image.PreserveAspectFit
                            cache: false
                            visible: root.hasQrCode
                            source: apiHost + "/api/qr?key=" + apiKey + "&t=" + root.qrSeq
                        }
                    }

                    PlasmaComponents.Label {
                        visible: !root.hasQrCode && !root.isConnected
                        text: "Waiting for QR code…"
                        font.pointSize: 9
                        color: root.colSub
                        Layout.alignment: Qt.AlignHCenter
                    }

                    PlasmaComponents.Label {
                        text: root.statusMessage
                        horizontalAlignment: Text.AlignHCenter
                        wrapMode: Text.Wrap
                        font.pointSize: 9
                        color: root.colSub
                        Layout.fillWidth: true
                        Layout.alignment: Qt.AlignHCenter
                    }

                    RowLayout {
                        Layout.alignment: Qt.AlignHCenter
                        spacing: 10

                        PlasmaComponents.Button {
                            text: "Retry"
                            Layout.preferredWidth: 100
                            onClicked: checkStatus()

                            background: Rectangle {
                                color: parent.hovered ? root.colAccentDim : root.colAccent
                                radius: 6
                                Behavior on color { ColorAnimation { duration: 150 } }
                            }
                            contentItem: PlasmaComponents.Label {
                                text: parent.text
                                color: "#ffffff"
                                horizontalAlignment: Text.AlignHCenter
                                font.bold: true
                            }
                        }

                        PlasmaComponents.Button {
                            text: "Restart Server"
                            Layout.preferredWidth: 120
                            onClicked: restartBackend()

                            background: Rectangle {
                                color: parent.hovered ? root.colAccentDim : root.colPanel
                                border.color: root.colBorder
                                border.width: 1
                                radius: 6
                                Behavior on color { ColorAnimation { duration: 150 } }
                            }
                            contentItem: PlasmaComponents.Label {
                                text: parent.text
                                color: root.colText
                                horizontalAlignment: Text.AlignHCenter
                                font.bold: true
                            }
                        }
                    }
                }
            }

            // ═══════════════════════════════════════════════════
            // PAGE 1 — Chat List
            // ═══════════════════════════════════════════════════
            ColumnLayout {
                spacing: 0

                // ── Header bar ─────────────────────────────────
                Rectangle {
                    Layout.fillWidth: true
                    height: 56
                    color: root.colHeader

                    RowLayout {
                        anchors { fill: parent; leftMargin: 14; rightMargin: 10; topMargin: 8; bottomMargin: 8 }
                        spacing: 10

                        // WA logo
                        Rectangle {
                            width: 36; height: 36; radius: 18
                            color: root.colAccent

                            PlasmaComponents.Label {
                                anchors.centerIn: parent
                                text: "💬"
                                font.pointSize: 16
                            }
                        }

                        PlasmaComponents.Label {
                            text: "WhatsApp Quick"
                            font.bold: true
                            font.pointSize: 13
                            color: root.colText
                            Layout.fillWidth: true
                        }

                        // Loading spinner (small)
                        Rectangle {
                            visible: root.isLoading
                            width: 20; height: 20; radius: 10
                            color: "transparent"
                            border.color: root.colAccent
                            border.width: 2
                            RotationAnimation on rotation {
                                from: 0; to: 360; duration: 1000
                                loops: Animation.Infinite; running: root.isLoading
                            }
                        }

                        PlasmaComponents.ToolButton {
                            icon.name: "view-refresh"
                            display: PlasmaComponents.ToolButton.IconOnly
                            ToolTip.text: "Refresh chats"
                            ToolTip.visible: hovered
                            onClicked: fetchChats()
                        }

                        PlasmaComponents.ToolButton {
                            icon.name: "system-reboot"
                            display: PlasmaComponents.ToolButton.IconOnly
                            ToolTip.text: "Restart WhatsApp Connection"
                            ToolTip.visible: hovered
                            onClicked: restartBackend()
                        }
                    }
                }

                // ── Search box ─────────────────────────────────
                Rectangle {
                    Layout.fillWidth: true
                    height: 44
                    color: root.colPanel

                    RowLayout {
                        anchors { fill: parent; leftMargin: 10; rightMargin: 10 }
                        spacing: 6

                        PlasmaComponents.Label { text: "🔍"; font.pointSize: 11 }

                        PlasmaComponents.TextField {
                            id: searchBar
                            placeholderText: "Search name or number…"
                            Layout.fillWidth: true
                            color: root.colText
                            background: Item {}
                            onTextChanged: { root.searchQuery = text; searchDebounceTimer.restart(); }
                        }

                        PlasmaComponents.ToolButton {
                            icon.name: "edit-clear"
                            visible: searchBar.text.length > 0
                            display: PlasmaComponents.ToolButton.IconOnly
                            onClicked: { searchBar.text = ""; root.searchQuery = ""; filterChats(); }
                        }
                    }
                }

                // ── Separator ──────────────────────────────────
                Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder }

                // ── Chat list ──────────────────────────────────
                PlasmaComponents.ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    ListView {
                        id: chatListView
                        width: parent.width
                        model: root.filteredChats.slice(0, root.chatsShown)
                        spacing: 0
                        reuseItems: true

                        // Infinite scroll: grow the window when the user hits
                        // the bottom of the rendered chats.
                        onAtYEndChanged: {
                            if (atYEnd && root.filteredChats.length > root.chatsShown) {
                                root.chatsShown += 20;
                            }
                        }

                        // Empty state
                        PlasmaComponents.Label {
                            anchors.centerIn: parent
                            visible: root.filteredChats.length === 0 && !root.isLoading
                            text: root.searchQuery ? "No results for \"" + root.searchQuery + "\"" : "No chats found"
                            color: root.colSub
                            font.pointSize: 10
                        }

                        delegate: Rectangle {
                            id: chatRow
                            width: chatListView.width
                            height: 68
                            color: hovered ? root.colPanel : "transparent"

                            property bool hovered: false
                            MouseArea {
                                anchors.fill: parent
                                hoverEnabled: true
                                acceptedButtons: Qt.LeftButton | Qt.RightButton
                                onEntered: chatRow.hovered = true
                                onExited:  chatRow.hovered = false
                                onClicked: function(mouse) {
                                    if (mouse.button === Qt.RightButton) {
                                        root.contextChat = modelData;
                                        chatContextMenu.popup(chatRow, mouse.x, mouse.y);
                                    } else {
                                        root.activeChat = {
                                            id:      modelData.id,
                                            name:    modelData.name || modelData.formattedTitle || "Unknown",
                                            isGroup: modelData.isGroup || false
                                        };
                                    }
                                }
                            }

                            Behavior on color { ColorAnimation { duration: 120 } }

                            RowLayout {
                                anchors { fill: parent; leftMargin: 14; rightMargin: 14 }
                                spacing: 12

                                // Avatar (profile picture with colored-initials fallback)
                                Rectangle {
                                    width: 44; height: 44; radius: 22
                                    color: root.avatarColor(modelData.name || modelData.formattedTitle || "")

                                    PlasmaComponents.Label {
                                        anchors.centerIn: parent
                                        text: modelData.isGroup ? "👥" : root.chatInitial(modelData)
                                        font.bold: !modelData.isGroup
                                        font.pointSize: modelData.isGroup ? 20 : 16
                                        color: "#ffffff"
                                    }

                                    // Circular mask for the photo (white = visible).
                                    Rectangle {
                                        id: avatarMaskShape
                                        width: 44; height: 44; radius: 22
                                        visible: false
                                        color: "#ffffff"
                                    }

                                    // Avatar photo on top when available.
                                    Image {
                                        anchors.fill: parent
                                        source: root.avatarSource(modelData.id)
                                        sourceSize.width: 88
                                        sourceSize.height: 88
                                        asynchronous: true
                                        fillMode: Image.PreserveAspectCrop
                                        visible: source !== ""
                                        layer.enabled: source !== ""
                                        layer.smooth: true
                                        layer.effect: MultiEffect {
                                            maskEnabled: true
                                            maskSource: avatarMaskShape
                                        }
                                    }

                                    // Online indicator (if available)
                                    Rectangle {
                                        visible: !modelData.isGroup && (modelData.isOnline || false)
                                        width: 12; height: 12; radius: 6
                                        color: root.colGreen
                                        border.color: root.colBg
                                        border.width: 2
                                        anchors { bottom: parent.bottom; right: parent.right }
                                    }
                                }

                                // Text block
                                ColumnLayout {
                                    Layout.fillWidth: true
                                    spacing: 2

                                    RowLayout {
                                        Layout.fillWidth: true
                                        spacing: 4

                                        PlasmaComponents.Label {
                                            visible: root.isChatPinned(modelData)
                                            text: "📌"
                                            font.pointSize: 8
                                        }

                                        PlasmaComponents.Label {
                                            text: modelData.name || modelData.formattedTitle || "Unknown"
                                            font.bold: true
                                            font.pointSize: 10
                                            color: root.colText
                                            elide: Text.ElideRight
                                            Layout.fillWidth: true
                                        }

                                        PlasmaComponents.Label {
                                            text: root.formatTime(modelData.t || (modelData.lastMessage && modelData.lastMessage.t) || 0)
                                            font.pointSize: 8
                                            color: (modelData.unreadCount || 0) > 0 ? root.colGreen : root.colSub
                                        }
                                    }

                                    RowLayout {
                                        Layout.fillWidth: true
                                        spacing: 4

                                        PlasmaComponents.Label {
                                            text: root.lastPreview(modelData)
                                            font.pointSize: 8.5
                                            color: root.colSub
                                            elide: Text.ElideRight
                                            maximumLineCount: 1
                                            wrapMode: Text.NoWrap
                                            Layout.fillWidth: true
                                        }

                                        // Unread badge
                                        Rectangle {
                                            visible: (modelData.unreadCount || 0) > 0
                                            width:  Math.max(20, unreadLabel.implicitWidth + 8)
                                            height: 20
                                            radius: 10
                                            color:  root.colGreen

                                            PlasmaComponents.Label {
                                                id: unreadLabel
                                                anchors.centerIn: parent
                                                text: (modelData.unreadCount || 0) > 99 ? "99+" : (modelData.unreadCount || "")
                                                font.pointSize: 7
                                                font.bold: true
                                                color: "#ffffff"
                                            }
                                        }
                                    }
                                }
                            }

                            // Bottom divider
                            Rectangle {
                                anchors { bottom: parent.bottom; left: parent.left; right: parent.right; leftMargin: 70 }
                                height: 1
                                color: root.colBorder
                                opacity: 0.5
                            }
                        }
                    }
                }
            }

            // ═══════════════════════════════════════════════════
            // PAGE 2 — Compose Message
            // ═══════════════════════════════════════════════════
            ColumnLayout {
                spacing: 0

                // ── Compose header ─────────────────────────────
                Rectangle {
                    Layout.fillWidth: true
                    height: 60
                    color: root.colHeader

                    RowLayout {
                        anchors { fill: parent; leftMargin: 6; rightMargin: 14 }
                        spacing: 8

                        PlasmaComponents.ToolButton {
                            icon.name: "go-previous"
                            display: PlasmaComponents.ToolButton.IconOnly
                            ToolTip.text: "Back to chats"
                            ToolTip.visible: hovered
                            onClicked: root.activeChat = null
                        }

                        // Recipient avatar (photo with initials fallback)
                        Rectangle {
                            width: 38; height: 38; radius: 19
                            color: root.activeChat ? root.avatarColor(root.activeChat.name) : root.colAccent

                            PlasmaComponents.Label {
                                anchors.centerIn: parent
                                text: root.activeChat ? (root.activeChat.isGroup ? "👥" : root.activeChat.name.charAt(0).toUpperCase()) : "?"
                                font.bold: !root.activeChat || !root.activeChat.isGroup
                                font.pointSize: root.activeChat && root.activeChat.isGroup ? 18 : 14
                                color: "#ffffff"
                            }

                            Rectangle {
                                id: headerAvatarMask
                                width: 38; height: 38; radius: 19
                                visible: false
                                color: "#ffffff"
                            }

                            Image {
                                anchors.fill: parent
                                source: root.activeChat ? root.avatarSource(root.activeChat.id) : ""
                                sourceSize.width: 76
                                sourceSize.height: 76
                                asynchronous: true
                                fillMode: Image.PreserveAspectCrop
                                visible: source !== ""
                                layer.enabled: source !== ""
                                layer.smooth: true
                                layer.effect: MultiEffect {
                                    maskEnabled: true
                                    maskSource: headerAvatarMask
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1

                            PlasmaComponents.Label {
                                text: root.activeChat ? root.activeChat.name : ""
                                font.bold: true
                                font.pointSize: 11
                                color: root.colText
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
                            // "Updating…" cue while a revalidate/poll is in
                            // flight over an already-rendered list (MRU cache
                            // hits must visibly refresh, never sit stale).
                            PlasmaComponents.Label {
                                visible: root.messagesInFlight && root.activeChatMessages.length > 0
                                text: "Updating…"
                                font.pointSize: 7.5
                                color: root.colSub
                            }
                            // Subtitle (JID/phone number) intentionally hidden —
                            // the raw WhatsApp ID under the name was visual noise.
                        }
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder }

                // ── Message History ────────────────────────────
                PlasmaComponents.ScrollView {
                    id: messageScroll
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true

                    ListView {
                        id: messageListView
                        model: root.activeChatMessages
                        spacing: 4
                        clip: true
                        // NOTE: deliberately NO reuseItems here. This delegate's
                        // height comes from chained implicitHeight bindings
                        // (bubble → wrapping Text → anchored layouts), and the
                        // model is a JS array that is replaced on every merge.
                        // Item recycling keeps stale sizes/bindings and renders
                        // overlapping, overflowing bubbles.

                        // Always land on the most recent message — but only
                        // when the user is already at (or near) the bottom, so
                        // background updates don't yank the scroll position.
                        onCountChanged: {
                            if (count > 0 && messageListView.atYEnd) Qt.callLater(messageListView.positionViewAtEnd);
                        }
                        onWidthChanged: if (count > 0) Qt.callLater(messageListView.positionViewAtEnd);

                        // Top-edge lazy loading: fetch 20 older messages when
                        // the user scrolls to the very top.
                        onAtYBeginningChanged: {
                            if (atYBeginning && root.msgsHasMore && !root.msgsLoadingOlder &&
                                root.msgsTopError === "" && contentY < 200 &&
                                root.activeChatMessages.length > 0) {
                                root.fetchOlderMessages();
                            }
                        }

                        header: Item {
                            width: messageListView.width
                            height: (root.msgsLoadingOlder || root.msgsTopError !== "") ? 36 : 0
                            visible: height > 0

                            PlasmaComponents.Label {
                                anchors.centerIn: parent
                                visible: root.msgsLoadingOlder
                                text: "Loading older messages…"
                                color: root.colSub
                                font.pointSize: 8
                            }

                            RowLayout {
                                anchors.centerIn: parent
                                spacing: 8
                                visible: root.msgsTopError !== ""

                                PlasmaComponents.Label {
                                    text: root.msgsTopError
                                    color: root.colSub
                                    font.pointSize: 8
                                }

                                PlasmaComponents.Label {
                                    text: "↻ Retry"
                                    color: root.colAccent
                                    font.pointSize: 8.5

                                    MouseArea {
                                        anchors.fill: parent
                                        onClicked: root.fetchOlderMessages()
                                    }
                                }
                            }
                        }

                        // Placeholder if loading messages
                        PlasmaComponents.Label {
                            anchors.centerIn: parent
                            visible: root.isLoadingMessages && root.activeChatMessages.length === 0
                            text: "Loading messages…"
                            color: root.colSub
                            font.pointSize: 10
                        }

                        // Placeholder if no messages
                        PlasmaComponents.Label {
                            anchors.centerIn: parent
                            visible: !root.isLoadingMessages && root.activeChatMessages.length === 0
                            text: "No messages in this chat"
                            color: root.colSub
                            font.pointSize: 10
                        }

                        delegate: Item {
                            id: msgDelegateRoot
                            width: messageListView.width
                            // Use the column's full implicit height + padding for
                            // the reaction button that overflows below the bubble.
                            height: msgBubbleCol.implicitHeight + 16

                            // Right-click a message -> context menu (Reply / Copy message)
                            MouseArea {
                                anchors.fill: parent
                                acceptedButtons: Qt.RightButton
                                onClicked: function(mouse) {
                                    root.contextReplyMsg = modelData;
                                    msgContextMenu.popup(msgDelegateRoot, mouse.x, mouse.y);
                                }
                            }

                            ColumnLayout {
                                id: msgBubbleCol
                                anchors { left: parent.left; right: parent.right }
                                spacing: 0

                                RowLayout {
                                    spacing: 8
                                    layoutDirection: modelData.fromMe ? Qt.RightToLeft : Qt.LeftToRight

                                    Item { width: 6 }

                                    Rectangle {
                                        id: msgBubble
                                        width: {
                                            var w = msgTime.implicitWidth + 30;
                                            if (msgText.visible) {
                                                w = Math.max(w, msgText.implicitWidth + 20);
                                            } else if (msgImage.visible) {
                                                w = Math.max(w, Math.min(messageListView.width * 0.7, 240));
                                            }
                                            return Math.min(messageListView.width * 0.75, w);
                                        }
                                        implicitHeight: msgCol.implicitHeight + 12
                                        Layout.preferredHeight: implicitHeight
                                        radius: 8
                                        color: modelData.fromMe ? "#005c4b" : root.colPanel
                                        border.color: root.colBorder
                                        border.width: 1

                                        ColumnLayout {
                                            id: msgCol
                                            anchors { fill: parent; margins: 8; topMargin: 6; bottomMargin: 6 }
                                            spacing: 3

                                            // Sender name (for groups)
                                            PlasmaComponents.Label {
                                                visible: root.activeChat && root.activeChat.isGroup && !modelData.fromMe && modelData.senderName
                                                text: modelData.senderName || ""
                                                font.pointSize: 7.5
                                                font.bold: true
                                                color: root.colGreen
                                                Layout.fillWidth: true
                                                elide: Text.ElideRight
                                            }

                                            // Quoted message preview (reply context)
                                            Rectangle {
                                                visible: !!(modelData.quotedMsg && modelData.quotedMsg.body)
                                                Layout.fillWidth: true
                                                Layout.preferredHeight: quotedCol.implicitHeight + 10
                                                radius: 4
                                                color: modelData.fromMe ? "#0a4639" : "#1a2930"
                                                clip: true

                                                // Green left accent bar
                                                Rectangle {
                                                    width: 3
                                                    anchors { top: parent.top; bottom: parent.bottom; left: parent.left; leftMargin: 0 }
                                                    radius: 1.5
                                                    color: root.colAccent
                                                }

                                                ColumnLayout {
                                                    id: quotedCol
                                                    anchors { fill: parent; leftMargin: 8; rightMargin: 6; topMargin: 5; bottomMargin: 5 }
                                                    spacing: 1

                                                    PlasmaComponents.Label {
                                                        visible: !!(modelData.quotedMsg && modelData.quotedMsg.senderName)
                                                        text: (modelData.quotedMsg && modelData.quotedMsg.senderName) || ""
                                                        font.pointSize: 7
                                                        font.bold: true
                                                        color: root.colAccent
                                                        elide: Text.ElideRight
                                                        Layout.fillWidth: true
                                                    }

                                                    PlasmaComponents.Label {
                                                        text: {
                                                            if (!modelData.quotedMsg) return "";
                                                            var qType = modelData.quotedMsg.type || "chat";
                                                            if (qType === "image") return "📷 Photo";
                                                            if (qType === "video") return "🎥 Video";
                                                            if (qType === "audio") return "🎵 Audio";
                                                            if (qType === "sticker") return "🪄 Sticker";
                                                            if (qType === "document") return "📄 Document";
                                                            var b = modelData.quotedMsg.body || "";
                                                            return b.length > 80 ? b.substring(0, 80) + "…" : b;
                                                        }
                                                        font.pointSize: 7.5
                                                        color: root.colSub
                                                        elide: Text.ElideRight
                                                        wrapMode: Text.NoWrap
                                                        Layout.fillWidth: true
                                                        maximumLineCount: 1
                                                    }
                                                }
                                            }

                                            // Message text - with emoji font support
                                            Text {
                                                id: msgText
                                                visible: !(modelData.type === "image" || modelData.type === "sticker" || modelData.type === "video" || (modelData.body && (modelData.body.startsWith("/9j/") || modelData.body.startsWith("data:image") || modelData.body.startsWith("iVBORw0KGgo"))))
                                                text: modelData.body || ""
                                                color: root.colText
                                                font.pointSize: 9.5
                                                font.family: root.emojiFont
                                                wrapMode: Text.Wrap
                                                Layout.fillWidth: true
                                                renderType: Text.QtRendering
                                            }

                                            Image {
                                                id: msgImage
                                                visible: (!modelData._thumb || modelData.thumbUrl) && (modelData.type === "image" || modelData.type === "sticker" || modelData.type === "video" || modelData.thumbUrl || (modelData.body && (modelData.body.startsWith("/9j/") || modelData.body.startsWith("data:image") || modelData.body.startsWith("iVBORw0KGgo"))))
                                                source: {
                                                    if (!visible) return "";
                                                    var s = MsgUtils.mediaSource(modelData);
                                                    if (s !== "") return s;
                                                    return modelData.thumbUrl || "";
                                                }
                                                fillMode: Image.PreserveAspectFit
                                                Layout.maximumWidth: messageListView.width * 0.7
                                                Layout.preferredWidth: Math.min(messageListView.width * 0.7, 240)
                                                Layout.preferredHeight: Math.min(messageListView.width * 0.7, 180)
                                                asynchronous: true

                                                // Lazy 480p thumb: fetch once when the
                                                // delegate becomes visible.
                                                onVisibleChanged: {
                                                    if (visible) root.requestThumb(modelData);
                                                }
                                                Component.onCompleted: {
                                                    if (visible) root.requestThumb(modelData);
                                                }

                                                // Tap to open the fullscreen viewer.
                                                MouseArea {
                                                    anchors.fill: parent
                                                    onClicked: {
                                                        var list = MsgUtils.buildMediaList(root.activeChatMessages);
                                                        var idx = -1;
                                                        for (var i = 0; i < list.length; i++) {
                                                            if (list[i].id === modelData.id) { idx = i; break; }
                                                        }
                                                        root.openMediaViewer(idx);
                                                    }
                                                }
                                            }

                                            // MRU cached-copy placeholder for large
                                            // media (thumbnailized); the full body
                                            // returns after revalidation.
                                            PlasmaComponents.Label {
                                                visible: !!modelData._thumb && !modelData.thumbUrl
                                                text: MsgUtils.mediaLabel(modelData.type) || "📷 Media"
                                                font.pointSize: 9
                                                color: root.colSub
                                                Layout.maximumWidth: messageListView.width * 0.7
                                            }

                                            PlasmaComponents.Label {
                                                id: msgTime
                                                text: root.formatTime(modelData.t)
                                                font.pointSize: 7
                                                color: root.colSub
                                                Layout.alignment: Qt.AlignRight
                                            }
                                        }

                                        // Reaction button (small emoji icon at bottom-right)
                                        Rectangle {
                                            id: reactionButton
                                            anchors { bottom: parent.bottom; right: parent.right; bottomMargin: -8; rightMargin: -4 }
                                            width: 22; height: 22; radius: 11
                                            color: root.colSurface
                                            border.color: root.colBorder
                                            border.width: 1
                                            z: 10

                                            Text {
                                                anchors.centerIn: parent
                                                text: "😊"
                                                font.pointSize: 10
                                                font.family: root.emojiFont
                                                renderType: Text.QtRendering
                                            }

                                            MouseArea {
                                                anchors.fill: parent
                                                onClicked: {
                                                    root.activeReactionMsgId = modelData.id || "";
                                                    root.emojiPickerVisible = true;
                                                }
                                            }

                                            // Only show when the message delegate list is interactive
                                            // (hides when the emoji picker is open over it)
                                            visible: !root.emojiPickerVisible
                                        }
                                    }

                                    Item {
                                        Layout.fillWidth: true
                                    }

                                    Item { width: 6 }
                                }

                                // ── Reactions display row ─────────────────────────────
                                RowLayout {
                                    id: reactionsRow
                                    property string parentMsgId: modelData.id || ""
                                    Layout.leftMargin: modelData.fromMe ? 50 : 14
                                    Layout.rightMargin: modelData.fromMe ? 14 : 50
                                    spacing: 4
                                    visible: modelData.reactions && modelData.reactions.length > 0

                                    Repeater {
                                        model: MsgUtils.aggregateReactions(modelData.reactions)
                                        Rectangle {
                                            id: reactChip
                                            height: 22
                                            width: reactContentRow.implicitWidth + 12
                                            radius: 11
                                            color: modelData.fromMe ? root.colAccentDim : (chipMouse.containsMouse ? root.colBorder : root.colPanel)
                                            border.color: modelData.fromMe ? root.colAccent : root.colBorder
                                            border.width: 1

                                            Behavior on color { ColorAnimation { duration: 100 } }

                                            RowLayout {
                                                id: reactContentRow
                                                anchors.centerIn: parent
                                                spacing: 3

                                                Text {
                                                    text: modelData.emoji || ""
                                                    font.pointSize: 10
                                                    font.family: root.emojiFont
                                                    renderType: Text.QtRendering
                                                }

                                                PlasmaComponents.Label {
                                                    visible: modelData.count > 1
                                                    text: modelData.count
                                                    font.pointSize: 7.5
                                                    font.bold: true
                                                    color: root.colText
                                                }
                                            }

                                            PlasmaComponents.ToolTip.visible: chipMouse.containsMouse && modelData.senders && modelData.senders.length > 0
                                            PlasmaComponents.ToolTip.text: modelData.senders ? modelData.senders.join(", ") : ""

                                            MouseArea {
                                                id: chipMouse
                                                anchors.fill: parent
                                                hoverEnabled: true
                                                onClicked: {
                                                    if (root.activeChat && reactionsRow.parentMsgId) {
                                                        root.sendReaction(root.activeChat.id, reactionsRow.parentMsgId, modelData.emoji, modelData.fromMe);
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    Item { Layout.fillWidth: true }
                                }
                            }
                        }
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder }

                // ── Quick-reply chips ──────────────────────────
                Rectangle {
                    Layout.fillWidth: true
                    height: 42
                    color: root.colSurface

                    RowLayout {
                        anchors { fill: parent; leftMargin: 10; rightMargin: 10 }
                        spacing: 6

                        Repeater {
                            model: ["👍 OK", "😊 Thanks", "On my way!", "Running late", "Call me?"]

                            Rectangle {
                                height: 26
                                width: chipLabel.implicitWidth + 16
                                radius: 13
                                color: chipMouse.containsMouse ? root.colAccentDim : root.colPanel
                                border.color: root.colBorder
                                border.width: 1

                                Behavior on color { ColorAnimation { duration: 120 } }

                                PlasmaComponents.Label {
                                    id: chipLabel
                                    anchors.centerIn: parent
                                    text: modelData
                                    font.pointSize: 8
                                    color: root.colText
                                }

                                MouseArea {
                                    id: chipMouse
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: {
                                        var snippet = modelData.replace(/^[^\s]+\s/, ""); // strip emoji prefix
                                        if (modelData.charAt(0) === "👍" || modelData.charAt(0) === "😊")
                                            messageInput.text += modelData.split(" ")[0] + " ";
                                        else
                                            messageInput.text += modelData + " ";
                                        messageInput.forceActiveFocus();
                                    }
                                }
                            }
                        }
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder }

                // ── Message Input area ─────────────────────────
                Rectangle {
                    Layout.fillWidth: true
                    height: (root.pendingReplyId !== "" || root.pendingAttachmentPath !== "") ? 92 : 70
                    color: root.colHeader


                    ColumnLayout {
                        anchors { fill: parent; leftMargin: 10; rightMargin: 10; topMargin: 8; bottomMargin: 8 }
                        spacing: 4

                        // ── "Replying to…" quote bar ──────────────────────────
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            visible: root.pendingReplyId !== ""

                            Rectangle {
                                width: 3; height: 30; radius: 1.5
                                color: root.colAccent
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 0

                                PlasmaComponents.Label {
                                    text: "Replying to"
                                    font.pointSize: 7
                                    font.bold: true
                                    color: root.colAccent
                                }
                                PlasmaComponents.Label {
                                    text: root.replyPreviewLabel
                                    font.pointSize: 8
                                    color: root.colSub
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                            }

                            PlasmaComponents.ToolButton {
                                Layout.preferredWidth: 24
                                Layout.preferredHeight: 24
                                text: "✕"
                                ToolTip.text: "Cancel reply"
                                ToolTip.visible: hovered
                                onClicked: root.clearPendingReply()
                            }
                        }

                        // ── Pasted-image draft chip (not sent until send is pressed) ──
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            visible: root.pendingAttachmentPath !== ""

                            Rectangle {
                                width: 3; height: 26; radius: 1.5
                                color: root.colAccent
                            }

                            PlasmaComponents.Label {
                                Layout.fillWidth: true
                                text: "📷 Image attached — press send to deliver"
                                font.pointSize: 8
                                color: root.colText
                                elide: Text.ElideRight
                            }

                            PlasmaComponents.ToolButton {
                                Layout.preferredWidth: 24
                                Layout.preferredHeight: 24
                                text: "✕"
                                ToolTip.text: "Remove attachment"
                                ToolTip.visible: hovered
                                onClicked: root.clearPendingAttachment()
                            }
                        }

                        RowLayout {
                            spacing: 8
                            Layout.fillWidth: true

                            // Emoji button
                            PlasmaComponents.ToolButton {
                                id: emojiButton
                                width: 36; height: 36
                                icon.name: "face-smile"
                                display: PlasmaComponents.ToolButton.IconOnly
                                ToolTip.text: "Emojis"
                                ToolTip.visible: hovered
                                onClicked: {
                                    if (root.emojiPickerVisible && root.activeReactionMsgId === "") {
                                        root.emojiPickerVisible = false;
                                    } else {
                                        root.activeReactionMsgId = "";
                                        root.emojiPickerVisible = true;
                                    }
                                }
                            }

                            // Attach button
                            PlasmaComponents.ToolButton {
                                id: attachButton
                                width: 36; height: 36
                                icon.name: "mail-attachment"
                                display: PlasmaComponents.ToolButton.IconOnly
                                ToolTip.text: "Send file"
                                ToolTip.visible: hovered
                                onClicked: fileDialog.open()
                            }

                            // Input text box
                            Rectangle {
                                Layout.fillWidth: true
                                height: 36
                                color: root.colPanel
                                border.color: messageInput.activeFocus ? root.colAccent : root.colBorder
                                border.width: messageInput.activeFocus ? 1.5 : 1
                                radius: 18

                                RowLayout {
                                    anchors.fill: parent
                                    anchors.leftMargin: 12
                                    anchors.rightMargin: 12
                                    spacing: 6

                                    Flickable {
                                        id: flick
                                        Layout.fillWidth: true
                                        Layout.fillHeight: true
                                        clip: true
                                        contentWidth: width
                                        contentHeight: messageInput.implicitHeight
                                        flickableDirection: Flickable.VerticalFlick
                                        boundsBehavior: Flickable.StopAtBounds

                                        // Helper: keep the cursor rectangle visible
                                        function ensureCursorVisible() {
                                            var r = messageInput.cursorRectangle;
                                            // Vertical
                                            if (r.y < flick.contentY)
                                                flick.contentY = r.y;
                                            else if (r.y + r.height > flick.contentY + flick.height)
                                                flick.contentY = r.y + r.height - flick.height;
                                        }

                                        TextEdit {
                                            id: messageInput
                                            Component.onCompleted: root.messageInputRef = messageInput
                                            width: flick.width
                                            wrapMode: TextEdit.Wrap
                                            color: root.colText
                                            font.pointSize: 9.5
                                            font.family: root.emojiFont
                                            selectionColor: root.colAccent
                                            focus: true

                                            // Auto-scroll the Flickable whenever the cursor moves
                                            onCursorRectangleChanged: flick.ensureCursorVisible()

                                            Text {
                                                anchors.fill: parent
                                                text: "Type a message…"
                                                color: root.colSub
                                                font: parent.font
                                                visible: parent.text.length === 0
                                            }

                                            Keys.onReturnPressed: function(event) {
                                                event.accepted = true;
                                                if (event.modifiers & Qt.ShiftModifier) {
                                                    messageInput.insert(messageInput.cursorPosition, "\n");
                                                } else {
                                                    sendComposed();
                                                }
                                            }


                                            Keys.onPressed: function(event) {
                                                if (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)) {
                                                    if (event.modifiers & Qt.ShiftModifier) {
                                                        event.accepted = true;
                                                        pasteImageFromClipboard();
                                                    } else {
                                                        var hadSelection = messageInput.selectedText.length > 0;
                                                        var oldLen = messageInput.text.length;
                                                        messageInput.paste();
                                                        if (!hadSelection && messageInput.text.length === oldLen) {
                                                            // No text was inserted by Qt paste, check if clipboard contains an image
                                                            pasteImageFromClipboard();
                                                        }
                                                        event.accepted = true;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            // Send button (always visible, dimmed when no text)
                            Rectangle {
                                width: 36; height: 36
                                radius: 18
                                color: {
                                    if (sendMouseArea.containsMouse && (messageInput.text.trim().length > 0 || root.pendingAttachmentPath !== "") && !root.sendInFlight) return root.colAccentDim;
                                    return root.colAccent;
                                }
                                opacity: ((messageInput.text.trim().length === 0 && root.pendingAttachmentPath === "") || root.sendInFlight) ? 0.5 : 1.0

                                Behavior on color { ColorAnimation { duration: 150 } }

                                PlasmaComponents.Label {
                                    anchors.centerIn: parent
                                    text: root.sendInFlight ? "⏳" : "➤"
                                    color: "#ffffff"
                                    font.pointSize: 12
                                }

                                MouseArea {
                                    id: sendMouseArea
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: {
                                        sendComposed();
                                    }
                                }
                            }
                        }

                        // Hint text
                        PlasmaComponents.Label {
                            text: "Shift+Enter for new line"
                            font.pointSize: 7
                            color: root.colSub
                            Layout.alignment: Qt.AlignHCenter
                        }
                    }
                }
            }
        }

        // ── Emoji Picker Overlay ─────────────────────────────────────────────
        Rectangle {
            visible: root.emojiPickerVisible
            anchors.fill: parent
            color: "#00000000"

            // Tap outside to dismiss
            MouseArea {
                anchors.fill: parent
                onClicked: {
                    root.emojiPickerVisible = false;
                    root.activeReactionMsgId = "";
                }
            }

            Rectangle {
                anchors { bottom: parent.bottom; left: parent.left; right: parent.right }
                height: 200
                color: root.colPanel
                border.color: root.colBorder
                border.width: 1

                ColumnLayout {
                    anchors.fill: parent
                    spacing: 0

                    // Quick reaction row
                    Rectangle {
                        Layout.fillWidth: true
                        height: 50
                        color: root.colHeader

                        RowLayout {
                            anchors.centerIn: parent
                            spacing: 8

                            Repeater {
                                model: ["👍", "❤️", "😂", "😮", "😢", "🙏"]
                                Rectangle {
                                    width: 36; height: 36; radius: 18
                                    color: emojiHover.containsMouse ? root.colAccentDim : root.colSurface
                                    border.color: root.colBorder
                                    border.width: 1

                                    Behavior on color { ColorAnimation { duration: 100 } }

                                    Text {
                                        anchors.centerIn: parent
                                        text: modelData
                                        font.pointSize: 18
                                        font.family: root.emojiFont
                                        renderType: Text.QtRendering
                                    }

                                    MouseArea {
                                        id: emojiHover
                                        anchors.fill: parent
                                        hoverEnabled: true
                                        onClicked: {
                                            if (root.activeReactionMsgId && root.activeChat) {
                                                root.sendReaction(root.activeChat.id, root.activeReactionMsgId, modelData);
                                            } else if (!root.activeReactionMsgId) {
                                                // Insert mode - add emoji to message text
                                                messageInput.text += modelData;
                                                messageInput.forceActiveFocus();
                                            }
                                            root.emojiPickerVisible = false;
                                            root.activeReactionMsgId = "";
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Category Tabs Bar
                    Rectangle {
                        Layout.fillWidth: true
                        height: 32
                        color: root.colSurface

                        RowLayout {
                            anchors { fill: parent; leftMargin: 6; rightMargin: 6 }
                            spacing: 2

                            Repeater {
                                model: ["⭐", "😀", "👋", "🐶", "🍎", "🚗", "⚽", "💡"]
                                Rectangle {
                                    height: 26
                                    width: 32
                                    radius: 4
                                    color: index === root.selectedEmojiCategory ? root.colAccentDim : (catHover.containsMouse ? root.colPanel : "transparent")
                                    border.color: index === root.selectedEmojiCategory ? root.colAccent : "transparent"
                                    border.width: 1

                                    Text {
                                        anchors.centerIn: parent
                                        text: modelData
                                        font.pointSize: 12
                                        font.family: root.emojiFont
                                        renderType: Text.QtRendering
                                    }

                                    MouseArea {
                                        id: catHover
                                        anchors.fill: parent
                                        hoverEnabled: true
                                        onClicked: root.selectedEmojiCategory = index
                                    }
                                }
                            }
                        }
                    }

                    Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder }

                    // Scrolling vertical emoji grid
                    PlasmaComponents.ScrollView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true

                        GridView {
                            id: emojiGrid
                            anchors.fill: parent
                            anchors.margins: 4
                            cellWidth: 38
                            cellHeight: 38
                            flow: GridView.FlowLeftToRight
                            clip: true

                            model: {
                                if (root.selectedEmojiCategory === 0) return root.emojiList;
                                if (root.selectedEmojiCategory === 1) return root.emojiList.slice(0, 80);
                                if (root.selectedEmojiCategory === 2) return root.emojiList.slice(80, 160);
                                if (root.selectedEmojiCategory === 3) return root.emojiList.slice(220, 310);
                                if (root.selectedEmojiCategory === 4) return root.emojiList.slice(310, 410);
                                if (root.selectedEmojiCategory === 5) return root.emojiList.slice(410, 500);
                                if (root.selectedEmojiCategory === 6) return root.emojiList.slice(500, 563);
                                if (root.selectedEmojiCategory === 7) return root.emojiList.slice(563);
                                return root.emojiList;
                            }

                            delegate: Rectangle {
                                width: 36; height: 36
                                color: emojiItemHover.containsMouse ? root.colAccentDim : "transparent"
                                radius: 4

                                Behavior on color { ColorAnimation { duration: 80 } }

                                Text {
                                    anchors.centerIn: parent
                                    text: modelData
                                    font.pointSize: 16
                                    font.family: root.emojiFont
                                    renderType: Text.QtRendering
                                }

                                MouseArea {
                                    id: emojiItemHover
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: {
                                        if (root.activeReactionMsgId && root.activeChat) {
                                            root.sendReaction(root.activeChat.id, root.activeReactionMsgId, modelData);
                                        } else if (!root.activeReactionMsgId) {
                                            // Insert mode - add emoji to message text
                                            messageInput.text += modelData;
                                            messageInput.forceActiveFocus();
                                        }
                                        root.emojiPickerVisible = false;
                                        root.activeReactionMsgId = "";
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // ── Fullscreen media viewer (Slice 4) ────────────────────────────────────
    // Pinch-zoom/pan for images and stickers with prev/next navigation.
    // NOTE: QtMultimedia is not available in this plasmoid sandbox (Slice 0
    // spike), so video messages render their base64 preview enlarged with an
    // "open on phone" note instead of inline playback.
    Rectangle {
        id: mediaViewer
        anchors.fill: parent
        z: 100
        visible: root.viewerVisible
        color: "#000000"
        focus: visible
        Keys.onEscapePressed: root.closeMediaViewer()
        Keys.onLeftPressed: root.viewerStep(-1)
        Keys.onRightPressed: root.viewerStep(1)

        function currentMsg() {
            if (!root.mediaList || root.mediaList.length === 0) return null;
            var i = Math.max(0, Math.min(root.mediaIndex, root.mediaList.length - 1));
            return root.mediaList[i];
        }

        ColumnLayout {
            anchors.fill: parent
            spacing: 0

            // Header: counter + close
            Rectangle {
                Layout.fillWidth: true
                height: 44
                color: "#cc000000"

                RowLayout {
                    anchors { fill: parent; leftMargin: 12; rightMargin: 8 }
                    spacing: 8

                    PlasmaComponents.Label {
                        text: root.mediaList.length > 0
                              ? (Math.min(root.mediaIndex, root.mediaList.length - 1) + 1) + " of " + root.mediaList.length
                              : ""
                        color: "#ffffff"
                        font.pointSize: 9
                        Layout.fillWidth: true
                    }

                    PlasmaComponents.ToolButton {
                        icon.name: "dialog-close"
                        display: PlasmaComponents.ToolButton.IconOnly
                        onClicked: root.closeMediaViewer()
                    }
                }
            }

            // Stage: pinch-zoom + drag-pan; click closes, double-click resets,
            // drag down dismisses.
            Item {
                id: viewerStage
                Layout.fillWidth: true
                Layout.fillHeight: true
                property real vScale: 1.0
                property real vTx: 0
                property real vTy: 0
                function reset() { vScale = 1.0; vTx = 0; vTy = 0; }

                Image {
                    id: viewerImage
                    anchors.centerIn: parent
                    source: {
                        var m = mediaViewer.currentMsg();
                        if (!m) return "";
                        if (root.viewerFullMsgId !== "" && root.viewerFullMsgId === m.id && root.viewerFullSource !== "")
                            return root.viewerFullSource;
                        var s = MsgUtils.mediaSource(m);
                        if (s !== "") return s;
                        return m.thumbUrl || "";
                    }
                    fillMode: Image.PreserveAspectFit
                    scale: viewerStage.vScale
                    transform: Translate { x: viewerStage.vTx; y: viewerStage.vTy }
                    asynchronous: true

                    // Loading overlay while the full-res image arrives; the
                    // cached 480p thumb stays painted underneath. On failure
                    // the overlay names the problem instead of going blank.
                    PlasmaComponents.Label {
                        anchors.centerIn: parent
                        visible: root.viewerFullLoading || root.viewerFullFailed
                        text: root.viewerFullFailed ? "Couldn't load full image" : "Loading full resolution…"
                        color: "#ffffff"
                        font.pointSize: 9
                        style: Text.Outline
                        styleColor: "#80000000"
                        z: 5
                    }

                    PlasmaComponents.Label {
                        anchors.centerIn: parent
                        visible: {
                            var m = mediaViewer.currentMsg();
                            return !!m && m.type === "video";
                        }
                        text: "🎥 Video — open on phone to play"
                        color: "#ffffff"
                        font.pointSize: 9
                        style: Text.Outline
                        styleColor: "#80000000"
                    }
                }

                PinchArea {
                    anchors.fill: parent
                    onPinchUpdated: {
                        viewerStage.vScale = Math.min(4, Math.max(0.5, viewerStage.vScale * pinch.scale));
                    }
                    MouseArea {
                        id: viewerPan
                        anchors.fill: parent
                        property real lastX: 0
                        property real lastY: 0
                        property real startY: 0
                        property bool moved: false
                        onPressed: function(mouse) {
                            lastX = mouse.x; lastY = mouse.y; startY = mouse.y; moved = false;
                        }
                        onPositionChanged: function(mouse) {
                            var dx = mouse.x - lastX;
                            var dy = mouse.y - lastY;
                            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
                            if (viewerStage.vScale > 1.05) {
                                viewerStage.vTx += dx;
                                viewerStage.vTy += dy;
                            } else if (dy > 0 && mouse.y - startY > 80) {
                                root.closeMediaViewer();   // swipe-down dismiss
                            }
                            lastX = mouse.x; lastY = mouse.y;
                        }
                        onClicked: if (!moved) root.closeMediaViewer()
                        onDoubleClicked: viewerStage.reset()
                    }
                }
            }

                // Footer: prev / next + media label
                Rectangle {
                    Layout.fillWidth: true
                    height: 52
                    color: "#cc000000"

                    RowLayout {
                        anchors { fill: parent; leftMargin: 16; rightMargin: 16 }
                        spacing: 12

                        PlasmaComponents.ToolButton {
                            icon.name: "go-previous"
                            display: PlasmaComponents.ToolButton.IconOnly
                            visible: root.mediaList.length > 1
                            onClicked: root.viewerStep(-1)
                        }
                        Item { Layout.fillWidth: true }
                        PlasmaComponents.Label {
                            text: {
                                var m = mediaViewer.currentMsg();
                                return m ? (MsgUtils.mediaLabel(m.type) || "📷 Media") : "";
                            }
                            color: "#ffffff"
                            font.pointSize: 9
                        }
                        PlasmaComponents.ToolButton {
                            icon.name: "window-new"
                            display: PlasmaComponents.ToolButton.IconOnly
                            ToolTip.text: "Open in system viewer"
                            ToolTip.visible: hovered
                            onClicked: root.openExternallyCurrent()
                        }
                        PlasmaComponents.Label {
                            visible: root.viewerOpenError !== ""
                            text: root.viewerOpenError
                            color: "#ff8a80"
                            font.pointSize: 8
                        }
                        Item { Layout.fillWidth: true }
                        PlasmaComponents.ToolButton {
                            icon.name: "go-next"
                            display: PlasmaComponents.ToolButton.IconOnly
                            visible: root.mediaList.length > 1
                            onClicked: root.viewerStep(1)
                        }
                    }
                }
        }

        onVisibleChanged: {
            if (visible) {
                viewerStage.reset();
                mediaViewer.forceActiveFocus();
            }
        }

        Timer {
            id: viewerOpenErrorTimer
            interval: 3000
            onTriggered: root.viewerOpenError = ""
        }
    }

// Pure-QML clipboard helper (TextEdit.selectAll + copy)
    TextEdit {
        id: clipTextEdit
        visible: false
        width: 0; height: 0
    }

    // Right-click context menu for messages
    Menu {
        id: msgContextMenu
        title: "Message"

        MenuItem {
            text: "Reply"
            icon.name: "mail-reply-sender"
            onClicked: root.startReplyFromContext()
        }
        MenuItem {
            text: "Copy message"
            icon.name: "edit-copy"
            onClicked: root.copyContextMessage()
        }
    }

    // Right-click context menu for chat list rows
    Menu {
        id: chatContextMenu
        title: "Chat"

        MenuItem {
            text: (root.contextChat && root.isChatPinned(root.contextChat)) ? "Unpin Chat" : "Pin Chat"
            icon.name: "bookmark-new"
            onClicked: {
                if (root.contextChat) {
                    root.togglePinChat(root.contextChat.id);
                }
            }
        }
    }

    // "Copied" toast
    Timer {
        id: copyToastTimer
        interval: 1200
        onTriggered: root.copyToastVisible = false
    }

    Rectangle {
        id: copyToast
        visible: root.copyToastVisible
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 80
        width: 88; height: 28; radius: 14
        color: "#2a363c"
        border.color: root.colBorder
        border.width: 1
        z: 99

        PlasmaComponents.Label {
            anchors.centerIn: parent
            text: "Copied!"
            font.pointSize: 8
            color: root.colText
        }
    }
}