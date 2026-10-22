// SendMessageBar.qml — message compose area: "Replying to…" quote bar,
// pasted-image draft chip, voice-note bar, and the message row (emoji /
// attach / mic buttons, input box, send button) plus the hint text.
// Instantiated by main.qml as `SendMessageBar { id: sendBar; rootItem: root }`; other files
// reach the input and the picker as `rootItem.messageInput` /
// `rootItem.attachmentDialog` (one-hop aliases on the PlasmoidItem).
// (Root is the input Rectangle itself — not a wrapping Item — so the parent
//  ColumnLayout keeps sizing it verbatim via Layout.fillWidth + height,
//  exactly as when the block was inline. The recording blink timer stays in
//  main.qml beside the voice-note state it drives; each tick flips the root
//  `recDotLit` state that the recording dot below binds its opacity to.)
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
import "messageUtils.js" as MsgUtils

Rectangle {
    id: sendMessageBar
    // Named rootItem (not root): `rootItem: root` at the instance site must
    // not self-resolve — a property named `root` would shadow the outer id.
    required property PlasmoidItem rootItem

    readonly property alias messageInput: messageField
    readonly property alias attachmentDialog: fileDialog

    Layout.fillWidth: true
    height: (rootItem.pendingReplyId !== "" || rootItem.pendingAttachmentPath !== "") ? 92 : 70
    color: rootItem.colHeader

    // Attachment picker. `selectedFile` is the dialog's own property, so
    // onAccepted keeps working after the move.
    FileDialog {
        id: fileDialog
        title: "Select an attachment"
        nameFilters: [
            "Images and Media (*.png *.jpg *.jpeg *.webp *.gif *.bmp *.mp4 *.mov *.avi)",
            "All Files (*)"
        ]
        onAccepted: {
            if (rootItem.activeChat && selectedFile) {
                rootItem.sendFile(rootItem.activeChat.id, selectedFile.toString());
            }
        }
    }

    ColumnLayout {
        anchors { fill: parent; leftMargin: 10; rightMargin: 10; topMargin: 8; bottomMargin: 8 }
        spacing: 4

        // ── "Replying to…" quote bar ──────────────────────────
        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            visible: rootItem.pendingReplyId !== ""

            Rectangle {
                width: 3; height: 30; radius: 1.5
                color: rootItem.colAccent
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0

                PlasmaComponents.Label {
                    text: "Replying to"
                    font.pointSize: 7
                    font.bold: true
                    color: rootItem.colAccent
                }
                PlasmaComponents.Label {
                    text: rootItem.replyPreviewLabel
                    font.pointSize: 8
                    color: rootItem.colSub
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
                onClicked: rootItem.clearPendingReply()
            }
        }

        // ── Pasted-image draft chip (not sent until send is pressed) ──
        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            visible: rootItem.pendingAttachmentPath !== ""

            Rectangle {
                width: 3; height: 26; radius: 1.5
                color: rootItem.colAccent
            }

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: "📷 Image attached — press send to deliver"
                font.pointSize: 8
                color: rootItem.colText
                elide: Text.ElideRight
            }

            PlasmaComponents.ToolButton {
                Layout.preferredWidth: 24
                Layout.preferredHeight: 24
                text: "✕"
                ToolTip.text: "Remove attachment"
                ToolTip.visible: hovered
                onClicked: rootItem.clearPendingAttachment()
            }
        }

        // Voice-note bar: recording timer or draft
        // confirm. Replaces nothing — it stacks above the
        // message row while active.
        Rectangle {
            visible: rootItem.voiceState !== "" || rootItem.voiceError !== ""
            Layout.fillWidth: true
            height: visible ? 40 : 0
            color: rootItem.colPanel
            radius: 8
            border.color: rootItem.voiceState === "recording" ? "#c0392b" : rootItem.colBorder
            border.width: 1

            RowLayout {
                anchors { fill: parent; leftMargin: 12; rightMargin: 8 }
                spacing: 8

                Rectangle {
                    id: recordingDot
                    width: 10; height: 10; radius: 5
                    color: "#e74c3c"
                    visible: rootItem.voiceState === "recording"
                    // Blink phase comes from root state: root-level code cannot
                    // reach this dot by id (separate unit — see main.qml note).
                    opacity: rootItem.recDotLit ? 1.0 : 0.25
                }

                PlasmaComponents.Label {
                    text: {
                        if (rootItem.voiceError !== "") return rootItem.voiceError;
                        if (rootItem.voiceState === "recording") return "Recording " + MsgUtils.formatDuration(rootItem.voiceSecs);
                        if (rootItem.voiceState === "draft") return "Voice note " + MsgUtils.formatDuration(rootItem.voiceSecs);
                        return "";
                    }
                    font.pointSize: 9
                    font.bold: rootItem.voiceState === "recording"
                    color: rootItem.voiceError !== "" ? "#e06666" : rootItem.colText
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                }

                PlasmaComponents.ToolButton {
                    visible: rootItem.voiceState === "draft"
                    icon.name: "media-playback-start"
                    display: PlasmaComponents.ToolButton.IconOnly
                    ToolTip.text: "Play draft"
                    ToolTip.visible: hovered
                    onClicked: rootItem.playVoiceDraft()
                }

                PlasmaComponents.ToolButton {
                    visible: rootItem.voiceState !== ""
                    icon.name: "edit-delete"
                    display: PlasmaComponents.ToolButton.IconOnly
                    ToolTip.text: "Discard"
                    ToolTip.visible: hovered
                    onClicked: rootItem.discardVoiceNote()
                }

                Rectangle {
                    visible: rootItem.voiceState === "draft"
                    width: 36; height: 36; radius: 18
                    color: rootItem.colAccent
                    Text {
                        anchors.centerIn: parent
                        text: "➤"
                        color: "#ffffff"
                        font.pointSize: 12
                    }
                    MouseArea {
                        anchors.fill: parent
                        onClicked: rootItem.sendVoiceNote()
                    }
                }
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
                    if (rootItem.emojiPickerVisible && rootItem.activeReactionMsgId === "") {
                        rootItem.emojiPickerVisible = false;
                    } else {
                        rootItem.activeReactionMsgId = "";
                        rootItem.emojiPickerVisible = true;
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

            // Voice-note button: same circular language as
            // the bubble play button; red only while recording.
            Rectangle {
                id: micButton
                width: 36; height: 36; radius: 18
                color: rootItem.voiceState === "recording" ? "#c0392b" : rootItem.colPanel
                border.color: rootItem.colBorder
                border.width: 1
                opacity: !rootItem.activeChat ? 0.4 : 1.0
                Behavior on color { ColorAnimation { duration: 150 } }
                Text {
                    anchors.centerIn: parent
                    text: rootItem.voiceState === "recording" ? "■" : "🎙"
                    font.pointSize: rootItem.voiceState === "recording" ? 11 : 15
                }
                ToolTip.text: rootItem.voiceState === "recording" ? "Stop recording" : "Record voice note"
                ToolTip.visible: micMouse.containsMouse
                MouseArea {
                    id: micMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: rootItem.toggleVoiceNote()
                }
            }

            // Input text box
            Rectangle {
                Layout.fillWidth: true
                height: 36
                color: rootItem.colPanel
                border.color: messageField.activeFocus ? rootItem.colAccent : rootItem.colBorder
                border.width: messageField.activeFocus ? 1.5 : 1
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
                        contentHeight: messageField.implicitHeight
                        flickableDirection: Flickable.VerticalFlick
                        boundsBehavior: Flickable.StopAtBounds

                        // Helper: keep the cursor rectangle visible
                        function ensureCursorVisible() {
                            var r = messageField.cursorRectangle;
                            // Vertical
                            if (r.y < flick.contentY)
                                flick.contentY = r.y;
                            else if (r.y + r.height > flick.contentY + flick.height)
                                flick.contentY = r.y + r.height - flick.height;
                        }

                        TextEdit {
                            id: messageField
                            Component.onCompleted: rootItem.messageInputRef = messageField
                            width: flick.width
                            wrapMode: TextEdit.Wrap
                            color: rootItem.colText
                            font.pointSize: 9.5
                            font.family: rootItem.emojiFont
                            selectionColor: rootItem.colAccent
                            focus: true

                            // Auto-scroll the Flickable whenever the cursor moves
                            onCursorRectangleChanged: flick.ensureCursorVisible()

                            Text {
                                anchors.fill: parent
                                text: "Type a message…"
                                color: rootItem.colSub
                                font: parent.font
                                visible: parent.text.length === 0
                            }

                            Keys.onReturnPressed: function(event) {
                                event.accepted = true;
                                if (event.modifiers & Qt.ShiftModifier) {
                                    messageField.insert(messageField.cursorPosition, "\n");
                                } else {
                                    rootItem.sendComposed();
                                }
                            }


                            Keys.onPressed: function(event) {
                                if (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)) {
                                    if (event.modifiers & Qt.ShiftModifier) {
                                        event.accepted = true;
                                        rootItem.pasteImageFromClipboard();
                                    } else {
                                        var hadSelection = messageField.selectedText.length > 0;
                                        var oldLen = messageField.text.length;
                                        messageField.paste();
                                        if (!hadSelection && messageField.text.length === oldLen) {
                                            // No text was inserted by Qt paste, check if clipboard contains an image
                                            rootItem.pasteImageFromClipboard();
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
                    if (sendMouseArea.containsMouse && (messageField.text.trim().length > 0 || rootItem.pendingAttachmentPath !== "") && !rootItem.sendInFlight) return rootItem.colAccentDim;
                    return rootItem.colAccent;
                }
                opacity: ((messageField.text.trim().length === 0 && rootItem.pendingAttachmentPath === "") || rootItem.sendInFlight) ? 0.5 : 1.0

                Behavior on color { ColorAnimation { duration: 150 } }

                PlasmaComponents.Label {
                    anchors.centerIn: parent
                    text: rootItem.sendInFlight ? "⏳" : "➤"
                    color: "#ffffff"
                    font.pointSize: 12
                }

                MouseArea {
                    id: sendMouseArea
                    anchors.fill: parent
                    hoverEnabled: true
                    onClicked: {
                        rootItem.sendComposed();
                    }
                }
            }
        }

        // Hint text
        PlasmaComponents.Label {
            text: "Shift+Enter for new line"
            font.pointSize: 7
            color: rootItem.colSub
            Layout.alignment: Qt.AlignHCenter
        }
    }
}
