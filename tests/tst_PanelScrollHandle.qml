import QtQuick
import QtQuick.Controls
import QtTest
import "../widget/contents/ui"

// Covers the shared scrollbar handle (PanelScrollHandle.qml) and the way the
// panel list views wire it in: a bare ListView with an attached vertical
// ScrollBar whose contentItem is that handle.
Item {
    id: root

    width: 400
    height: 400

    Component {
        id: handleComponent

        PanelScrollHandle {}
    }

    Component {
        id: listComponent

        ListView {
            id: list

            width: 300
            height: 200
            model: 40
            delegate: Item {
                width: 300
                height: 40
            }

            ScrollBar.vertical: ScrollBar {
                id: bar

                objectName: "testScrollBar"
                policy: ScrollBar.AsNeeded
                width: 8
                background: Item {}
                contentItem: PanelScrollHandle {
                    visible: bar.size < 1
                    pressed: bar.pressed
                    color: "#8696a0"
                }
            }
        }
    }

    TestCase {
        name: "PanelScrollHandle"
        when: windowShown

        function test_pressedBrightensHandle() {
            let handle = createTemporaryObject(handleComponent, root)
            verify(!!handle, "Component exists")
            compare(handle.opacity, 0.55)
            handle.pressed = true
            tryCompare(handle, "opacity", 0.95)
            handle.pressed = false
            tryCompare(handle, "opacity", 0.55)
        }

        function test_scrollBarShowsStyledHandleWhenContentOverflows() {
            let list = createTemporaryObject(listComponent, root)
            verify(!!list, "Component exists")
            let bar = findChild(list, "testScrollBar")
            verify(!!bar, "Object exists")
            tryCompare(bar, "size", 0.125)
            tryCompare(bar.contentItem, "visible", true)
            compare(bar.width, 8)
            compare(bar.contentItem.radius, 3)
            compare(bar.contentItem.color, "#8696a0")
        }

        function test_scrollBarHidesHandleWhenContentFits() {
            let list = createTemporaryObject(listComponent, root)
            verify(!!list, "Component exists")
            let bar = findChild(list, "testScrollBar")
            verify(!!bar, "Object exists")
            list.model = 2
            tryCompare(bar, "size", 1)
            tryCompare(bar.contentItem, "visible", false)
        }
    }
}
