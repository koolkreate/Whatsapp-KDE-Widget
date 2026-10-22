// Menus.qml — right-click context menus for messages and chat-list rows.
// Instantiated by main.qml as a root child; both popups are exposed through
// aliases so delegate code can call `rootItem.menus.<popup>.popup(...)`.
// (Root is an Item: QtObject has no default property in Qt 6.)
import QtQuick
import QtQuick.Controls
import org.kde.plasma.plasmoid

Item {
    id: menus
    // Named rootItem (not root): `rootItem: root` at the instance site must
    // not self-resolve — a property named `root` would shadow the outer id.
    required property PlasmoidItem rootItem

    readonly property alias msgContextMenu: msgCtxMenu
    readonly property alias chatContextMenu: chatCtxMenu

    // Right-click context menu for messages
    Menu {
        id: msgCtxMenu
        title: "Message"

        MenuItem {
            text: "Reply"
            icon.name: "mail-reply-sender"
            onClicked: rootItem.startReplyFromContext()
        }
        MenuItem {
            text: "Copy message"
            icon.name: "edit-copy"
            onClicked: rootItem.copyContextMessage()
        }
    }

    // Right-click context menu for chat list rows
    Menu {
        id: chatCtxMenu
        title: "Chat"

        MenuItem {
            text: (rootItem.contextChat && rootItem.isChatPinned(rootItem.contextChat)) ? "Unpin Chat" : "Pin Chat"
            icon.name: "bookmark-new"
            onClicked: {
                if (rootItem.contextChat) {
                    rootItem.togglePinChat(rootItem.contextChat.id);
                }
            }
        }
        MenuItem {
            text: (rootItem.contextChat && rootItem.isChatArchived(rootItem.contextChat)) ? "Unarchive Chat" : "Archive Chat"
            icon.name: (rootItem.contextChat && rootItem.isChatArchived(rootItem.contextChat)) ? "archive-extract" : "archive-insert"
            onClicked: {
                if (rootItem.contextChat) {
                    rootItem.setChatArchived(rootItem.contextChat.id, !rootItem.isChatArchived(rootItem.contextChat));
                }
            }
        }
    }
}

