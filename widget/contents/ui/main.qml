import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import QtQuick.Controls
import QtMultimedia
import QtCore
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
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
    property string apiKey:       apiSettingsLoader.item ? apiSettingsLoader.item.apiKey : ""
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
    property var    reactionInFlight: ({})  // msgId -> true while a reaction POST is outstanding
    property var    _reactionSnapshots: ({}) // msgId -> reactions[] before optimistic apply (rollback)
    property string pendingReplyId: ""     // msg id being replied to (quoted send)
    property string replyPreviewLabel: ""  // short preview shown in the quote bar
    property var    contextReplyMsg: null  // message that was right-clicked
    property var    contextChat: null      // chat that was right-clicked
    property var    pinnedChats: []        // list of pinned chat IDs
    property var    archivedChats: []      // archived chat IDs
    property bool   showArchived: false    // chat list is showing archived chats
    property string pendingAttachmentPath: "" // pasted image waiting to be sent
    property bool   copyToastVisible: false

    // The backend generates a per-install key in the shared config file. The
    // Loader lets us recreate Settings after startup so a widget that comes up
    // before the backend still picks the key up once it is written.
    Component {
        id: apiSettingsComponent
        Item {
            width: 0
            height: 0
            Settings {
                id: apiSettings
                location: StandardPaths.writableLocation(StandardPaths.GenericConfigLocation).toString()
                          + "/whatsapp-kde-widget.ini"
                property string apiKey: ""
            }
            property alias apiKey: apiSettings.apiKey
        }
    }

    Loader {
        id: apiSettingsLoader
        sourceComponent: apiSettingsComponent
    }

    Timer {
        interval: 5000
        repeat: true
        running: root.apiKey.length === 0
        onTriggered: {
            apiSettingsLoader.active = false
            apiSettingsLoader.active = true
        }
    }

    // ── Agent test workflow (agent_test.sh) ──────────────────────────────────
    // The driver (testDriver.js) is loaded dynamically on completion, and
    // only activates when a test-config.json sits next to main.qml — a file
    // that exists solely in the scratch widget package the test script
    // builds. Normal installs have neither file, so this block is a no-op
    // there. Never set these by hand.
    property bool   testMode: false
    property var    testCfg: null
    property Item   msgListViewRef: null  // captured by the ListView on completion

    // Reliable access to the messages ListView: the `messageListView` id lives
    // in MessagesPanel.qml (Slice 7) and is not resolvable at root scope, so
    // code that scrolls must go through this helper (backed by the
    // `root.msgListViewRef` capture the ListView makes on completion).
    function getMsgListView() {
        if (root.msgListViewRef) return root.msgListViewRef;
        return null;
    }

    Component.onCompleted: {
        var driverHost = null;
        try {
            driverHost = Qt.createQmlObject(
                'import QtQuick; import "testDriver.js" as TestDriver; QtObject { function start(r) { TestDriver.maybeStart(r); } }',
                root, "TestDriverHost");
        } catch (e) { driverHost = null; }
        if (driverHost) {
            try { driverHost.start(root); } catch (e) { }
        }
    }

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
    property string externalOpenToast: ""   // bubble-tap external open status/error toast
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

    function isChatArchived(chat) {
        if (!chat) return false;
        // The backend-provided archivedChats list is authoritative; stale
        // per-chat object flags are ignored so unarchive always takes effect.
        var cid = (typeof chat === "string") ? chat : (chat.id || "");
        if (!cid || !root.archivedChats) return false;
        for (var i = 0; i < root.archivedChats.length; i++) {
            if (String(root.archivedChats[i]) === String(cid)) return true;
        }
        return false;
    }

    // Cross-file entry point for ChatListPanel's search field: QML ids are
    // not properties, so panels cannot reach `searchDebounceTimer` directly.
    function restartSearchDebounce() {
        searchDebounceTimer.restart();
    }

    function recomputeTotalUnread() {
        var u = 0;
        if (root.allChats) {
            for (var i = 0; i < root.allChats.length; i++) {
                if (!root.isChatArchived(root.allChats[i])) {
                    u += root.allChats[i].unreadCount || 0;
                }
            }
        }
        root.totalUnread = u;
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

    function fetchArchivedChats() {
        if (!root.isConnected) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getArchivedChats");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    root.archivedChats = r.response || [];
                    root.recomputeTotalUnread();
                    sortAndFilterChats();
                } catch(e) { }
            }
        };
        xhr.send(JSON.stringify({ args: {} }));
    }

    function setChatArchived(chatId, archived) {
        if (!root.isConnected || !chatId) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/setChatArchived");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    root.archivedChats = r.response || [];
                    if (root.activeChat && String(root.activeChat.id) === String(chatId)
                            && root.isChatArchived(chatId)) {
                        root.activeChat = null;
                    }
                    if (root.showArchived && root.archivedChats.length === 0) {
                        root.showArchived = false;
                        root.chatsShown = 20;
                    }
                    root.recomputeTotalUnread();
                    sortAndFilterChats();
                } catch(e) { }
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: chatId, archived: archived } }));
    }

    // Emoji-supporting font - use Noto Color Emoji if available, fallback to default
    readonly property string emojiFont: "Noto Color Emoji, emoji, monospace"

    onMediaIndexChanged: {
        if (viewerVisible) viewerLoadFull();
    }

    onActiveChatChanged: {
        root.clearPendingReply();
        root.clearPendingAttachment();
        root.scrollRestoreGen++;
        root.lastMsgSig = "";
        root.pollStreak = 0;
        root.pollsSinceFull = 0;
        root.msgsTopError = "";
        root._pendingOlderFetch = "";
        if (activeChat !== null) {
            root._waitGen++;
            root.waitLoopRunning = false;
            root._pendingOpenChatId = "";
            root._pendingJumpEnd = true;
            root.mruTouch(activeChat.id);
            var cached = root.msgCache[activeChat.id];
            if (cached && cached.messages && cached.messages.length > 0) {
                // MRU hit: paint the cached copy instantly, then revalidate in
                // the background — never present stale data as final.
                root.activeChatMessages = cached.messages;
                root.msgsHasMore = true;
                root.isLoadingMessages = false;
                root.jumpToLatestPending();
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
            root._pendingJumpEnd = false;
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

        // System / non-renderable messages (call logs, deleted messages,
        // group notices): show their emoji label instead of a blank preview.
        var body = msg.caption || msg.body || msg.content || "";
        var text;
        if (mediaLabel !== "") {
            text = body !== "" ? mediaLabel + " " + body : mediaLabel;
        } else if (body === "" && MsgUtils.isSystemMessage(msg)) {
            text = MsgUtils.systemMessageText(msg);
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
        contextMenuButtons.clipEdit.text = text;
        contextMenuButtons.clipEdit.selectAll();
        contextMenuButtons.clipEdit.copy();
        contextMenuButtons.clipEdit.deselect();
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
                        fetchArchivedChats();
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
                    root.recomputeTotalUnread();
                    sortAndFilterChats();
                    fetchArchivedChats(); // keep a second widget instance in sync
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
                    // Only refresh the sig baseline on no-change timeouts.
                    // When changed=true the sig must be left alone: the
                    // follow-up fetch computes the same sig and would see
                    // "sig === lastMsgSig" and SKIP the merge — messages
                    // would silently never appear until a full refresh
                    // (which then swaps the model and teleports the scroll).
                    if (!changed && r.sig && r.sig !== root.lastMsgSig) root.lastMsgSig = r.sig;
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
            // Drain a queued top-edge pagination that was blocked by an
            // in-flight poll (its atYBeginningChanged trigger is gone).
            // Guards: never refetch while a settle is re-pinning the view
            // (anchorHold) — the previous prepend may have just landed and the
            // view is still at the top only transiently; requeue instead and
            // let a later poll decide once the restore has moved the view off
            // the top. Cancel outright when the user scrolled away.
            var pendingOlder = root._pendingOlderFetch;
            if (pendingOlder && (!root.activeChat || root.activeChat.id !== pendingOlder)) {
                root._pendingOlderFetch = "";
            } else if (pendingOlder && root.msgsLoadingOlder) {
                // still loading — keep queued
            } else if (pendingOlder && !root.msgsHasMore) {
                root._pendingOlderFetch = "";
            } else if (pendingOlder && root.anchorHold) {
                // keep queued — retry on a later poll
            } else if (pendingOlder) {
                var lvNow = root.getMsgListView();
                if (lvNow && lvNow.atYBeginning) {
                    root._pendingOlderFetch = "";
                    fetchOlderMessages();
                } else {
                    root._pendingOlderFetch = "";
                }
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
                    // Always merge against the LIVE list (not the snapshot
                    // taken at request time): an optimistic send may have
                    // appended a temp bubble while this request was in flight.
                    // settleMessages() preserves unconfirmed temp sends and
                    // drops temps the server has confirmed — no duplicates or
                    // vanishing bubbles when sends and incoming polls race.
                    // applyMessagesModel() keeps the scroll position stable
                    // across the model swap (follows the bottom only when the
                    // user was already reading the latest messages).
                    if (useSince) {
                        root.pollsSinceFull++;
                        var mergedInc = PollUtils.settleMessages(root.activeChatMessages, fresh);
                        root.applyMessagesModel(root.carryMediaUrls(root.activeChatMessages, mergedInc));
                    } else {
                        root.pollsSinceFull = 0;
                        var mergedFull = PollUtils.settleMessages(root.activeChatMessages, fresh);
                        root.applyMessagesModel(root.carryMediaUrls(root.activeChatMessages, mergedFull));
                        if (!background) {
                            root.msgsHasMore = (r.hasMore === true);
                            if (root.testMode) console.warn("WIDDBG hasMore-set: " + root.msgsHasMore +
                                " background=" + background + " useSince=" + useSince +
                                " fresh=" + fresh.length + " r.hasMore=" + r.hasMore);
                        }
                    }
                    // Keep this chat's MRU cache copy fresh (thumbnailized).
                    if (root.activeChat && root.activeChat.id === chatId) {
                        root.mruStore(chatId, root.activeChatMessages, sig);
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

    // ── Scroll-stable model swap ──────────────────────────────────────────────
    // The message model is a plain JS array, so every reassignment resets the
    // ListView and the view can visibly jump ("teleport") — e.g. mid-swipe,
    // when a background poll merge or a late thumbnail lands. This helper
    // snapshots the scroll state first and restores it right after the swap:
    //  - reading the latest messages (at the end, hands off the gestures) →
    //    follow new messages to the bottom,
    //  - anywhere else → re-pin the topmost visible bubble (by message id +
    //    viewport offset), accurate even though contentHeight is partly
    //    estimated for not-yet-instantiated delegates.
    // swapInFlight marks the one-frame reset window: during it the ListView
    // reports contentY=0 / atYBeginning=true spuriously, which must not
    // auto-trigger top-edge pagination.
    property bool swapInFlight: false
    property int  scrollRestoreGen: 0   // supersedes in-flight scroll-restore loops
    property bool anchorHold: false     // a scroll-restore settle is re-pinning the view
    property string restoreMode: ""     // "end" | "anchor" | "" (no settle running)
    property string restoreChat: ""     // chat id the running settle serves
    property string _pendingOlderFetch: "" // older-page fetch queued behind an in-flight poll
    // Set when a chat is (re)opened: the first payload — cold fetch or MRU
    // cache paint — must land on the newest message, regardless of where the
    // previous chat was left scrolled.
    property bool _pendingJumpEnd: false

    // Locate an instantiated message-bubble delegate by message id.
    function findBubbleDelegateIn(item, msgId) {
        if (!item) return null;
        if (item.objectName === "msgBubbleDelegate" && item.testMsgId === msgId) return item;
        var kids = item.children || [];
        for (var i = 0; i < kids.length; i++) {
            var hit = findBubbleDelegateIn(kids[i], msgId);
            if (hit) return hit;
        }
        return null;
    }

    function findBubbleDelegate(lv, msgId) {
        if (!lv || !lv.contentItem) return null;
        return findBubbleDelegateIn(lv.contentItem, msgId);
    }

    // Computed viewport edges. atYEnd/atYBeginning can latch stale
    // values while contentHeight is still growing (async delegate
    // heights), so arrival decisions use live numbers instead.
    function isAtEnd(lv) {
        if (!lv) return true;
        try {
            return lv.contentY >= lv.contentHeight - lv.height - 2;
        } catch (e) { return true; }
    }
    function isAtBeginning(lv) {
        if (!lv) return false;
        try {
            return lv.contentY <= 2;
        } catch (e) { return false; }
    }

    // {id, off}: topmost visible bubble and how far below the viewport top
    // its top edge sits (off = 0 when it is flush with the top).
    function topVisibleAnchor(lv) {
        var a = { id: "", off: 0 };
        if (!lv || !lv.contentItem) return a;
        var best = null, bestY = Infinity;
        var stack = [lv.contentItem];
        while (stack.length > 0) {
            var it = stack.pop();
            if (it.objectName === "msgBubbleDelegate") {
                var y = it.mapToItem(lv.contentItem, 0, 0).y;
                var h = it.height || 1;
                if (y + h > lv.contentY + 10 && y < bestY && y + h > lv.contentY) {
                    bestY = y; best = it;
                }
            }
            var kids = it.children || [];
            for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
        }
        if (best) {
            a.id = best.testMsgId;
            a.off = Math.max(0, best.mapToItem(lv.contentItem, 0, 0).y - lv.contentY);
        }
        return a;
    }

    // Glue the view to the newest message for a few frames while the layout
    // settles (delegate heights stream in asynchronously after a swap).
    // Both settle loops set anchorHold while re-pinning. They exit early once
    // the position sticks (assigned == observed before assigning) so they
    // never fight user scrolls longer than necessary.
    function releaseRestore(t) {
        root.anchorHold = false;
        root.restoreMode = "";
        root.restoreChat = "";
        try { t.stop(); } catch (e) {}
        try { t.destroy(); } catch (e) {}
        Qt.callLater(function() {
            if (!root._pendingOlderFetch || !root.activeChat ||
                root.activeChat.id !== root._pendingOlderFetch) {
                root._pendingOlderFetch = "";
                return;
            }
            var lv = root.getMsgListView();
            if (!lv || !root.isAtBeginning(lv) || !root.msgsHasMore ||
                root.msgsLoadingOlder || root.messagesInFlight || root.anchorHold) {
                if (!lv || !root.isAtBeginning(lv)) root._pendingOlderFetch = "";
                return;
            }
            root._pendingOlderFetch = "";
            root.fetchOlderMessages();
        });
    }
    // Land on the newest message once, right after a chat switch. Consumes the
    // pending flag so later merges keep the user's reading position, and runs
    // the end-settle loop (not a bare positionViewAtEnd) so the jump still
    // wins when delegate heights are not final yet.
    function jumpToLatestPending() {
        if (!root._pendingJumpEnd) return;
        root._pendingJumpEnd = false;
        if (root.activeChatMessages.length === 0) return;
        Qt.callLater(function() {
            var lv = root.getMsgListView();
            if (!lv || lv.count === 0) return;
            root.restoreAtEndSettle(lv);
        });
    }

    function restoreAtEndSettle(lv, retries) {
        if (!lv) return;
        retries = retries || 0;
        root.scrollRestoreGen++;
        var gen = root.scrollRestoreGen;
        var idle = 0;
        var total = 0;
        var lastH = -1;
        root.anchorHold = true;
        root.restoreMode = "end";
        root.restoreChat = root.activeChat ? String(root.activeChat.id) : "";
        var t = Qt.createQmlObject(
            "import QtQuick; Timer { interval: 25; repeat: true; running: true }",
            root, "ScrollEndTimer");
        var retryLater = function() {
            if (retries >= 4) return;
            var rt = Qt.createQmlObject(
                "import QtQuick; Timer { interval: 300; repeat: false; running: true }",
                root, "ScrollEndRetryTimer");
            rt.onTriggered.connect(function() {
                try { rt.destroy(); } catch (e) {}
                if (root.anchorHold || root.restoreMode !== "") return;
                var ll = root.getMsgListView();
                if (!ll) return;
                if (root.isAtEnd(ll) && ll.contentHeight > ll.height) return;
                if (ll.draggingVertically || ll.flickingVertically) return;
                root.restoreAtEndSettle(ll, retries + 1);
            });
        };
        t.onTriggered.connect(function() {
            if (gen !== root.scrollRestoreGen) { root.releaseRestore(t); return; }
            if (lv.draggingVertically || lv.flickingVertically) { root.releaseRestore(t); return; }
            total++;
            if (total > 240) { root.releaseRestore(t); return; }
            // Drive with a direct clamped assignment, not
            // positionViewAtEnd(): issued in the same frame as a model
            // reset, the method call can be swallowed while the ListView
            // is still processing the new model.
            var hNow = lv.contentHeight;
            if (hNow <= 0) return;
            var target = Math.max(0, hNow - lv.height);
            var before = lv.contentY;
            if (Math.abs(target - before) >= 0.5) lv.contentY = target;
            // Exit only on genuine stillness: any height shift or real
            // movement resets the idle count, so slow layouts keep
            // converging instead of timing out mid-stream.
            if (hNow !== lastH) { lastH = hNow; idle = 0; }
            else if ((root.isAtEnd(lv) && hNow > lv.height) || Math.abs(lv.contentY - before) < 0.5) idle++;
            else idle = 0;
            if (idle >= 3) {
                var arrived = root.isAtEnd(lv) && hNow > lv.height;
                var short = hNow <= lv.height;
                root.releaseRestore(t);
                if (!arrived && !short) retryLater();
            }
        });
        if (lv.contentHeight > 0) {
            lv.contentY = Math.max(0, lv.contentHeight - lv.height);
        }
    }

    // Re-pin the same bubble at the same viewport spot for a few frames;
    // recomputed every tick so estimate shifts above the anchor are absorbed.
    // While the anchor delegate is not yet instantiated, bootstrapY is used —
    // for top-edge prepends pass the anchor's NEW index so the bootstrap can
    // use positionViewAtIndex (arithmetic on unsettled contentHeight drifts
    // and can strand the view at the top, re-triggering pagination).
    function restoreAnchoredSettle(lv, anchor, prevY, bootstrapY, bootstrapIndex) {
        if (!lv) return;
        root.scrollRestoreGen++;
        var gen = root.scrollRestoreGen;
        var n = 0;
        var stuck = 0;
        root.anchorHold = true;
        root.restoreMode = "anchor";
        root.restoreChat = root.activeChat ? String(root.activeChat.id) : "";
        var t = Qt.createQmlObject(
            "import QtQuick; Timer { interval: 25; repeat: true; running: true }",
            root, "ScrollAnchorTimer");
        var pinY = function(y) { return Math.max(0, y); };
        var bootstrap = function() {
            if (bootstrapIndex !== undefined && bootstrapIndex !== null && bootstrapIndex >= 0) {
                lv.positionViewAtIndex(bootstrapIndex, ListView.Beginning);
            } else {
                lv.contentY = pinY((bootstrapY !== undefined && bootstrapY !== null) ? bootstrapY : prevY);
            }
        };
        t.onTriggered.connect(function() {
            if (gen !== root.scrollRestoreGen || n > 24) { root.releaseRestore(t); return; }
            if (lv.draggingVertically || lv.flickingVertically) { root.releaseRestore(t); return; }
            n++;
            var d = anchor.id ? root.findBubbleDelegate(lv, anchor.id) : null;
            var before = lv.contentY;
            if (d) {
                lv.contentY = pinY(d.mapToItem(lv.contentItem, 0, 0).y - anchor.off);
            } else {
                bootstrap();
            }
            // Position stuck: re-pinning no longer changes anything — done.
            if (Math.abs(lv.contentY - before) < 0.5) stuck++;
            else stuck = 0;
            if (stuck >= 3) { root.releaseRestore(t); }
        });
        var d0 = anchor.id ? root.findBubbleDelegate(lv, anchor.id) : null;
        if (d0) lv.contentY = pinY(d0.mapToItem(lv.contentItem, 0, 0).y - anchor.off);
        else bootstrap();
    }

    function applyMessagesModel(msgs) {
        var lv = root.getMsgListView();
        // A chat switch overrides the previous chat's scroll state: the first
        // payload must land on the newest message.
        var jumpEnd = root._pendingJumpEnd;
        if (jumpEnd) root._pendingJumpEnd = false;
        var userAtEnd = jumpEnd || (lv ? (root.isAtEnd(lv) && !lv.draggingVertically && !lv.flickingVertically) : true);
        var anchor = { id: "", off: 0 };
        var prevY = 0;
        if (lv) {
            prevY = lv.contentY;
            if (!userAtEnd) anchor = root.topVisibleAnchor(lv);
        }
        if (root.testMode) {
            console.warn("WIDDBG swap: userAtEnd=" + userAtEnd + " atYEnd=" + (lv ? lv.atYEnd : "?") +
                " prevY=" + prevY + " ch=" + (lv ? Math.round(lv.contentHeight) : "?") +
                " h=" + (lv ? lv.height : "?") + " anchor=" + anchor.id +
                " dragging=" + (lv ? lv.draggingVertically : "?") +
                " flicking=" + (lv ? lv.flickingVertically : "?") +
                " count=" + msgs.length);
        }
        root.swapInFlight = true;
        root.activeChatMessages = msgs;
        if (!lv) { root.swapInFlight = false; return; }
        Qt.callLater(function() {
            root.swapInFlight = false;
            if (!lv || root.activeChatMessages !== msgs) return; // a newer merge took over
            if (root.anchorHold && root.restoreMode !== "") {
                var liveChat = root.activeChat ? String(root.activeChat.id) : "";
                if (liveChat !== "" && liveChat === root.restoreChat) {
                    return;
                }
                root.scrollRestoreGen++;
                var liveAtEnd = root.isAtEnd(lv) && !lv.draggingVertically && !lv.flickingVertically;
                if (liveAtEnd) {
                    root.restoreAtEndSettle(lv);
                } else {
                    root.restoreAnchoredSettle(lv, root.topVisibleAnchor(lv), lv.contentY);
                }
                return;
            }
            if (userAtEnd) {
                root.restoreAtEndSettle(lv);
            } else {
                root.restoreAnchoredSettle(lv, anchor, prevY);
            }
        });
    }

    // ── Top-edge pagination: load 20 older messages on scroll-up ─────────────
    function fetchOlderMessages() {
        if (root.testMode) console.warn("WIDDBG prepend-run: hasMore=" + root.msgsHasMore +
            " loading=" + root.msgsLoadingOlder + " inflight=" + root.messagesInFlight +
            " y=" + (root.getMsgListView() ? Math.round(root.getMsgListView().contentY) : "?"));
        if (!root.isConnected || root.activeChat === null || root.msgsLoadingOlder || !root.msgsHasMore) return;
        if (root.messagesInFlight || root.anchorHold) {
            // Serialize with background polls AND with running scroll
            // restores: starting a second fetch while a restore is still
            // re-pinning captures its anchor mid-churn and strands the
            // view. Remember to retry once things settle.
            root._pendingOlderFetch = root.activeChat.id;
            return;
        }
        var msgs = root.activeChatMessages;
        if (msgs.length === 0) return;
        var lv = root.getMsgListView();
        var oldest = null;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && msgs[i].id && String(msgs[i].id).indexOf("temp_") !== 0) { oldest = msgs[i]; break; }
        }
        if (!oldest) return;

        var chatId = root.activeChat.id;
        // Capture the reading anchor NOW, at fetch start — the view is still
        // exactly where the user left it. Waiting for the response risks a
        // drifted view (another merge or settle may have re-pinned in between).
        var anchor = lv ? root.topVisibleAnchor(lv) : { id: "", off: 0 };
        var anchorPrevY = lv ? lv.contentY : 0;
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
                    // The model swap resets the ListView; re-pin the bubble the
                    // user was reading (captured at fetch start) at the same
                    // viewport spot. Anchor-based, not contentHeight arithmetic
                    // — contentHeight is partly estimated for delegates that
                    // are not instantiated, so delta math drifts.
                    var lv = root.getMsgListView();
                    var newMsgs = PollUtils.prependOlder(root.activeChatMessages, older);
                    root.swapInFlight = true; // suppress spurious atYBeginning triggers during the reset
                    root.activeChatMessages = newMsgs;
                    // Re-pin the same bubble at the same viewport spot for a
                    // few frames while heights settle (see restoreAnchoredSettle).
                    // Resolve the anchor to a message id up front; at run time
                    // rebase it onto whatever model is live. A concurrent merge
                    // (thumb landing, background poll) may replace the array
                    // between response and layout — abandoning the restore
                    // then strands the view wherever the reset dropped it.
                    // With no identifiable anchor, fall back to the first
                    // pre-existing item (it sits at older.length).
                    var rebaseId = anchor.id;
                    var rebaseOff = anchor.off || 0;
                    if (!rebaseId && newMsgs.length > older.length) {
                        var firstOld = newMsgs[older.length];
                        if (firstOld && firstOld.id) rebaseId = String(firstOld.id);
                    }
                    if (lv && rebaseId) {
                        (function(lvRef, wantId, wantOff) {
                            Qt.callLater(function() {
                                root.swapInFlight = false;
                                if (!lvRef) return;
                                var cur = root.activeChatMessages || [];
                                var nk = -1;
                                for (var i = 0; i < cur.length; i++) {
                                    if (cur[i] && String(cur[i].id) === wantId) { nk = i; break; }
                                }
                                if (nk < 0) return; // anchor genuinely gone
                                root.restoreAnchoredSettle(lvRef,
                                    { id: wantId, off: wantOff }, anchorPrevY, -1, nk);
                            });
                        })(lv, rebaseId, rebaseOff);
                    } else {
                        root.swapInFlight = false;
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
        // Reassign through the scroll-stable swap: a late thumbnail landing
        // mid-scroll must not reset the ListView and yank the view.
        root.applyMessagesModel(msgs.slice());
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

    // ── Voice-note / audio playback ────────────────────────────────────────
    // One shared player for the whole widget: starting a second bubble
    // stops the first, and bubble UI binds to root.audio* state.
    property string audioPlayingMsgId: ""
    property string audioPendingMsgId: ""
    property string audioErrorMsgId: ""
    property string audioError: ""
    property bool audioIsPlaying: false
    property int audioPositionMs: 0
    property real audioSpeed: 1.0

    MediaPlayer {
        id: audioPlayer
        audioOutput: AudioOutput { }
        onPlaybackStateChanged: {
            root.audioIsPlaying = (playbackState === MediaPlayer.PlayingState);
            if (playbackState === MediaPlayer.StoppedState) root.audioPositionMs = 0;
        }
        onPositionChanged: { root.audioPositionMs = position; }
        onErrorOccurred: function(error, errorString) {
            root.audioError = errorString || "Couldn't play audio";
            root.audioErrorMsgId = root.audioPlayingMsgId;
            root.audioPlayingMsgId = "";
            root.audioIsPlaying = false;
            root.audioPendingMsgId = "";
            audioErrorTimer.restart();
        }
    }

    Timer {
        id: audioErrorTimer
        interval: 2500
        repeat: false
        running: false
        onTriggered: { root.audioError = ""; root.audioErrorMsgId = ""; }
    }

    function audioSpeedLabel() {
        if (root.audioSpeed >= 2.0) return "2x";
        if (root.audioSpeed >= 1.5) return "1.5x";
        return "1x";
    }

    function cycleAudioSpeed() {
        if (root.audioSpeed >= 2.0) root.audioSpeed = 1.0;
        else if (root.audioSpeed >= 1.5) root.audioSpeed = 2.0;
        else root.audioSpeed = 1.5;
        audioPlayer.playbackRate = root.audioSpeed;
    }

    // Fetch full audio bytes once, then write the dataUrl back onto the
    // live message (+ MRU copy) so revalidations never refetch it.
    function requestAudio(msg) {
        if (!msg || msg.fullUrl) return;
        if (!MsgUtils.isAudioMessage(msg)) return;
        if (!root.activeChat || !msg.id) return;
        var chatId = root.activeChat.id;
        var mid = msg.id;
        root.fetchMedia(chatId, mid, 0, function(url) {
            if (!url) {
                if (String(root.audioPendingMsgId) === String(mid)) {
                    root.audioPendingMsgId = "";
                    root.audioError = "Couldn't load audio";
                    root.audioErrorMsgId = mid;
                    audioErrorTimer.restart();
                }
                return;
            }
            root.applyFullUrl(mid, url);
            if (String(root.audioPendingMsgId) === String(mid)) {
                root.audioPendingMsgId = "";
                audioPlayer.source = url;
                audioPlayer.playbackRate = root.audioSpeed;
                audioPlayer.play();
            }
        });
    }

    function applyFullUrl(msgId, dataUrl) {
        if (!msgId || !dataUrl) return;
        var found = false;
        var msgs = root.activeChatMessages;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && String(msgs[i].id) === String(msgId)) {
                msgs[i].fullUrl = dataUrl;
                found = true;
                break;
            }
        }
        if (!found) return;
        root.applyMessagesModel(msgs.slice());
        if (root.activeChat) {
            var cid = root.activeChat.id;
            var entry = root.msgCache[cid];
            if (entry && entry.messages) {
                for (var j = 0; j < entry.messages.length; j++) {
                    if (entry.messages[j] && String(entry.messages[j].id) === String(msgId)) {
                        entry.messages[j].fullUrl = dataUrl;
                        break;
                    }
                }
                var next = {};
                for (var k in root.msgCache) next[k] = root.msgCache[k];
                root.msgCache = next;
            }
        }
    }

    function toggleAudioPlayback(msg) {
        if (!msg || !msg.id) return;
        var mid = msg.id;
        if (String(root.audioPlayingMsgId) === String(mid) && root.audioIsPlaying) {
            audioPlayer.pause();
            return;
        }
        if (String(root.audioPlayingMsgId) === String(mid) && !root.audioIsPlaying) {
            var resumeSrc = msg.fullUrl || "";
            if (resumeSrc && String(audioPlayer.source) !== "") {
                audioPlayer.playbackRate = root.audioSpeed;
                audioPlayer.play();
                return;
            }
        }
        root.audioPlayingMsgId = mid;
        root.audioPositionMs = 0;
        root.audioError = "";
        root.audioErrorMsgId = "";
        var src = msg.fullUrl || "";
        if (src) {
            audioPlayer.source = src;
            audioPlayer.playbackRate = root.audioSpeed;
            audioPlayer.play();
        } else {
            root.audioPendingMsgId = mid;
            audioPlayer.stop();
            root.requestAudio(msg);
        }
    }

    function stopAudio() {
        audioPlayer.stop();
        root.audioPlayingMsgId = "";
        root.audioPositionMs = 0;
        root.audioPendingMsgId = "";
    }

    function seekAudioFraction(frac, msgId) {
        if (String(root.audioPlayingMsgId) !== String(msgId)) return;
        var d = audioPlayer.duration || 0;
        if (d <= 0) return;
        var f = Math.min(1, Math.max(0, frac));
        audioPlayer.position = Math.floor(f * d);
    }

    // ── Voice-note recording ───────────────────────────────────────────────
    // Toggle flow, laptop-first: tap mic to record, tap again to stop into
    // a draft (play / discard / send). Drafts send through the same
    // sendFile path as pasted images, so the backend needs no new endpoint.
    property string voiceState: ""
    property string voicePath: ""
    property int voiceSecs: 0
    property string voiceError: ""
    // Blink phase for the recording dot (lives in SendMessageBar.qml, which
    // root-level code cannot reach by id — see note at the alias block).
    property bool recDotLit: true

    CaptureSession {
        id: voiceCapture
        audioInput: AudioInput { id: voiceMic }
        recorder: MediaRecorder {
            id: voiceRecorder
            onErrorOccurred: function(error, errorString) {
                root.voiceError = errorString || "Microphone unavailable";
                root.voiceState = "";
                root.voiceSecs = 0;
                voiceRecTimer.stop();
                voiceErrorTimer.restart();
            }
        }
    }

    Timer {
        id: voiceRecTimer
        interval: 1000
        repeat: true
        running: false
        onTriggered: {
            root.voiceSecs++;
            root.recDotLit = !root.recDotLit;
        }
    }

    Timer {
        id: voiceErrorTimer
        interval: 3000
        repeat: false
        running: false
        onTriggered: root.voiceError = ""
    }

    function voiceDraftUrl() {
        if (!root.voicePath) return "";
        var p = String(root.voicePath);
        return p.indexOf("file://") === 0 ? p : "file://" + p;
    }

    function startVoiceNote() {
        if (root.voiceState === "recording" || !root.activeChat) return;
        root.stopAudio();
        var dir = "";
        try { dir = StandardPaths.writableLocation(StandardPaths.TempLocation); } catch (e) {}
        if (!dir) dir = "/tmp";
        var plain = String(dir).replace(/\/$/, "") + "/wa-voicenote-" + Date.now() + ".ogg";
        root.voicePath = plain;
        root.voiceSecs = 0;
        root.recDotLit = true;
        root.voiceError = "";
        try {
            voiceRecorder.outputLocation = "file://" + plain;
            voiceRecorder.record();
        } catch (e) {
            root.voiceError = "Microphone unavailable";
            root.voicePath = "";
            voiceErrorTimer.restart();
            return;
        }
        root.voiceState = "recording";
        voiceRecTimer.start();
    }

    function stopVoiceNote() {
        if (root.voiceState !== "recording") return;
        try { voiceRecorder.stop(); } catch (e) {}
        voiceRecTimer.stop();
        try {
            var actual = String(voiceRecorder.actualLocation || "");
            if (actual) root.voicePath = actual.replace(/^file:\/\//, "");
        } catch (e) {}
        root.voiceState = root.voicePath ? "draft" : "";
    }

    function toggleVoiceNote() {
        if (root.voiceState === "recording") root.stopVoiceNote();
        else if (root.voiceState === "") root.startVoiceNote();
    }

    function discardVoiceNote() {
        try { voiceRecorder.stop(); } catch (e) {}
        voiceRecTimer.stop();
        if (String(root.audioPlayingMsgId) === "__draft__") root.stopAudio();
        root.voiceState = "";
        root.voicePath = "";
        root.voiceSecs = 0;
    }

    function playVoiceDraft() {
        if (!root.voicePath) return;
        if (String(root.audioPlayingMsgId) === "__draft__" && root.audioIsPlaying) {
            audioPlayer.pause();
            return;
        }
        root.toggleAudioPlayback({ id: "__draft__", fullUrl: root.voiceDraftUrl() });
    }

    function sendVoiceNote() {
        if (!root.activeChat || !root.voicePath || root.sendInFlight) return;
        var path = String(root.voicePath);
        var chatId = root.activeChat.id;
        if (String(root.audioPlayingMsgId) === "__draft__") root.stopAudio();
        root.voiceState = "";
        root.voicePath = "";
        root.voiceSecs = 0;
        root.sendFile(chatId, path, "");
    }

    // ── Fullscreen media viewer (Slice 4) ────────────────────────────────────
    function openMediaViewer(startIndex) {
        var list = MsgUtils.buildMediaList(root.activeChatMessages);
        if (!list || list.length === 0 || startIndex < 0 || startIndex >= list.length) return;
        root.mediaList = list;
        root.mediaIndex = startIndex;
        root.viewerVisible = true;
        root.viewerFullFailed = false;
        root.viewerLoadFull();
    }

    function closeMediaViewer() {
        root.viewerVisible = false;
        root.viewerFullLoading = false;
        root.viewerFullFailed = false;
    }

    function viewerStep(d) {
        if (!root.mediaList || root.mediaList.length === 0) return;
        root.viewerFullFailed = false;
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

    // Open a media image in the system viewer via POST /api/openExternally
    // (full-res fetch + xdg-open server-side). Primary path: tapping an image
    // bubble (no in-app viewer detour); also used by the viewer toolbar.
    // Progress/failures surface as a transient toast over the chat, never
    // silent or fatal.
    function openExternallyMsg(m) {
        if (!m || !m.id || !root.isConnected || !root.activeChat) {
            root.externalOpenToast = "Couldn't open image";
            externalOpenToastTimer.restart();
            return;
        }
        root.externalOpenToast = "Opening in system viewer…";
        externalOpenToastTimer.stop();
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/openExternally");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                root.externalOpenToast = "";
            } else {
                root.externalOpenToast = "Couldn't open in system viewer";
                externalOpenToastTimer.restart();
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: root.activeChat.id, msgId: m.id } }));
    }

    // Viewer toolbar variant: opens whichever image is currently shown.
    function openExternallyCurrent() {
        var m = null;
        if (root.mediaList && root.mediaList.length > 0) {
            var ci = Math.max(0, Math.min(root.mediaIndex, root.mediaList.length - 1));
            m = root.mediaList[ci];
        }
        root.openExternallyMsg(m);
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
        root.applyMessagesModel(currentMsgs);

        // Position at the bottom of the messages list
        Qt.callLater(function() {
            var lv = root.getMsgListView();
            if (lv) {
                lv.positionViewAtEnd();
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

    // ── Optimistic reactions (REQ-002/AC-001) ─────────────────────────────
    // Chip click and picker-with-activeReactionMsgId both funnel through
    // sendReaction() below, so the optimistic apply lives here centrally.
    // Add path pushes {emoji, sender:"", fromMe:true}; toggle-off removes
    // one own entry for that emoji. Server truth replaces the optimistic
    // entry via the existing merge path (mergeMessages by id in
    // fetchMessages), for both full-fetch and since-poll arrivals.
    function applyOptimisticReaction(msgId, emoji, remove) {
        if (!msgId || !emoji) return;
        var key = String(msgId);
        var msgs = root.activeChatMessages;
        var found = false;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && String(msgs[i].id) === key) {
                if (root._reactionSnapshots[key] === undefined) {
                    var nextSnap = {};
                    for (var k in root._reactionSnapshots) nextSnap[k] = root._reactionSnapshots[k];
                    nextSnap[key] = msgs[i].reactions ? msgs[i].reactions.slice() : [];
                    root._reactionSnapshots = nextSnap;
                }
                var cur = msgs[i].reactions ? msgs[i].reactions.slice() : [];
                if (remove) {
                    for (var r = 0; r < cur.length; r++) {
                        if (cur[r] && String(cur[r].emoji) === String(emoji) && cur[r].fromMe) {
                            cur.splice(r, 1);
                            break;
                        }
                    }
                } else {
                    var hasOwn = false;
                    for (var a = 0; a < cur.length; a++) {
                        if (cur[a] && String(cur[a].emoji) === String(emoji) && cur[a].fromMe) { hasOwn = true; break; }
                    }
                    if (!hasOwn) cur.push({ emoji: emoji, sender: "", fromMe: true });
                }
                msgs[i].reactions = cur;
                found = true;
                break;
            }
        }
        if (found) root.applyMessagesModel(msgs.slice());
    }

    function rollbackOptimisticReaction(msgId) {
        var key = String(msgId);
        if (root._reactionSnapshots[key] === undefined) return;
        var prev = root._reactionSnapshots[key];
        var msgs = root.activeChatMessages;
        for (var i = 0; i < msgs.length; i++) {
            if (msgs[i] && String(msgs[i].id) === key) {
                msgs[i].reactions = prev;
                break;
            }
        }
        root.applyMessagesModel(msgs.slice());
    }

    function clearReactionFlight(msgId) {
        var key = String(msgId);
        var f = {};
        for (var k in root.reactionInFlight) { if (k !== key) f[k] = root.reactionInFlight[k]; }
        root.reactionInFlight = f;
        var s = {};
        for (var k2 in root._reactionSnapshots) { if (k2 !== key) s[k2] = root._reactionSnapshots[k2]; }
        root._reactionSnapshots = s;
    }

    function sendReaction(chatId, msgId, reaction, remove) {
        if (!root.isConnected || !chatId || !msgId || !reaction) return;
        var key = String(msgId);
        // In-flight guard (spec section 9 double-click race): one send per
        // msgId at a time; rapid toggles while a POST is outstanding are
        // ignored so add/remove cannot interleave out of order.
        if (root.reactionInFlight[key]) return;
        var next = {};
        for (var k in root.reactionInFlight) next[k] = root.reactionInFlight[k];
        next[key] = true;
        root.reactionInFlight = next;
        var wantRemove = !!remove;
        root.applyOptimisticReaction(msgId, reaction, wantRemove);
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/sendReaction");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.timeout = 30000;
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                root.clearReactionFlight(msgId);
                if (root.activeChat) fetchMessages(root.activeChat.id);
            } else {
                root.rollbackOptimisticReaction(msgId);
                root.clearReactionFlight(msgId);
            }
        };
        xhr.ontimeout = function() {
            root.rollbackOptimisticReaction(msgId);
            root.clearReactionFlight(msgId);
        };
        try {
            xhr.send(JSON.stringify({ args: { chatId: chatId, msgId: msgId, reaction: reaction, remove: wantRemove } }));
        } catch (e) {
            root.rollbackOptimisticReaction(msgId);
            root.clearReactionFlight(msgId);
        }
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

    function toggleArchivedView() {
        root.showArchived = !root.showArchived;
        root.searchQuery = "";
        root.chatsShown = 20;
        filterChats();
    }

    function filterChats() {
        if (!root.allChats || root.allChats.length === 0) { root.filteredChats = []; return; }
        root.filteredChats = MsgUtils.filterChats(root.allChats, root.searchQuery,
                                                  root.archivedChats, root.showArchived);
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

            // ── Page 1: chat list (ChatListPanel.qml) ──────────────────────────
            ChatListPanel {
                rootItem: root
            }

            // ── Page 2: message history + compose (MessagesPanel.qml) ─────────
            MessagesPanel {
                rootItem: root
                audioPlayerRef: audioPlayer
            }
        }

        // ── Emoji Picker Overlay (EmojiPickerOverlay.qml) ──────────────────
        EmojiPickerOverlay {
            anchors.fill: parent
            rootItem: root
        }

    }
    // ── Fullscreen media viewer (MediaViewerOverlay.qml) ────────────────────
    // Pinch-zoom/pan for images and stickers with prev/next navigation.
    // NOTE: QtMultimedia is not available in this plasmoid sandbox (Slice 0
    // spike), so video messages render their base64 preview enlarged with an
    // "open on phone" note instead of inline playback.
    MediaViewerOverlay {
        anchors.fill: parent
        rootItem: root
    }

    // Hidden clipboard helper (ContextMenuButtons.qml). Exposed as a property so
    // code in other files can reach it as `root.contextMenuButtons.clipEdit`.
    readonly property alias contextMenuButtons: clipboardHelper
    ContextMenuButtons {
        id: clipboardHelper
        rootItem: root
    }

    // Right-click context menus (Menus.qml). Exposed as a property so delegate code
    // in other files can call `root.menus.<popup>.popup(...)`.
    readonly property alias menus: menusObj
    Menus {
        id: menusObj
        rootItem: root
    }

    // NOTE: fullRepresentation is Component-typed, so ids inside it are NOT
    // visible to root-level `property alias` (engine: "Unable to find id").
    // Same-tree code reaches the compose bar as `sendBar.*` (the instance
    // lives in MessagesPanel.qml); root-level code talks to it through root
    // state (see recDotLit, messageInputRef).

    // "Copied" toast
    Timer {
        id: copyToastTimer
        interval: 1200
        onTriggered: root.copyToastVisible = false
    }

    // External-open status toast ("Opening…" while fetching full-res, error
    // on failure); clears itself after a short delay so it never lingers.
    Rectangle {
        id: externalOpenToastPanel
        visible: root.externalOpenToast !== ""
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 120
        width: Math.max(160, toastText.implicitWidth + 32); height: 30; radius: 15
        color: "#2a363c"
        border.color: root.colBorder
        border.width: 1
        z: 99

        PlasmaComponents.Label {
            id: toastText
            anchors.centerIn: parent
            text: root.externalOpenToast
            font.pointSize: 8
            color: root.colText
        }
    }

    Timer {
        id: externalOpenToastTimer
        interval: 3000
        onTriggered: root.externalOpenToast = ""
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