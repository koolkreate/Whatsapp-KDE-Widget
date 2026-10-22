// MessagesPanel.qml — Page-2 message history + compose: chat header,
// message ListView (`objectName: "messageListView"`, found by testDriver.js),
// top-edge pagination header, bubble delegate tree (delegate
// `objectName: "msgBubbleDelegate"` + `testMsgId`, found by testDriver.js),
// reactions row, quick-reply chips, quote bar, attachment chip, compose area
// (hosts the `SendMessageBar` instance as `id: sendBar`, so same-tree
// `sendBar.messageInput.*` sites resolve locally). Instantiated by main.qml
// as `MessagesPanel { rootItem: root; audioPlayerRef: audioPlayer }`.
// (Root is the ColumnLayout itself — not a wrapping Item — so the parent
//  StackLayout sizes it verbatim, exactly as when the block was inline.
//  All state and functions stay on the root PlasmoidItem and are reached
//  as `rootItem.*`. The shared `audioPlayer` MediaPlayer stays in main.qml
//  and is injected as `audioPlayerRef` — delegate audio-progress bindings
//  cannot see main.qml ids across the component boundary.)
import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import QtQuick.Controls
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
import "messageUtils.js" as MsgUtils

ColumnLayout {
    id: messagesPanel
    // Named rootItem (not root): `rootItem: root` at the instance site must
    // not self-resolve — a property named `root` would shadow the outer id.
    required property PlasmoidItem rootItem
    // Shared audio player (lives in main.qml; injected at the instance site
    // because component files cannot see main.qml ids).
    required property var audioPlayerRef
    spacing: 0

    // ── Compose header ─────────────────────────────
    Rectangle {
        Layout.fillWidth: true
        height: 60
        color: rootItem.colHeader

        RowLayout {
            anchors { fill: parent; leftMargin: 6; rightMargin: 14 }
            spacing: 8

            PlasmaComponents.ToolButton {
                icon.name: "go-previous"
                display: PlasmaComponents.ToolButton.IconOnly
                ToolTip.text: "Back to chats"
                ToolTip.visible: hovered
                onClicked: rootItem.activeChat = null
            }

            // Recipient avatar (photo with initials fallback)
            Rectangle {
                width: 38; height: 38; radius: 19
                color: rootItem.activeChat ? rootItem.avatarColor(rootItem.activeChat.name) : rootItem.colAccent

                PlasmaComponents.Label {
                    anchors.centerIn: parent
                    text: rootItem.activeChat ? (rootItem.activeChat.isGroup ? "👥" : rootItem.activeChat.name.charAt(0).toUpperCase()) : "?"
                    font.bold: !rootItem.activeChat || !rootItem.activeChat.isGroup
                    font.pointSize: rootItem.activeChat && rootItem.activeChat.isGroup ? 18 : 14
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
                    source: rootItem.activeChat ? rootItem.avatarSource(rootItem.activeChat.id) : ""
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
                    text: rootItem.activeChat ? rootItem.activeChat.name : ""
                    font.bold: true
                    font.pointSize: 11
                    color: rootItem.colText
                    elide: Text.ElideRight
                    Layout.fillWidth: true
                }
                // "Updating…" cue while a revalidate/poll is in
                // flight over an already-rendered list (MRU cache
                // hits must visibly refresh, never sit stale).
                PlasmaComponents.Label {
                    visible: rootItem.messagesInFlight && rootItem.activeChatMessages.length > 0
                    text: "Updating…"
                    font.pointSize: 7.5
                    color: rootItem.colSub
                }
                // Subtitle (JID/phone number) intentionally hidden —
                // the raw WhatsApp ID under the name was visual noise.
            }
        }
    }

    Rectangle { Layout.fillWidth: true; height: 1; color: rootItem.colBorder }

    // ── Message History: bare ListView with an attached
    // scrollbar. A ListView nested in a ScrollView fights it
    // for scrolling (stale contentY, dead atYEnd), so the
    // ListView itself is the scroller here.
    ListView {
        id: messageListView
        objectName: "messageListView"
        Layout.fillWidth: true
        Layout.fillHeight: true
        ScrollBar.vertical: ScrollBar {
            id: msgScrollBar
            objectName: "msgScrollBar"
            policy: ScrollBar.AsNeeded
            width: 8
            background: Item {}
            contentItem: PanelScrollHandle {
                visible: msgScrollBar.size < 1
                pressed: msgScrollBar.pressed
                color: rootItem.colSub
            }
        }
        Component.onCompleted: {
            rootItem.msgListViewRef = messageListView;
        }
        model: rootItem.activeChatMessages
            spacing: 4
            clip: true
            // NOTE: deliberately NO reuseItems here. This delegate's
            // height comes from chained implicitHeight bindings
            // (bubble → wrapping Text → anchored layouts), and the
            // model is a JS array that is replaced on every merge.
            // Item recycling keeps stale sizes/bindings and renders
            // overlapping, overflowing bubbles.

            // Always land on the most recent message — but only
            // when the user is already at (or near) the bottom AND
            // not mid-gesture, so background updates and temp-send
            // appends never yank the scroll position ("teleport").
            // swapInFlight must be excluded: during a model swap
            // contentHeight collapses to ~0, which flips atYEnd
            // true spuriously and would yank the view to the end
            // right over the anchor restore that follows.
            onCountChanged: {
                if (count > 0 && rootItem.isAtEnd(messageListView) && !rootItem.swapInFlight &&
                    !draggingVertically && !flickingVertically)
                    Qt.callLater(messageListView.positionViewAtEnd);
            }
            onWidthChanged: if (count > 0) Qt.callLater(messageListView.positionViewAtEnd);

            // Top-edge lazy loading: fetch 20 older messages when
            // the user scrolls to the very top. swapInFlight and
            // anchorHold must be excluded: during a model swap or
            // a scroll-restore settle the view can transiently sit
            // at contentY≈0, which would chain-load page after page
            // on every merge instead of on real user scrolls.
            onAtYBeginningChanged: {
                if (atYBeginning && rootItem.isAtBeginning(messageListView) && !rootItem.swapInFlight && !rootItem.anchorHold &&
                    rootItem.msgsHasMore && !rootItem.msgsLoadingOlder &&
                    rootItem.msgsTopError === "" && contentY < 200 &&
                    rootItem.activeChatMessages.length > 0) {
                    rootItem.fetchOlderMessages();
                }
            }

            header: Item {
                width: messageListView.width
                height: (rootItem.msgsLoadingOlder || rootItem.msgsTopError !== "") ? 36 : 0
                visible: height > 0

                PlasmaComponents.Label {
                    anchors.centerIn: parent
                    visible: rootItem.msgsLoadingOlder
                    text: "Loading older messages…"
                    color: rootItem.colSub
                    font.pointSize: 8
                }

                RowLayout {
                    anchors.centerIn: parent
                    spacing: 8
                    visible: rootItem.msgsTopError !== ""

                    PlasmaComponents.Label {
                        text: rootItem.msgsTopError
                        color: rootItem.colSub
                        font.pointSize: 8
                    }

                    PlasmaComponents.Label {
                        text: "↻ Retry"
                        color: rootItem.colAccent
                        font.pointSize: 8.5

                        MouseArea {
                            anchors.fill: parent
                            onClicked: rootItem.fetchOlderMessages()
                        }
                    }
                }
            }

            // Placeholder if loading messages
            PlasmaComponents.Label {
                anchors.centerIn: parent
                visible: rootItem.isLoadingMessages && rootItem.activeChatMessages.length === 0
                text: "Loading messages…"
                color: rootItem.colSub
                font.pointSize: 10
            }

            // Placeholder if no messages
            PlasmaComponents.Label {
                anchors.centerIn: parent
                visible: !rootItem.isLoadingMessages && rootItem.activeChatMessages.length === 0
                text: "No messages in this chat"
                color: rootItem.colSub
                font.pointSize: 10
            }

            delegate: Item {
                id: msgDelegateRoot
                width: messageListView.width
                // Use the column's full implicit height + padding for
                // the reaction button that overflows below the bubble.
                height: systemText !== ""
                        ? sysLabel.implicitHeight + 8
                        : msgBubbleCol.implicitHeight + 16

                // Media-with-caption plumbing. WhatsApp puts the
                // caption text in `body`; a photo/video/sticker
                // bubble must render that text BELOW the image
                // (previously the caption silently disappeared).
                property bool isVisualMedia: modelData.type === "image" || modelData.type === "sticker" || modelData.type === "video" || !!modelData.thumbUrl || (modelData.body && MsgUtils.isMediaBody(modelData.body))
                property string mediaCaption: {
                    if (!isVisualMedia) return "";
                    var cap = (typeof modelData.caption === "string" && modelData.caption)
                        || modelData.body || "";
                    if (typeof cap !== "string" || MsgUtils.isMediaBody(cap)) return "";
                    return cap;
                }

                // System / non-renderable rows (call logs, deleted
                // messages, group notices): without this branch the
                // bubble collapsed to a timestamp-only pill.
                property string systemText: MsgUtils.systemMessageText(modelData)

                // Test hooks for the agent test workflow (agent_test.sh).
                objectName: "msgBubbleDelegate"
                property string testMsgId: String(modelData.id || "")
                property bool   testHasCaption: msgCaption.visible && msgCaption.text !== ""
                property string testCaptionText: msgCaption.text
                property bool   testBodyVisible: msgText.visible
                property bool   testHasAudio: msgAudio.visible
                property string testAudioDuration: audioTimeLabel.text
                property int    testWaveBars: waveRow.barCount

                // Right-click a message -> context menu (Reply / Copy message)
                MouseArea {
                    anchors.fill: parent
                    acceptedButtons: Qt.RightButton
                    enabled: systemText === ""
                    onClicked: function(mouse) {
                        rootItem.contextReplyMsg = modelData;
                        rootItem.menus.msgContextMenu.popup(msgDelegateRoot, mouse.x, mouse.y);
                    }
                }

                ColumnLayout {
                    id: msgBubbleCol
                    anchors { left: parent.left; right: parent.right }
                    spacing: 0

                    // System / non-renderable message (call log,
                    // deleted message, group notice): centered gray
                    // text row instead of a chat bubble.
                    PlasmaComponents.Label {
                        id: sysLabel
                        visible: systemText !== ""
                        text: systemText
                        color: rootItem.colSub
                        font.pointSize: 8.5
                        wrapMode: Text.Wrap
                        horizontalAlignment: Text.AlignHCenter
                        Layout.alignment: Qt.AlignHCenter
                        Layout.maximumWidth: parent.width * 0.9
                    }

                    RowLayout {
                        id: bubbleRow
                        visible: systemText === ""
                        spacing: 8
                        layoutDirection: modelData.fromMe ? Qt.RightToLeft : Qt.LeftToRight

                        Item { width: 6 }

                        Rectangle {
                            id: msgBubble
                            width: {
                                var w = msgTime.implicitWidth + 30;
                                if (msgText.visible) {
                                    w = Math.max(w, msgText.implicitWidth + 20);
                                } else if (msgAudio.visible) {
                                    w = Math.max(w, Math.min(messageListView.width * 0.7, 250));
                                } else if (msgImage.visible || msgCaption.visible) {
                                    // Media bubble: at least image
                                    // width, scaled up to fit the
                                    // caption text.
                                    w = Math.max(w, Math.min(messageListView.width * 0.7, 240));
                                    if (msgCaption.visible) {
                                        w = Math.max(w, Math.min(msgCaption.implicitWidth + 20, messageListView.width * 0.7));
                                    }
                                }
                                return Math.min(messageListView.width * 0.75, w);
                            }
                            implicitHeight: msgCol.implicitHeight + 12
                            Layout.preferredHeight: implicitHeight
                            radius: 8
                            color: modelData.fromMe ? "#005c4b" : rootItem.colPanel
                            border.color: rootItem.colBorder
                            border.width: 1

                            ColumnLayout {
                                id: msgCol
                                anchors { fill: parent; margins: 8; topMargin: 6; bottomMargin: 6 }
                                spacing: 3

                                // Sender name (for groups)
                                PlasmaComponents.Label {
                                    visible: rootItem.activeChat && rootItem.activeChat.isGroup && !modelData.fromMe && modelData.senderName
                                    text: modelData.senderName || ""
                                    font.pointSize: 7.5
                                    font.bold: true
                                    color: rootItem.colGreen
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
                                        color: rootItem.colAccent
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
                                            color: rootItem.colAccent
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
                                            color: rootItem.colSub
                                            elide: Text.ElideRight
                                            wrapMode: Text.NoWrap
                                            Layout.fillWidth: true
                                            maximumLineCount: 1
                                        }
                                    }
                                }

                                // Message text - with emoji font support.
                                // Hidden for photo/video/sticker bubbles
                                // (their caption renders below the image)
                                // and when the body IS the media bytes.
                                Text {
                                    id: msgText
                                    visible: !msgDelegateRoot.isVisualMedia && !MsgUtils.isMediaBody(modelData.body) && !MsgUtils.isAudioMessage(modelData)
                                    text: modelData.body || ""
                                    color: rootItem.colText
                                    font.pointSize: 9.5
                                    font.family: rootItem.emojiFont
                                    wrapMode: Text.Wrap
                                    Layout.fillWidth: true
                                    renderType: Text.QtRendering
                                }

                                Image {
                                    id: msgImage
                                    visible: (!modelData._thumb || modelData.thumbUrl) && msgDelegateRoot.isVisualMedia
                                    source: {
                                        if (!visible) return "";
                                        return MsgUtils.mediaPreviewSource(modelData);
                                    }
                                    fillMode: Image.PreserveAspectFit
                                    Layout.maximumWidth: messageListView.width * 0.7
                                    Layout.preferredWidth: Math.min(messageListView.width * 0.7, 240)
                                    Layout.preferredHeight: Math.min(messageListView.width * 0.7, 180)
                                    asynchronous: true

                                    // Lazy 480p thumb: fetch once when the
                                    // delegate becomes visible.
                                    onVisibleChanged: {
                                        if (visible) rootItem.requestThumb(modelData);
                                    }
                                    Component.onCompleted: {
                                        if (visible) rootItem.requestThumb(modelData);
                                    }

                                    // Tap opens the image directly in
                                    // the system viewer (xdg-open);
                                    // video keeps the in-app viewer
                                    // with its "open on phone" note.
                                    MouseArea {
                                        anchors.fill: parent
                                        onClicked: {
                                            if (modelData.type === "video") {
                                                var list = MsgUtils.buildMediaList(rootItem.activeChatMessages);
                                                var idx = -1;
                                                for (var i = 0; i < list.length; i++) {
                                                    if (list[i].id === modelData.id) { idx = i; break; }
                                                }
                                                rootItem.openMediaViewer(idx);
                                                return;
                                            }
                                            rootItem.openExternallyMsg(modelData);
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
                                    color: rootItem.colSub
                                    Layout.maximumWidth: messageListView.width * 0.7
                                }

                                // Voice note / audio message. The
                                // Repeater aliases modelData (its
                                // own modelData is the bar index),
                                // so everything inside reads audioMsg.
                                ColumnLayout {
                                    id: msgAudio
                                    property var audioMsg: modelData
                                    visible: MsgUtils.isAudioMessage(modelData)
                                    Layout.fillWidth: true
                                    Layout.maximumWidth: messageListView.width * 0.7
                                    spacing: 4

                                    Component.onCompleted: { if (visible) rootItem.requestAudio(audioMsg); }
                                    onVisibleChanged: { if (visible) rootItem.requestAudio(audioMsg); }

                                    RowLayout {
                                        spacing: 8
                                        Layout.fillWidth: true

                                        Rectangle {
                                            width: 36; height: 36; radius: 18
                                            color: rootItem.colAccent
                                            Text {
                                                anchors.centerIn: parent
                                                text: String(rootItem.audioPlayingMsgId) === String(msgAudio.audioMsg.id) && rootItem.audioIsPlaying ? "❚❚" : "▶"
                                                color: "#ffffff"
                                                font.pointSize: 12
                                            }
                                            MouseArea {
                                                anchors.fill: parent
                                                onClicked: rootItem.toggleAudioPlayback(msgAudio.audioMsg)
                                            }
                                        }

                                        ColumnLayout {
                                            Layout.fillWidth: true
                                            spacing: 2

                                            Item {
                                                id: waveRow
                                                Layout.fillWidth: true
                                                Layout.preferredHeight: 30
                                                property int barCount: (msgAudio.audioMsg.waveform && msgAudio.audioMsg.waveform.length) || 0
                                                property real playedFrac: {
                                                    if (String(rootItem.audioPlayingMsgId) !== String(msgAudio.audioMsg.id)) return 0;
                                                    var d = audioPlayerRef.duration || 0;
                                                    if (d <= 0) return 0;
                                                    return Math.min(1, Math.max(0, rootItem.audioPositionMs / d));
                                                }
                                                Row {
                                                    anchors.fill: parent
                                                    spacing: 1
                                                    Repeater {
                                                        model: waveRow.barCount
                                                        Rectangle {
                                                            width: Math.max(1, (waveRow.width - Math.max(0, waveRow.barCount - 1)) / Math.max(1, waveRow.barCount))
                                                            height: {
                                                                var v = (msgAudio.audioMsg.waveform && msgAudio.audioMsg.waveform[index]) || 0;
                                                                return 4 + (Math.min(100, Math.max(0, v)) / 100) * (waveRow.height - 4);
                                                            }
                                                            y: (waveRow.height - height) / 2
                                                            color: (index / Math.max(1, waveRow.barCount)) < waveRow.playedFrac ? rootItem.colAccent : rootItem.colSub
                                                        }
                                                    }
                                                }
                                                MouseArea {
                                                    anchors.fill: parent
                                                    onClicked: function(mouse) {
                                                        if (waveRow.width > 0) rootItem.seekAudioFraction(mouse.x / waveRow.width, msgAudio.audioMsg.id);
                                                    }
                                                    onPositionChanged: function(mouse) {
                                                        if (pressed && waveRow.width > 0) rootItem.seekAudioFraction(mouse.x / waveRow.width, msgAudio.audioMsg.id);
                                                    }
                                                }
                                            }

                                            RowLayout {
                                                spacing: 6
                                                PlasmaComponents.Label {
                                                    id: audioTimeLabel
                                                    text: {
                                                        var total = MsgUtils.audioDuration(msgAudio.audioMsg);
                                                        if (String(rootItem.audioPlayingMsgId) === String(msgAudio.audioMsg.id)) {
                                                            if (total <= 0 && audioPlayerRef.duration > 0) total = Math.round(audioPlayerRef.duration / 1000);
                                                            var pos = Math.floor(rootItem.audioPositionMs / 1000);
                                                            if (rootItem.audioIsPlaying || pos > 0) return MsgUtils.formatDuration(pos) + " / " + MsgUtils.formatDuration(total);
                                                        }
                                                        return MsgUtils.formatDuration(total);
                                                    }
                                                    font.pointSize: 7.5
                                                    color: rootItem.colSub
                                                }
                                                Item { Layout.fillWidth: true; width: 1 }
                                                PlasmaComponents.Label {
                                                    text: rootItem.audioSpeedLabel()
                                                    font.pointSize: 7.5
                                                    font.bold: true
                                                    color: rootItem.colAccent
                                                    MouseArea {
                                                        anchors.fill: parent
                                                        onClicked: rootItem.cycleAudioSpeed()
                                                    }
                                                }
                                                PlasmaComponents.Label {
                                                    text: "⧉"
                                                    font.pointSize: 9
                                                    color: rootItem.colSub
                                                    MouseArea {
                                                        anchors.fill: parent
                                                        onClicked: rootItem.openExternallyMsg(msgAudio.audioMsg)
                                                    }
                                                }
                                            }

                                            PlasmaComponents.Label {
                                                visible: String(rootItem.audioErrorMsgId) === String(msgAudio.audioMsg.id) && rootItem.audioError !== ""
                                                text: rootItem.audioError
                                                font.pointSize: 7.5
                                                color: "#e06666"
                                                wrapMode: Text.Wrap
                                                Layout.fillWidth: true
                                            }
                                        }
                                    }
                                }

                                // Caption of a photo/video/sticker,
                                // rendered under the media like
                                // WhatsApp does. The bubble scales
                                // with it (see msgBubble.width).
                                PlasmaComponents.Label {
                                    id: msgCaption
                                    visible: msgDelegateRoot.mediaCaption !== ""
                                    text: msgDelegateRoot.mediaCaption
                                    color: rootItem.colText
                                    font.pointSize: 9.5
                                    font.family: rootItem.emojiFont
                                    wrapMode: Text.Wrap
                                    Layout.fillWidth: true
                                    renderType: Text.QtRendering
                                }

                                PlasmaComponents.Label {
                                    id: msgTime
                                    text: rootItem.formatTime(modelData.t)
                                    font.pointSize: 7
                                    color: rootItem.colSub
                                    Layout.alignment: Qt.AlignRight
                                }
                            }

                            // Reaction button (small emoji icon at bottom-right)
                            Rectangle {
                                id: reactionButton
                                anchors { bottom: parent.bottom; right: parent.right; bottomMargin: -8; rightMargin: -4 }
                                width: 22; height: 22; radius: 11
                                color: rootItem.colSurface
                                border.color: rootItem.colBorder
                                border.width: 1
                                z: 10

                                Text {
                                    anchors.centerIn: parent
                                    text: "😊"
                                    font.pointSize: 10
                                    font.family: rootItem.emojiFont
                                    renderType: Text.QtRendering
                                }

                                MouseArea {
                                    anchors.fill: parent
                                    onClicked: {
                                        rootItem.activeReactionMsgId = modelData.id || "";
                                        rootItem.emojiPickerVisible = true;
                                    }
                                }

                                // Only show when the message delegate list is interactive
                                // (hides when the emoji picker is open over it)
                                visible: !rootItem.emojiPickerVisible
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
                                color: modelData.fromMe ? rootItem.colAccentDim : (chipMouse.containsMouse ? rootItem.colBorder : rootItem.colPanel)
                                border.color: modelData.fromMe ? rootItem.colAccent : rootItem.colBorder
                                border.width: 1

                                Behavior on color { ColorAnimation { duration: 100 } }

                                RowLayout {
                                    id: reactContentRow
                                    anchors.centerIn: parent
                                    spacing: 3

                                    Text {
                                        text: modelData.emoji || ""
                                        font.pointSize: 10
                                        font.family: rootItem.emojiFont
                                        renderType: Text.QtRendering
                                    }

                                    PlasmaComponents.Label {
                                        visible: modelData.count > 1
                                        text: modelData.count
                                        font.pointSize: 7.5
                                        font.bold: true
                                        color: rootItem.colText
                                    }
                                }

                                PlasmaComponents.ToolTip.visible: chipMouse.containsMouse && modelData.senders && modelData.senders.length > 0
                                PlasmaComponents.ToolTip.text: modelData.senders ? modelData.senders.join(", ") : ""

                                MouseArea {
                                    id: chipMouse
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: {
                                        if (rootItem.activeChat && reactionsRow.parentMsgId) {
                                            rootItem.sendReaction(rootItem.activeChat.id, reactionsRow.parentMsgId, modelData.emoji, modelData.fromMe);
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

    Rectangle { Layout.fillWidth: true; height: 1; color: rootItem.colBorder }

    // ── Quick-reply chips ──────────────────────────
    Rectangle {
        Layout.fillWidth: true
        height: 42
        color: rootItem.colSurface

        RowLayout {
            anchors { fill: parent; leftMargin: 10; rightMargin: 10 }
            spacing: 6

            Repeater {
                model: ["👍 OK", "😊 Thanks", "On my way!", "Running late", "Call me?"]

                Rectangle {
                    height: 26
                    width: chipLabel.implicitWidth + 16
                    radius: 13
                    color: chipMouse.containsMouse ? rootItem.colAccentDim : rootItem.colPanel
                    border.color: rootItem.colBorder
                    border.width: 1

                    Behavior on color { ColorAnimation { duration: 120 } }

                    PlasmaComponents.Label {
                        id: chipLabel
                        anchors.centerIn: parent
                        text: modelData
                        font.pointSize: 8
                        color: rootItem.colText
                    }

                    MouseArea {
                        id: chipMouse
                        anchors.fill: parent
                        hoverEnabled: true
                        onClicked: {
                            var snippet = modelData.replace(/^[^\s]+\s/, ""); // strip emoji prefix
                            if (modelData.charAt(0) === "👍" || modelData.charAt(0) === "😊")
                                sendBar.messageInput.text += modelData.split(" ")[0] + " ";
                            else
                                sendBar.messageInput.text += modelData + " ";
                            sendBar.messageInput.forceActiveFocus();
                        }
                    }
                }
            }
        }
    }

    Rectangle { Layout.fillWidth: true; height: 1; color: rootItem.colBorder }

    // ── Message Input area (SendMessageBar.qml) ──────────────────
    // NOTE: `rootItem: messagesPanel.rootItem` (not bare `root` — there is
    // no `root` id in this file; and `rootItem: rootItem` would self-resolve
    // to SendMessageBar's own property, the Slice-4 binding-loop trap).
    SendMessageBar {
        id: sendBar
        rootItem: messagesPanel.rootItem
    }
}
