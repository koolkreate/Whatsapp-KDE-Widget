// ContextMenuButtons.qml — hidden clipboard helper used by the context-menu
// "Copy message" action. Instantiated by main.qml as a root child; the
// TextEdit is exposed to root code through the `clipEdit` alias.
// (Root is an Item, not QtObject: QtObject has no default property in Qt 6,
//  so it cannot host the TextEdit child.)
import QtQuick
import org.kde.plasma.plasmoid

Item {
    id: contextMenuButtons
    required property PlasmoidItem root

    readonly property alias clipEdit: clipTextEdit

    // Pure-QML clipboard helper (TextEdit.selectAll + copy)
    TextEdit {
        id: clipTextEdit
        visible: false
        width: 0; height: 0
    }
}


