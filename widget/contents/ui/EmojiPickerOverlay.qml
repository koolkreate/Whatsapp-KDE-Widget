// EmojiPickerOverlay.qml — fullscreen emoji overlay: tap-outside dismiss,
// quick-reaction row, category tabs, scrolling emoji grid.
// Instantiated by main.qml as `EmojiPickerOverlay { anchors.fill: parent;
// rootItem: root }`. Visibility and mode are root state (`rootItem.emojiPickerVisible`,
// `rootItem.activeReactionMsgId`); the grid reads `rootItem.emojiList`.
// (Root is a wrapping Item: the overlay Rectangle keeps `anchors.fill: parent`
//  against it, and the instance anchors to the same parent as when inline.
//  Insert-mode writes go through `rootItem.messageInputRef` — the `sendBar` id is
//  in main.qml's unit and not visible here. `rootItem.selectedEmojiCategory` is
//  read/assigned but never declared (pre-existing; preserved verbatim).)
import QtQuick
import QtQuick.Layouts
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents

Item {
    id: emojiPickerOverlay
    // Named rootItem (not root): `rootItem: root` at the instance site must
    // not self-resolve — a property named `root` would shadow the outer id.
    required property PlasmoidItem rootItem

    Rectangle {
        visible: rootItem.emojiPickerVisible
        anchors.fill: parent
        color: "#00000000"

        // Tap outside to dismiss
        MouseArea {
            anchors.fill: parent
            onClicked: {
                rootItem.emojiPickerVisible = false;
                rootItem.activeReactionMsgId = "";
            }
        }

        Rectangle {
            anchors { bottom: parent.bottom; left: parent.left; right: parent.right }
            height: 200
            color: rootItem.colPanel
            border.color: rootItem.colBorder
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                spacing: 0

                // Quick reaction row
                Rectangle {
                    Layout.fillWidth: true
                    height: 50
                    color: rootItem.colHeader

                    RowLayout {
                        anchors.centerIn: parent
                        spacing: 8

                        Repeater {
                            model: ["👍", "❤️", "😂", "😮", "😢", "🙏"]
                            Rectangle {
                                width: 36; height: 36; radius: 18
                                color: emojiHover.containsMouse ? rootItem.colAccentDim : rootItem.colSurface
                                border.color: rootItem.colBorder
                                border.width: 1

                                Behavior on color { ColorAnimation { duration: 100 } }

                                Text {
                                    anchors.centerIn: parent
                                    text: modelData
                                    font.pointSize: 18
                                    font.family: rootItem.emojiFont
                                    renderType: Text.QtRendering
                                }

                                MouseArea {
                                    id: emojiHover
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: {
                                        if (rootItem.activeReactionMsgId && rootItem.activeChat) {
                                            rootItem.sendReaction(rootItem.activeChat.id, rootItem.activeReactionMsgId, modelData);
                                        } else if (!rootItem.activeReactionMsgId) {
                                            // Insert mode - add emoji to message text
                                            rootItem.messageInputRef.text += modelData;
                                            rootItem.messageInputRef.forceActiveFocus();
                                        }
                                        rootItem.emojiPickerVisible = false;
                                        rootItem.activeReactionMsgId = "";
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
                    color: rootItem.colSurface

                    RowLayout {
                        anchors { fill: parent; leftMargin: 6; rightMargin: 6 }
                        spacing: 2

                        Repeater {
                            model: ["⭐", "😀", "👋", "🐶", "🍎", "🚗", "⚽", "💡"]
                            Rectangle {
                                height: 26
                                width: 32
                                radius: 4
                                color: index === rootItem.selectedEmojiCategory ? rootItem.colAccentDim : (catHover.containsMouse ? rootItem.colPanel : "transparent")
                                border.color: index === rootItem.selectedEmojiCategory ? rootItem.colAccent : "transparent"
                                border.width: 1

                                Text {
                                    anchors.centerIn: parent
                                    text: modelData
                                    font.pointSize: 12
                                    font.family: rootItem.emojiFont
                                    renderType: Text.QtRendering
                                }

                                MouseArea {
                                    id: catHover
                                    anchors.fill: parent
                                    hoverEnabled: true
                                    onClicked: rootItem.selectedEmojiCategory = index
                                }
                            }
                        }
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: rootItem.colBorder }

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
                            if (rootItem.selectedEmojiCategory === 0) return rootItem.emojiList;
                            if (rootItem.selectedEmojiCategory === 1) return rootItem.emojiList.slice(0, 80);
                            if (rootItem.selectedEmojiCategory === 2) return rootItem.emojiList.slice(80, 160);
                            if (rootItem.selectedEmojiCategory === 3) return rootItem.emojiList.slice(220, 310);
                            if (rootItem.selectedEmojiCategory === 4) return rootItem.emojiList.slice(310, 410);
                            if (rootItem.selectedEmojiCategory === 5) return rootItem.emojiList.slice(410, 500);
                            if (rootItem.selectedEmojiCategory === 6) return rootItem.emojiList.slice(500, 563);
                            if (rootItem.selectedEmojiCategory === 7) return rootItem.emojiList.slice(563);
                            return rootItem.emojiList;
                        }

                        delegate: Rectangle {
                            width: 36; height: 36
                            color: emojiItemHover.containsMouse ? rootItem.colAccentDim : "transparent"
                            radius: 4

                            Behavior on color { ColorAnimation { duration: 80 } }

                            Text {
                                anchors.centerIn: parent
                                text: modelData
                                font.pointSize: 16
                                font.family: rootItem.emojiFont
                                renderType: Text.QtRendering
                            }

                            MouseArea {
                                id: emojiItemHover
                                anchors.fill: parent
                                hoverEnabled: true
                                onClicked: {
                                    if (rootItem.activeReactionMsgId && rootItem.activeChat) {
                                        rootItem.sendReaction(rootItem.activeChat.id, rootItem.activeReactionMsgId, modelData);
                                    } else if (!rootItem.activeReactionMsgId) {
                                        // Insert mode - add emoji to message text
                                        rootItem.messageInputRef.text += modelData;
                                        rootItem.messageInputRef.forceActiveFocus();
                                    }
                                    rootItem.emojiPickerVisible = false;
                                    rootItem.activeReactionMsgId = "";
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
