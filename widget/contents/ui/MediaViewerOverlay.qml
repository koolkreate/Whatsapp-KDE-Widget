// MediaViewerOverlay.qml — fullscreen media viewer: pinch-zoom/pan stage for
// images and stickers with prev/next navigation, counter header, footer label.
// Instantiated by main.qml as `MediaViewerOverlay { anchors.fill: parent;
// rootItem: root }`. Visibility and media state live on root
// (`rootItem.viewerVisible/mediaList/mediaIndex/viewerFull*`); navigation and
// fetching stay root functions (`rootItem.viewerStep/closeMediaViewer/
// openExternallyCurrent`). (Root is the viewer Rectangle itself — not a
// wrapping Item — so `anchors.fill: parent`, `z: 100`, `focus` and the
// `objectName: "mediaViewer"` (found by testDriver.js) carry over verbatim.
// NOTE: QtMultimedia is not available in this plasmoid sandbox (Slice 0
// spike), so video messages render their base64 preview enlarged with an
// "open on phone" note instead of inline playback.)
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import org.kde.plasma.plasmoid
import org.kde.plasma.components 3.0 as PlasmaComponents
import "messageUtils.js" as MsgUtils

Rectangle {
    id: mediaViewer
    // Named rootItem (not root): `rootItem: root` at the instance site must
    // not self-resolve — a property named `root` would shadow the outer id.
    required property PlasmoidItem rootItem

    objectName: "mediaViewer"
    anchors.fill: parent
    z: 100
    visible: rootItem.viewerVisible
    color: "#000000"
    focus: visible
    Keys.onEscapePressed: rootItem.closeMediaViewer()
    Keys.onLeftPressed: rootItem.viewerStep(-1)
    Keys.onRightPressed: rootItem.viewerStep(1)

    function currentMsg() {
        if (!rootItem.mediaList || rootItem.mediaList.length === 0) return null;
        var i = Math.max(0, Math.min(rootItem.mediaIndex, rootItem.mediaList.length - 1));
        return rootItem.mediaList[i];
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        // Header: counter + close
        Rectangle {
            Layout.fillWidth: true
            height: 44
            color: "#cc000000"

            RowLayout {
                anchors { fill: parent; leftMargin: 12; rightMargin: 8 }
                spacing: 8

                PlasmaComponents.Label {
                    text: rootItem.mediaList.length > 0
                          ? (Math.min(rootItem.mediaIndex, rootItem.mediaList.length - 1) + 1) + " of " + rootItem.mediaList.length
                          : ""
                    color: "#ffffff"
                    font.pointSize: 9
                    Layout.fillWidth: true
                }

                PlasmaComponents.ToolButton {
                    icon.name: "dialog-close"
                    display: PlasmaComponents.ToolButton.IconOnly
                    onClicked: rootItem.closeMediaViewer()
                }
            }
        }

        // Stage: pinch-zoom + drag-pan; click closes, double-click resets,
        // drag down dismisses.
        Item {
            id: viewerStage
            Layout.fillWidth: true
            Layout.fillHeight: true
            property real vScale: 1.0
            property real vTx: 0
            property real vTy: 0
            function reset() { vScale = 1.0; vTx = 0; vTy = 0; }

            Image {
                id: viewerImage
                anchors.centerIn: parent
                source: {
                    var m = mediaViewer.currentMsg();
                    if (!m) return "";
                    if (rootItem.viewerFullMsgId !== "" && rootItem.viewerFullMsgId === m.id && rootItem.viewerFullSource !== "")
                        return rootItem.viewerFullSource;
                    return MsgUtils.mediaPreviewSource(m);
                }
                fillMode: Image.PreserveAspectFit
                scale: viewerStage.vScale
                transform: Translate { x: viewerStage.vTx; y: viewerStage.vTy }
                asynchronous: true

                // Loading overlay while the full-res image arrives; the
                // cached 480p thumb stays painted underneath. On failure
                // the overlay names the problem instead of going blank.
                PlasmaComponents.Label {
                    anchors.centerIn: parent
                    visible: rootItem.viewerFullLoading || rootItem.viewerFullFailed
                    text: rootItem.viewerFullFailed ? "Couldn't load full image" : "Loading full resolution…"
                    color: "#ffffff"
                    font.pointSize: 9
                    style: Text.Outline
                    styleColor: "#80000000"
                    z: 5
                }

                PlasmaComponents.Label {
                    anchors.centerIn: parent
                    visible: {
                        var m = mediaViewer.currentMsg();
                        return !!m && m.type === "video";
                    }
                    text: "🎥 Video — open on phone to play"
                    color: "#ffffff"
                    font.pointSize: 9
                    style: Text.Outline
                    styleColor: "#80000000"
                }
            }

            PinchArea {
                anchors.fill: parent
                onPinchUpdated: {
                    viewerStage.vScale = Math.min(4, Math.max(0.5, viewerStage.vScale * pinch.scale));
                }
                MouseArea {
                    id: viewerPan
                    anchors.fill: parent
                    property real lastX: 0
                    property real lastY: 0
                    property real startY: 0
                    property bool moved: false
                    onPressed: function(mouse) {
                        lastX = mouse.x; lastY = mouse.y; startY = mouse.y; moved = false;
                    }
                    onPositionChanged: function(mouse) {
                        var dx = mouse.x - lastX;
                        var dy = mouse.y - lastY;
                        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
                        if (viewerStage.vScale > 1.05) {
                            viewerStage.vTx += dx;
                            viewerStage.vTy += dy;
                        } else if (dy > 0 && mouse.y - startY > 80) {
                            rootItem.closeMediaViewer();   // swipe-down dismiss
                        }
                        lastX = mouse.x; lastY = mouse.y;
                    }
                    onClicked: if (!moved) rootItem.closeMediaViewer()
                    onDoubleClicked: viewerStage.reset()
                }
            }
        }

            // Footer: prev / next + media label
            Rectangle {
                Layout.fillWidth: true
                height: 52
                color: "#cc000000"

                RowLayout {
                    anchors { fill: parent; leftMargin: 16; rightMargin: 16 }
                    spacing: 12

                    PlasmaComponents.ToolButton {
                        icon.name: "go-previous"
                        display: PlasmaComponents.ToolButton.IconOnly
                        visible: rootItem.mediaList.length > 1
                        onClicked: rootItem.viewerStep(-1)
                    }
                    Item { Layout.fillWidth: true }
                    PlasmaComponents.Label {
                        text: {
                            var m = mediaViewer.currentMsg();
                            return m ? (MsgUtils.mediaLabel(m.type) || "📷 Media") : "";
                        }
                        color: "#ffffff"
                        font.pointSize: 9
                    }
                    PlasmaComponents.ToolButton {
                        icon.name: "window-new"
                        display: PlasmaComponents.ToolButton.IconOnly
                        ToolTip.text: "Open in system viewer"
                        ToolTip.visible: hovered
                        onClicked: rootItem.openExternallyCurrent()
                    }
                    Item { Layout.fillWidth: true }
                    PlasmaComponents.ToolButton {
                        icon.name: "go-next"
                        display: PlasmaComponents.ToolButton.IconOnly
                        visible: rootItem.mediaList.length > 1
                        onClicked: rootItem.viewerStep(1)
                    }
                }
            }
    }

    onVisibleChanged: {
        if (visible) {
            viewerStage.reset();
            mediaViewer.forceActiveFocus();
        }
    }
}
