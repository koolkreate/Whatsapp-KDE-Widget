// ChatListPanel.qml — Page-1 chat list: header bar (logo, refresh/restart),
// search box (debounced via the root `searchDebounceTimer`), chat-rows
// ListView (`objectName: "chatListView"`, found by testDriver.js), empty state.
// Instantiated by main.qml as `ChatListPanel { rootItem: root }`.
// (Root is the ColumnLayout itself — not a wrapping Item — so the parent
//  StackLayout sizes it verbatim, exactly as when the block was inline.
//  The debounce timer stays in main.qml at root level; the search field
//  reaches it as `rootItem.searchDebounceTimer.restart()`.)
import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import QtQuick.Controls
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents

ColumnLayout {
    // Named rootItem (not root): `rootItem: root` at the instance site must
    // not self-resolve — a property named `root` would shadow the outer id.
    required property PlasmoidItem rootItem

    spacing: 0

    // ── Header bar ─────────────────────────────────
    Rectangle {
        Layout.fillWidth: true
        height: 56
        color: rootItem.colHeader

        RowLayout {
            anchors { fill: parent; leftMargin: 14; rightMargin: 10; topMargin: 8; bottomMargin: 8 }
            spacing: 10

            // WA logo
            Rectangle {
                width: 36; height: 36; radius: 18
                color: rootItem.colAccent

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
                color: rootItem.colText
                Layout.fillWidth: true
            }

            // Loading spinner (small)
            Rectangle {
                visible: rootItem.isLoading
                width: 20; height: 20; radius: 10
                color: "transparent"
                border.color: rootItem.colAccent
                border.width: 2
                RotationAnimation on rotation {
                    from: 0; to: 360; duration: 1000
                    loops: Animation.Infinite; running: rootItem.isLoading
                }
            }

            // Archive view toggle: in the normal view jumps to the archived
            // chats list (enabled once anything is archived); in the archived
            // view goes back. Always visible.
            PlasmaComponents.ToolButton {
                icon.name: rootItem.showArchived ? "go-previous" : "archive-insert"
                display: PlasmaComponents.ToolButton.IconOnly
                ToolTip.text: rootItem.showArchived
                    ? "Back to chats"
                    : "Archived chats (" + rootItem.archivedChats.length + ")"
                ToolTip.visible: hovered
                enabled: rootItem.showArchived || rootItem.archivedChats.length > 0
                onClicked: {
                    searchBar.text = "";
                    rootItem.toggleArchivedView();
                }
            }

            PlasmaComponents.ToolButton {
                icon.name: "view-refresh"
                display: PlasmaComponents.ToolButton.IconOnly
                ToolTip.text: "Refresh chats"
                ToolTip.visible: hovered
                onClicked: rootItem.fetchChats()
            }

            PlasmaComponents.ToolButton {
                icon.name: "system-reboot"
                display: PlasmaComponents.ToolButton.IconOnly
                ToolTip.text: "Restart WhatsApp Connection"
                ToolTip.visible: hovered
                onClicked: rootItem.restartBackend()
            }
        }
    }

    // ── Search box ─────────────────────────────────
    Rectangle {
        Layout.fillWidth: true
        height: 44
        color: rootItem.colPanel

        RowLayout {
            anchors { fill: parent; leftMargin: 10; rightMargin: 10 }
            spacing: 6

            PlasmaComponents.Label { text: "🔍"; font.pointSize: 11 }

            PlasmaComponents.TextField {
                id: searchBar
                placeholderText: rootItem.showArchived ? "Search archived…" : "Search name or number…"
                Layout.fillWidth: true
                color: rootItem.colText
                background: Item {}
                onTextChanged: { rootItem.searchQuery = text; rootItem.restartSearchDebounce(); }
            }

            PlasmaComponents.ToolButton {
                icon.name: "edit-clear"
                visible: searchBar.text.length > 0
                display: PlasmaComponents.ToolButton.IconOnly
                onClicked: { searchBar.text = ""; rootItem.searchQuery = ""; rootItem.filterChats(); }
            }
        }
    }

    // ── Archived-view banner (only while browsing archived chats) ─────
    Rectangle {
        Layout.fillWidth: true
        height: 32
        color: rootItem.colPanel
        visible: rootItem.showArchived

        RowLayout {
            anchors { fill: parent; leftMargin: 14; rightMargin: 6 }
            spacing: 6

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: "📦 Archived chats (" + rootItem.archivedChats.length + ")"
                font.pointSize: 10
                color: rootItem.colText
                elide: Text.ElideRight
            }

            PlasmaComponents.ToolButton {
                text: "Back to chats"
                display: PlasmaComponents.ToolButton.TextOnly
                font.pointSize: 9
                ToolTip.text: "Back to chats"
                ToolTip.visible: hovered
                onClicked: {
                    searchBar.text = "";
                    rootItem.toggleArchivedView();
                }
            }
        }
    }

    // ── Separator ──────────────────────────────────
    Rectangle { Layout.fillWidth: true; height: 1; color: rootItem.colBorder }

    // ── Chat list: bare ListView with an attached scrollbar,
    // same reason as the message history below — the ListView
    // itself must own contentY/atYEnd.
    ListView {
        id: chatListView
        objectName: "chatListView"
        Layout.fillWidth: true
        Layout.fillHeight: true
        clip: true
        ScrollBar.vertical: ScrollBar {
            id: chatScrollBar
            objectName: "chatScrollBar"
            policy: ScrollBar.AsNeeded
            width: 8
            background: Item {}
            contentItem: PanelScrollHandle {
                visible: chatScrollBar.size < 1
                pressed: chatScrollBar.pressed
                color: rootItem.colSub
            }
        }
        model: rootItem.filteredChats.slice(0, rootItem.chatsShown)
            spacing: 0
            // NOTE: deliberately NO reuseItems here (same lesson
            // as messageListView below). The model is a JS array
            // that is replaced on every refresh, and recycling
            // keeps stale bindings — rendering ghosted,
            // double-painted titles/timestamps in chat rows.

            // Infinite scroll: grow the window when the user hits
            // the bottom of the rendered chats.
            onAtYEndChanged: {
                if (atYEnd && rootItem.filteredChats.length > rootItem.chatsShown) {
                    rootItem.chatsShown += 20;
                }
            }

            // Empty state
            PlasmaComponents.Label {
                anchors.centerIn: parent
                visible: rootItem.filteredChats.length === 0 && !rootItem.isLoading
                text: {
                    var base = rootItem.searchQuery
                        ? "No results for \"" + rootItem.searchQuery + "\""
                        : (rootItem.showArchived ? "No archived chats" : "No chats found");
                    if (rootItem.showArchived && !rootItem.searchQuery && rootItem.isConnected) {
                        base += "\nArchive a chat from your main chat list.";
                    }
                    return base;
                }
                color: rootItem.colSub
                font.pointSize: 10
            }

            delegate: Rectangle {
                id: chatRow
                width: chatListView.width
                height: 68
                color: hovered ? rootItem.colPanel : "transparent"

                property bool hovered: false
                MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton | Qt.RightButton
                    onEntered: chatRow.hovered = true
                    onExited:  chatRow.hovered = false
                    onClicked: function(mouse) {
                        if (mouse.button === Qt.RightButton) {
                            rootItem.contextChat = modelData;
                            rootItem.menus.chatContextMenu.popup(chatRow, mouse.x, mouse.y);
                        } else {
                            rootItem.activeChat = {
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
                        color: rootItem.avatarColor(modelData.name || modelData.formattedTitle || "")

                        PlasmaComponents.Label {
                            anchors.centerIn: parent
                            text: modelData.isGroup ? "👥" : rootItem.chatInitial(modelData)
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
                            source: rootItem.avatarSource(modelData.id)
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
                            color: rootItem.colGreen
                            border.color: rootItem.colBg
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
                                visible: rootItem.isChatPinned(modelData)
                                text: "📌"
                                font.pointSize: 8
                            }

                            PlasmaComponents.Label {
                                visible: rootItem.isChatArchived(modelData)
                                text: "📦"
                                font.pointSize: 8
                            }

                            PlasmaComponents.Label {
                                text: modelData.name || modelData.formattedTitle || "Unknown"
                                font.bold: true
                                font.pointSize: 10
                                color: rootItem.colText
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }

                            PlasmaComponents.Label {
                                text: rootItem.formatTime(modelData.t || (modelData.lastMessage && modelData.lastMessage.t) || 0)
                                font.pointSize: 8
                                color: (modelData.unreadCount || 0) > 0 ? rootItem.colGreen : rootItem.colSub
                            }
                        }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 4

                            PlasmaComponents.Label {
                                text: rootItem.lastPreview(modelData)
                                font.pointSize: 8.5
                                color: rootItem.colSub
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
                                color:  rootItem.colGreen

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
                    color: rootItem.colBorder
                    opacity: 0.5
                }
            }
    }
}
