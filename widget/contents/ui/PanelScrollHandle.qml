// PanelScrollHandle.qml — visible scrollbar handle shared by the bare
// ListViews in MessagesPanel.qml and ChatListPanel.qml. Breeze's default
// handle is a dark grey that disappears against the chat background, so both
// lists style the handle explicitly: 6 px, rounded, palette grey, brighter
// while dragged. `color` is fed from the call site (rootItem.colSub) so the
// palette stays owned by the root.
import QtQuick

Rectangle {
    id: handle

    property bool pressed: false

    implicitWidth: 6
    radius: 3
    opacity: pressed ? 0.95 : 0.55
}
