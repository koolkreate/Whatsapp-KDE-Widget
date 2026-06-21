import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import QtQuick.Controls
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
import QtQuick.Dialogs

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
    property string statusMessage: "Connecting to backend…"
    property int    totalUnread:  0
    property bool   sendInFlight: false
    signal messageSent(bool success)
    property bool   emojiPickerVisible: false
    property string activeReactionMsgId: ""  // msg id for reaction popup

    // Emoji-supporting font - use Noto Color Emoji if available, fallback to default
    readonly property string emojiFont: "Noto Color Emoji, emoji, monospace"

    onActiveChatChanged: {
        if (activeChat !== null) {
            root.activeChatMessages = [];
            fetchMessages(activeChat.id);
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
        if (msg.type === "image")    return "📷 Photo";
        if (msg.type === "video")    return "🎥 Video";
        if (msg.type === "audio")    return "🎵 Audio";
        if (msg.type === "document") return "📄 Document";
        if (msg.type === "sticker")  return "🪄 Sticker";
        var body = msg.body || msg.content || "";
        return body.length > 48 ? body.substring(0, 48) + "…" : body;
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
                        root.statusMessage = "";
                        fetchChats();
                    } else {
                        root.isConnected = false;
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

    function fetchChats() {
        if (!root.isConnected) return;
        root.isLoading = true;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getAllChats");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.isLoading = false;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    var chats = r.response || r;
                    // Sort: unread first, then by timestamp desc
                    chats.sort(function(a, b) {
                        var ua = a.unreadCount || 0, ub = b.unreadCount || 0;
                        if (ua !== ub) return ub - ua;
                        var ta = (a.t || a.lastMessage && a.lastMessage.t) || 0;
                        var tb = (b.t || b.lastMessage && b.lastMessage.t) || 0;
                        return tb - ta;
                    });
                    root.allChats = chats;
                    var u = 0;
                    for (var i = 0; i < chats.length; i++) u += chats[i].unreadCount || 0;
                    root.totalUnread = u;
                    filterChats();
                } catch(e) {
                    console.log("Parse error:", e);
                }
            } else if (xhr.status === 503) {
                root.isConnected = false;
                root.statusMessage = "WhatsApp client initializing…";
            }
        };
        xhr.send(JSON.stringify({ args: {} }));
    }

    function fetchMessages(chatId) {
        if (!root.isConnected || !chatId) return;
        root.isLoadingMessages = true;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/getChatMessages");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            root.isLoadingMessages = false;
            if (xhr.status === 200) {
                try {
                    var r = JSON.parse(xhr.responseText);
                    var msgs = r.response || r || [];
                    root.activeChatMessages = msgs;
                    // Scroll to bottom of message list after updating
                    Qt.callLater(function() {
                        if (typeof messageListView !== "undefined" && messageListView) {
                            messageListView.positionViewAtEnd();
                        }
                    });
                } catch(e) {
                    console.log("Parse messages error:", e);
                }
            }
        };
        xhr.send(JSON.stringify({ args: { chatId: chatId } }));
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
        xhr.send(JSON.stringify({ args: { to: chatId, content: originalText } }));
    }

    function sendFile(chatId, filePath) {
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
        xhr.send(JSON.stringify({ args: { to: chatId, filePath: filePath.toString() } }));
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

    function sendReaction(chatId, msgId, reaction) {
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
        xhr.send(JSON.stringify({ args: { chatId: chatId, msgId: msgId, reaction: reaction } }));
    }

    function pasteImageFromClipboard() {
        if (!root.isConnected || !root.activeChat) return;
        var xhr = new XMLHttpRequest();
        xhr.open("POST", apiHost + "/api/pasteImage");
        xhr.setRequestHeader("Content-Type",  "application/json");
        xhr.setRequestHeader("X-API-Key",     apiKey);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            if (xhr.status === 200) {
                try {
                    var res = JSON.parse(xhr.responseText);
                    if (res.response === "sent") {
                        root.messageSent(true);
                        fetchMessages(root.activeChat.id);
                    } else {
                        root.messageSent(false);
                        messageInput.paste();
                    }
                } catch(e) {
                    root.messageSent(false);
                    messageInput.paste();
                }
            } else {
                messageInput.paste();
            }
        };
        xhr.send(JSON.stringify({ args: { to: root.activeChat.id } }));
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
        id: pollTimer
        interval: 20000
        running:  root.isConnected && root.activeChat === null
        repeat:   true
        triggeredOnStart: true
        onTriggered: fetchChats()
    }
    Timer {
        id: messagePollTimer
        interval: 5000
        running:  root.isConnected && root.activeChat !== null
        repeat:   true
        onTriggered: {
            if (root.activeChat) {
                fetchMessages(root.activeChat.id);
            }
        }
    }

    FileDialog {
        id: fileDialog
        title: "Select an attachment"
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
                            onTextChanged: { root.searchQuery = text; filterChats(); }
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
                        model: root.filteredChats
                        spacing: 0

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
                                onEntered: chatRow.hovered = true
                                onExited:  chatRow.hovered = false
                                onClicked: {
                                    root.activeChat = {
                                        id:      modelData.id,
                                        name:    modelData.name || modelData.formattedTitle || "Unknown",
                                        isGroup: modelData.isGroup || false
                                    };
                                }
                            }

                            Behavior on color { ColorAnimation { duration: 120 } }

                            RowLayout {
                                anchors { fill: parent; leftMargin: 14; rightMargin: 14 }
                                spacing: 12

                                // Avatar
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

                        // Recipient avatar
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
                            PlasmaComponents.Label {
                                text: root.activeChat ? root.activeChat.id.split("@")[0] : ""
                                font.pointSize: 8
                                color: root.colSub
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
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
                        spacing: 8
                        clip: true

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
                            height: msgBubbleCol.implicitHeight + 6

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
                                        height: msgCol.implicitHeight + 12
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
                                                visible: modelData.type === "image" || modelData.type === "sticker" || modelData.type === "video" || (modelData.body && (modelData.body.startsWith("/9j/") || modelData.body.startsWith("data:image") || modelData.body.startsWith("iVBORw0KGgo")))
                                                source: {
                                                    if (!visible || !modelData.body) return "";
                                                    if (modelData.body.startsWith("data:")) return modelData.body;
                                                    var prefix = "data:image/jpeg;base64,";
                                                    if (modelData.body.startsWith("iVBORw0KGgo")) {
                                                        prefix = "data:image/png;base64,";
                                                    }
                                                    return prefix + modelData.body;
                                                }
                                                fillMode: Image.PreserveAspectFit
                                                Layout.maximumWidth: messageListView.width * 0.7
                                                Layout.preferredWidth: Math.min(messageListView.width * 0.7, 240)
                                                Layout.preferredHeight: Math.min(messageListView.width * 0.7, 180)
                                                asynchronous: true
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
                                    Layout.leftMargin: modelData.fromMe ? 50 : 14
                                    Layout.rightMargin: modelData.fromMe ? 14 : 50
                                    spacing: 2
                                    visible: modelData.reactions && modelData.reactions.length > 0

                                    Repeater {
                                        model: modelData.reactions || []
                                        Rectangle {
                                            height: 20
                                            width: reactLabel.implicitWidth + 10
                                            radius: 10
                                            color: root.colPanel
                                            border.color: root.colBorder
                                            border.width: 1

                                            Text {
                                                id: reactLabel
                                                anchors.centerIn: parent
                                                text: modelData.emoji || ""
                                                font.pointSize: 11
                                                font.family: root.emojiFont
                                                renderType: Text.QtRendering
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
                    height: 70
                    color: root.colHeader


                    ColumnLayout {
                        anchors { fill: parent; leftMargin: 10; rightMargin: 10; topMargin: 8; bottomMargin: 8 }
                        spacing: 4

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

                                        TextEdit {
                                            id: messageInput
                                            Component.onCompleted: root.messageInputRef = messageInput
                                            width: flick.width
                                            anchors.verticalCenter: parent.verticalCenter
                                            wrapMode: TextEdit.Wrap
                                            color: root.colText
                                            font.pointSize: 9.5
                                            font.family: root.emojiFont
                                            selectionColor: root.colAccent
                                            focus: true

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
                                                    if (root.activeChat && messageInput.text.trim().length > 0) {
                                                        sendMessage(root.activeChat.id, messageInput.text);
                                                    }
                                                }
                                            }


                                            Keys.onPressed: function(event) {
                                                if (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)) {
                                                    event.accepted = true;
                                                    pasteImageFromClipboard();
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
                                    if (sendMouseArea.containsMouse && messageInput.text.trim().length > 0 && !root.sendInFlight) return root.colAccentDim;
                                    return root.colAccent;
                                }
                                opacity: (messageInput.text.trim().length === 0 || root.sendInFlight) ? 0.5 : 1.0

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
                                        if (root.activeChat && messageInput.text.trim().length > 0 && !root.sendInFlight) {
                                            sendMessage(root.activeChat.id, messageInput.text);
                                        }
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

                    Rectangle { Layout.fillWidth: true; height: 1; color: root.colBorder }

                    // Scrolling emoji grid
                    PlasmaComponents.ScrollView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true

                        ListView {
                            id: emojiGrid
                            anchors.fill: parent
                            model: root.emojiList
                            spacing: 0
                            orientation: ListView.Horizontal
                            layoutDirection: Qt.LeftToRight
                            snapMode: ListView.SnapToItem

                            delegate: Rectangle {
                                width: 38; height: 38
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
}