// Menus.qml — right-click context menus for messages and chat-list rows.
// Instantiated by main.qml as a root child; both popups are exposed through
// aliases so delegate code can call `root.menus.<popup>.popup(...)`.
// (Root is an Item: QtObject has no default property in Qt 6.)
import QtQuick
import QtQuick.Controls
import org.kde.plasma.plasmoid

Item {
    id: menus
    required property PlasmoidItem root

    readonly property alias msgContextMenu: msgCtxMenu
    readonly property alias chatContextMenu: chatCtxMenu

    // Right-click context menu for messages
    Menu {
        id: msgCtxMenu
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
        id: chatCtxMenu
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
}

