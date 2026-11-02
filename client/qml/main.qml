import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Orbit 1.0

ApplicationWindow {
    id: window
    visible: true
    width: 1180
    height: 760
    minimumWidth: 820
    minimumHeight: 560
    title: Orbit.connected ? ("Orbit · " + Orbit.activeHostName + (Orbit.secureDesktopActive ? " (UAC / Secure Desktop)" : "")) : "Orbit"
    color: "#101218"

    property int activeTab: 0 // 0 = Desktop, 1 = Terminal, 2 = Files, 3 = Processes

    header: Rectangle {
        height: Orbit.connected ? 68 : 92
        color: "#101218"
        border.width: 0

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 24
            anchors.rightMargin: 24
            spacing: 12

            Button {
                visible: Orbit.connected
                text: "← Disconnect"
                onClicked: Orbit.disconnectSession()
                background: Rectangle { radius: 16; color: parent.hovered ? "#323A4F" : "#212633" }
                contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                leftPadding: 14; rightPadding: 14; topPadding: 8; bottomPadding: 8
            }

            Rectangle {
                width: Orbit.connected ? 36 : 44
                height: Orbit.connected ? 36 : 44
                radius: width / 2
                color: "#B7C5FF"
                Text {
                    anchors.centerIn: parent
                    text: "◌"
                    color: "#151927"
                    font.pixelSize: Orbit.connected ? 26 : 34
                }
            }

            ColumnLayout {
                spacing: 2
                RowLayout {
                    spacing: 8
                    Text {
                        text: Orbit.connected ? Orbit.activeHostName : "Orbit"
                        color: "#EFF1F7"
                        font.pixelSize: Orbit.connected ? 17 : 22
                        font.weight: Font.DemiBold
                    }
                    Rectangle {
                        visible: Orbit.connected
                        radius: 10
                        color: Orbit.activePrivilege === "SYSTEM" ? "#1E382D" : (Orbit.activePrivilege === "Administrator" ? "#2A3352" : "#252B38")
                        height: 22
                        width: privText.implicitWidth + 16
                        Text {
                            id: privText
                            anchors.centerIn: parent
                            text: Orbit.activePrivilege === "SYSTEM" ? "✓ SYSTEM · UAC Ready" : Orbit.activePrivilege
                            color: Orbit.activePrivilege === "SYSTEM" ? "#A6D7BD" : "#B7C5FF"
                            font.pixelSize: 11
                            font.weight: Font.Medium
                        }
                    }
                    Rectangle {
                        visible: Orbit.connected && Orbit.secureDesktopActive
                        radius: 10
                        color: "#4B2E19"
                        border.color: "#FFB870"
                        border.width: 1
                        height: 24
                        width: secDeskLabel.implicitWidth + 18
                        Text {
                            id: secDeskLabel
                            anchors.centerIn: parent
                            text: "⚡ UAC / Lock Screen Active (" + Orbit.activeDesktop + ")"
                            color: "#FFD2A0"
                            font.pixelSize: 11
                            font.weight: Font.DemiBold
                        }
                    }
                }
                Text {
                    visible: !Orbit.connected
                    text: "Remote OS Takeover · Zero idle bitrate · Full Administrator & UAC control"
                    color: "#979FB4"
                    font.pixelSize: 12
                }
            }

            Item { Layout.fillWidth: true }

            // Mode switcher when connected
            RowLayout {
                visible: Orbit.connected
                spacing: 6

                Repeater {
                    model: [
                        { label: "Desktop", idx: 0 },
                        { label: "Terminal", idx: 1 },
                        { label: "Files", idx: 2 },
                        { label: "Processes", idx: 3 }
                    ]
                    delegate: Button {
                        text: modelData.label
                        onClicked: {
                            window.activeTab = modelData.idx
                            if (modelData.idx === 0) desktopFocusScope.forceActiveFocus()
                            else if (modelData.idx === 2) Orbit.browsePath(Orbit.currentFsPath === "" ? "drives" : Orbit.currentFsPath)
                            else if (modelData.idx === 3) Orbit.refreshProcesses()
                        }
                        background: Rectangle {
                            radius: 15
                            color: window.activeTab === modelData.idx ? "#B7C5FF" : (parent.hovered ? "#2A3142" : "#1B1F2A")
                        }
                        contentItem: Text {
                            text: parent.text
                            color: window.activeTab === modelData.idx ? "#151927" : "#EFF1F7"
                            font.pixelSize: 12
                            font.weight: window.activeTab === modelData.idx ? Font.DemiBold : Font.Normal
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                        }
                        leftPadding: 14; rightPadding: 14; topPadding: 7; bottomPadding: 7
                    }
                }
            }

            // Quick OS Takeover controls when connected
            RowLayout {
                visible: Orbit.connected
                spacing: 8

                Button {
                    text: "Ctrl+Alt+Del"
                    onClicked: Orbit.sendCtrlAltDel()
                    background: Rectangle { radius: 15; color: parent.hovered ? "#35405B" : "#252C3E" }
                    contentItem: Text { text: parent.text; color: "#BAC8FF"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    leftPadding: 12; rightPadding: 12; topPadding: 7; bottomPadding: 7
                }

                Button {
                    text: Orbit.privacyCurtain ? "● PC Screen Blanked" : "Blank PC Screen"
                    onClicked: Orbit.togglePrivacyCurtain()
                    background: Rectangle {
                        radius: 15
                        color: Orbit.privacyCurtain ? "#253A34" : (parent.hovered ? "#35405B" : "#212633")
                        border.width: Orbit.privacyCurtain ? 1 : 0
                        border.color: "#A6D7BD"
                    }
                    contentItem: Text {
                        text: parent.text
                        color: Orbit.privacyCurtain ? "#A6D7BD" : "#EFF1F7"
                        font.pixelSize: 12
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                    }
                    leftPadding: 12; rightPadding: 12; topPadding: 7; bottomPadding: 7
                }

                Button {
                    text: "Actions ▾"
                    onClicked: takeoverMenu.open()
                    background: Rectangle { radius: 15; color: parent.hovered ? "#35405B" : "#212633" }
                    contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    leftPadding: 12; rightPadding: 12; topPadding: 7; bottomPadding: 7

                    Menu {
                        id: takeoverMenu
                        MenuItem { text: "Quality: Crisp Lossless Text (PNG)"; onTriggered: Orbit.setQualityPreset("crisp") }
                        MenuItem { text: "Quality: Balanced Adaptive (JPEG)"; onTriggered: Orbit.setQualityPreset("balanced") }
                        MenuItem { text: "Quality: Low Bandwidth (Cellular)"; onTriggered: Orbit.setQualityPreset("low") }
                        MenuSeparator {}
                        MenuItem {
                            text: "Resize PC to Fit Mac Window"
                            onTriggered: Orbit.matchClientResolution(Math.round(desktopCanvas.width), Math.round(desktopCanvas.height))
                        }
                        MenuItem { text: "Restore Native PC Resolution"; onTriggered: Orbit.restoreHostResolution() }
                        MenuSeparator {}
                        MenuItem { text: "Sync Mac Clipboard → PC"; onTriggered: Orbit.syncClipboardToPc() }
                        MenuItem { text: "Copy PC Clipboard → Mac"; onTriggered: Orbit.pullClipboardFromPc() }
                        MenuItem {
                            text: (Orbit.mapCommandToCtrl ? "✓ " : "") + "Map Mac ⌘ Command to Windows Ctrl"
                            onTriggered: Orbit.mapCommandToCtrl = !Orbit.mapCommandToCtrl
                        }
                        MenuSeparator {}
                        MenuItem { text: "Lock Windows PC"; onTriggered: Orbit.sendPowerAction("lock") }
                    }
                }
            }

            // Disconnected Home toolbar controls
            RowLayout {
                visible: !Orbit.connected
                spacing: 10

                Button {
                    text: "Quality: " + (Orbit.qualityMode === "crisp" ? "Crisp Text" : (Orbit.qualityMode === "low" ? "Low Bandwidth" : "Balanced"))
                    onClicked: homeQualityMenu.open()
                    background: Rectangle { radius: 18; color: parent.hovered ? "#35405B" : "#283149" }
                    contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    leftPadding: 16; rightPadding: 16; topPadding: 10; bottomPadding: 10

                    Menu {
                        id: homeQualityMenu
                        MenuItem { text: "Crisp Text · Lossless Dirty Tiles (0 KB/s idle)"; onTriggered: Orbit.setQualityPreset("crisp") }
                        MenuItem { text: "Balanced · Adaptive JPEG Tiles"; onTriggered: Orbit.setQualityPreset("balanced") }
                        MenuItem { text: "Low Bandwidth · Scaled Tiles for Weak Wi-Fi"; onTriggered: Orbit.setQualityPreset("low") }
                    }
                }

                Button {
                    text: "Refresh"
                    onClicked: Orbit.refreshComputers()
                    background: Rectangle { radius: 18; color: parent.hovered ? "#30374A" : "#212633" }
                    contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 13; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    leftPadding: 16; rightPadding: 16; topPadding: 10; bottomPadding: 10
                }

                Button {
                    text: "Add PC"
                    onClicked: addPcDialog.open()
                    background: Rectangle { radius: 18; color: parent.hovered ? "#CAD4FF" : "#B7C5FF" }
                    contentItem: Text { text: parent.text; color: "#151927"; font.pixelSize: 13; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    leftPadding: 18; rightPadding: 18; topPadding: 10; bottomPadding: 10
                }
            }
        }
    }

    // =========================================================================
    // Main Content Area
    // =========================================================================
    Item {
        anchors.fill: parent

        // 1. Disconnected Home View (Empty State or PC Cards)
        Item {
            anchors.fill: parent
            visible: !Orbit.connected

            // Empty State
            ColumnLayout {
                anchors.centerIn: parent
                width: Math.min(parent.width - 64, 500)
                spacing: 18
                visible: Orbit.computers.length === 0

                Rectangle {
                    Layout.alignment: Qt.AlignHCenter
                    width: 88; height: 88; radius: 32; color: "#222B43"
                    Text { anchors.centerIn: parent; text: "⊞"; color: "#B7C5FF"; font.pixelSize: 40 }
                }

                Text {
                    text: "Take over your Windows PC"
                    color: "#EFF1F7"
                    font.pixelSize: 28; font.weight: Font.DemiBold
                    Layout.fillWidth: true; horizontalAlignment: Text.AlignHCenter
                }

                Text {
                    text: "Open Orbit Host on your PC and copy its address. Orbit sends only changed screen tiles (0 KB/s when static) and gives you full Administrator, UAC prompt, Terminal, and File control."
                    color: "#A5ADC1"; font.pixelSize: 13
                    Layout.fillWidth: true; horizontalAlignment: Text.AlignHCenter; wrapMode: Text.Wrap
                }

                Button {
                    text: "Add PC →"
                    Layout.alignment: Qt.AlignHCenter
                    onClicked: addPcDialog.open()
                    background: Rectangle { radius: 22; color: parent.hovered ? "#CAD4FF" : "#B7C5FF" }
                    contentItem: Text { text: parent.text; color: "#151927"; font.pixelSize: 16; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    leftPadding: 32; rightPadding: 32; topPadding: 14; bottomPadding: 14
                }

                Text {
                    text: "Away from home? Connect Tailscale on both devices."
                    color: "#68758F"; font.pixelSize: 12; Layout.alignment: Qt.AlignHCenter
                }
            }

            // Saved PCs Grid
            GridView {
                id: pcGrid
                anchors.fill: parent
                anchors.margins: 36
                visible: Orbit.computers.length > 0
                cellWidth: 340
                cellHeight: 260
                model: Orbit.computers

                delegate: Rectangle {
                    width: 316
                    height: 236
                    radius: 26
                    color: cardMouse.containsMouse ? "#242936" : "#1B1F2A"
                    border.width: modelData.online ? 2 : 1
                    border.color: modelData.online ? "#B7C5FF" : "#303645"

                    ColumnLayout {
                        anchors.fill: parent
                        anchors.margins: 22
                        spacing: 10

                        RowLayout {
                            Layout.fillWidth: true
                            Rectangle {
                                width: 48; height: 48; radius: 16; color: "#252C3E"
                                Text { anchors.centerIn: parent; text: "⊞"; color: "#B7C5FF"; font.pixelSize: 24 }
                            }
                            ColumnLayout {
                                spacing: 2
                                Text {
                                    text: modelData.name
                                    color: "#EFF1F7"
                                    font.pixelSize: 19
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                }
                                Text {
                                    text: modelData.address
                                    color: "#8E98B0"
                                    font.pixelSize: 12
                                }
                            }
                            Item { Layout.fillWidth: true }
                            Button {
                                text: "✕"
                                onClicked: Orbit.removeComputer(modelData.address)
                                background: Rectangle { radius: 12; color: parent.hovered ? "#3A2630" : "transparent" }
                                contentItem: Text { text: "✕"; color: "#8E98B0"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                            }
                        }

                        Item { Layout.fillHeight: true }

                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 8
                            Rectangle {
                                width: 8; height: 8; radius: 4
                                color: modelData.statusUnknown ? "#8E98B0" : (modelData.online ? "#A6D7BD" : "#687086")
                            }
                            Text {
                                text: modelData.statusUnknown ? "Checking connection…" : (!modelData.online ? "Offline" : (modelData.privilege === "SYSTEM" ? "Online · SYSTEM & UAC Ready" : "Online · " + modelData.privilege))
                                color: modelData.online ? "#A6D7BD" : "#9299AA"
                                font.pixelSize: 12
                            }
                        }

                        Rectangle {
                            Layout.fillWidth: true
                            height: 40
                            radius: 16
                            color: modelData.online ? "#B7C5FF" : "#252B38"

                            Text {
                                anchors.centerIn: parent
                                text: !modelData.online ? "Offline" : (modelData.paired ? "Take Over PC →" : "Pair This Mac →")
                                color: modelData.online ? "#151927" : "#9299AA"
                                font.pixelSize: 13
                                font.weight: Font.DemiBold
                            }

                            MouseArea {
                                id: cardMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    if (modelData.online) Orbit.activateComputer(modelData.address)
                                    else Orbit.refreshComputers()
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2. Connected OS Takeover View
        Item {
            anchors.fill: parent
            visible: Orbit.connected

            // Tab 0: Interactive Dirty-Tile Desktop Takeover
            FocusScope {
                id: desktopFocusScope
                anchors.fill: parent
                visible: window.activeTab === 0
                focus: window.activeTab === 0 && Orbit.connected

                DesktopCanvas {
                    id: desktopCanvas
                    anchors.fill: parent
                    Component.onCompleted: Orbit.registerCanvas(desktopCanvas)

                    MouseArea {
                        anchors.fill: parent
                        hoverEnabled: true
                        acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
                        cursorShape: Qt.ArrowCursor

                        function buttonName(btn) {
                            if (btn === Qt.RightButton) return "right"
                            if (btn === Qt.MiddleButton) return "middle"
                            return "left"
                        }

                        onPositionChanged: function(mouse) {
                            var pt = desktopCanvas.mapToNormalized(mouse.x, mouse.y)
                            Orbit.sendMouse("move", pt.x, pt.y, "left", 0, 0)
                        }

                        onPressed: function(mouse) {
                            desktopFocusScope.forceActiveFocus()
                            var pt = desktopCanvas.mapToNormalized(mouse.x, mouse.y)
                            Orbit.sendMouse("down", pt.x, pt.y, buttonName(mouse.button), 0, 0)
                        }

                        onReleased: function(mouse) {
                            var pt = desktopCanvas.mapToNormalized(mouse.x, mouse.y)
                            Orbit.sendMouse("up", pt.x, pt.y, buttonName(mouse.button), 0, 0)
                        }

                        onDoubleClicked: function(mouse) {
                            var pt = desktopCanvas.mapToNormalized(mouse.x, mouse.y)
                            Orbit.sendMouse("dblclick", pt.x, pt.y, buttonName(mouse.button), 0, 0)
                        }

                        onWheel: function(wheel) {
                            var pt = desktopCanvas.mapToNormalized(wheel.x, wheel.y)
                            Orbit.sendMouse("wheel", pt.x, pt.y, "left", wheel.angleDelta.x, wheel.angleDelta.y)
                        }
                    }
                }

                Keys.onPressed: function(event) {
                    Orbit.sendKeyEvent("press", event.key, event.modifiers, event.text)
                    event.accepted = true
                }
            }

            // Tab 1: Remote Administrator Terminal (PowerShell / CMD)
            Rectangle {
                anchors.fill: parent
                anchors.margins: 24
                radius: 22
                color: "#141821"
                border.color: "#283044"
                border.width: 1
                visible: window.activeTab === 1

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 20
                    spacing: 14

                    RowLayout {
                        Layout.fillWidth: true
                        Text {
                            text: "Remote Windows Shell (" + Orbit.activePrivilege + " · " + Orbit.terminalCwd + ")"
                            color: "#EFF1F7"
                            font.pixelSize: 15
                            font.weight: Font.DemiBold
                        }
                        Item { Layout.fillWidth: true }
                        Button {
                            text: "Clear"
                            onClicked: Orbit.clearTerminal()
                            background: Rectangle { radius: 12; color: "#23293A" }
                            contentItem: Text { text: "Clear"; color: "#A5ADC1"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                        }
                    }

                    ScrollView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true

                        TextArea {
                            text: Orbit.terminalOutput.length > 0 ? Orbit.terminalOutput : "Ready. Commands execute directly on your Windows PC with " + Orbit.activePrivilege + " permissions (zero video bandwidth).\n"
                            readOnly: true
                            selectByMouse: true
                            wrapMode: TextEdit.Wrap
                            color: "#D6E0FF"
                            font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas"
                            font.pixelSize: 13
                            background: Rectangle { radius: 14; color: "#0D1017" }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10

                        TextField {
                            id: cmdInput
                            Layout.fillWidth: true
                            placeholderText: "Run PowerShell command on PC (e.g. Get-Process, ipconfig, winget, git status)…"
                            color: "#EFF1F7"
                            font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas"
                            font.pixelSize: 13
                            background: Rectangle { radius: 14; color: "#0D1017"; border.color: "#39435A"; border.width: 1 }
                            onAccepted: {
                                if (text.trim().length > 0) {
                                    Orbit.runCommand(text, "powershell")
                                    text = ""
                                }
                            }
                        }

                        Button {
                            text: Orbit.terminalBusy ? "Running…" : "Run →"
                            enabled: !Orbit.terminalBusy && cmdInput.text.trim().length > 0
                            onClicked: {
                                Orbit.runCommand(cmdInput.text, "powershell")
                                cmdInput.text = ""
                            }
                            background: Rectangle { radius: 14; color: "#B7C5FF" }
                            contentItem: Text { text: parent.text; color: "#151927"; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                            leftPadding: 18; rightPadding: 18; topPadding: 10; bottomPadding: 10
                        }
                    }
                }
            }

            // Tab 2: Remote Windows File Explorer & Transfer
            Rectangle {
                anchors.fill: parent
                anchors.margins: 24
                radius: 22
                color: "#141821"
                border.color: "#283044"
                border.width: 1
                visible: window.activeTab === 2

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 20
                    spacing: 12

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 10

                        Button {
                            text: "↑ Up"
                            onClicked: Orbit.browsePath(Orbit.parentFsPath)
                            background: Rectangle { radius: 12; color: "#252C3E" }
                            contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                        }

                        Button {
                            text: "Drives"
                            onClicked: Orbit.browsePath("drives")
                            background: Rectangle { radius: 12; color: "#252C3E" }
                            contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                        }

                        TextField {
                            id: pathInput
                            Layout.fillWidth: true
                            text: Orbit.currentFsPath
                            placeholderText: "Windows path (e.g. C:\\Users)"
                            color: "#EFF1F7"
                            font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas"
                            background: Rectangle { radius: 12; color: "#0D1017"; border.color: "#39435A"; border.width: 1 }
                            onAccepted: Orbit.browsePath(text)
                        }

                        Button {
                            text: "Upload Local File…"
                            enabled: Orbit.currentFsPath.length > 0
                            onClicked: uploadDialog.open()
                            background: Rectangle { radius: 12; color: "#B7C5FF" }
                            contentItem: Text { text: parent.text; color: "#151927"; font.pixelSize: 12; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter }
                        }
                    }

                    ListView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 6
                        model: Orbit.fileEntries

                        delegate: Rectangle {
                            width: ListView.view.width
                            height: 44
                            radius: 12
                            color: "#1B1F2A"

                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 14
                                anchors.rightMargin: 14
                                spacing: 12

                                Text {
                                    text: modelData.isDir ? "📁" : "📄"
                                    font.pixelSize: 16
                                }

                                Text {
                                    text: modelData.name
                                    color: "#EFF1F7"
                                    font.pixelSize: 13
                                    Layout.fillWidth: true
                                    elide: Text.ElideRight

                                    MouseArea {
                                        anchors.fill: parent
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: {
                                            if (modelData.isDir) Orbit.browsePath(modelData.path)
                                        }
                                    }
                                }

                                Text {
                                    text: modelData.isDir ? modelData.modified : (Math.round(modelData.size / 1024) + " KB · " + modelData.modified)
                                    color: "#8E98B0"
                                    font.pixelSize: 11
                                }

                                Button {
                                    visible: modelData.isDir
                                    text: "Open"
                                    onClicked: Orbit.browsePath(modelData.path)
                                    background: Rectangle { radius: 10; color: "#283149" }
                                    contentItem: Text { text: "Open"; color: "#B7C5FF"; font.pixelSize: 11; horizontalAlignment: Text.AlignHCenter }
                                }

                                Button {
                                    visible: !modelData.isDir
                                    text: "Download to Mac"
                                    onClicked: Orbit.downloadFile(modelData.path)
                                    background: Rectangle { radius: 10; color: "#283149" }
                                    contentItem: Text { text: "Download"; color: "#B7C5FF"; font.pixelSize: 11; horizontalAlignment: Text.AlignHCenter }
                                }
                            }
                        }
                    }
                }
            }

            // Tab 3: Remote Windows Task Manager & Power Controls
            Rectangle {
                anchors.fill: parent
                anchors.margins: 24
                radius: 22
                color: "#141821"
                border.color: "#283044"
                border.width: 1
                visible: window.activeTab === 3

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: 20
                    spacing: 12

                    RowLayout {
                        Layout.fillWidth: true
                        Text {
                            text: "Windows Task Manager (" + Orbit.processEntries.length + " processes)"
                            color: "#EFF1F7"
                            font.pixelSize: 16
                            font.weight: Font.DemiBold
                        }
                        Item { Layout.fillWidth: true }
                        Button {
                            text: "Refresh Processes"
                            onClicked: Orbit.refreshProcesses()
                            background: Rectangle { radius: 12; color: "#252C3E" }
                            contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                        }
                        Button {
                            text: "Lock PC"
                            onClicked: Orbit.sendPowerAction("lock")
                            background: Rectangle { radius: 12; color: "#252C3E" }
                            contentItem: Text { text: parent.text; color: "#EFF1F7"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                        }
                        Button {
                            text: "Restart PC"
                            onClicked: Orbit.sendPowerAction("restart")
                            background: Rectangle { radius: 12; color: "#42232B" }
                            contentItem: Text { text: parent.text; color: "#FFB4C0"; font.pixelSize: 12; horizontalAlignment: Text.AlignHCenter }
                        }
                    }

                    ListView {
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: 6
                        model: Orbit.processEntries

                        delegate: Rectangle {
                            width: ListView.view.width
                            height: 44
                            radius: 12
                            color: "#1B1F2A"

                            RowLayout {
                                anchors.fill: parent
                                anchors.leftMargin: 14
                                anchors.rightMargin: 14
                                spacing: 12

                                Text {
                                    text: modelData.name + " (PID " + modelData.pid + ")"
                                    color: "#EFF1F7"
                                    font.pixelSize: 13
                                    font.weight: Font.Medium
                                }

                                Rectangle {
                                    visible: modelData.elevated
                                    radius: 8
                                    color: "#2A3352"
                                    width: 64; height: 20
                                    Text { anchors.centerIn: parent; text: "Elevated"; color: "#B7C5FF"; font.pixelSize: 10 }
                                }

                                Text {
                                    text: modelData.title
                                    color: "#8E98B0"
                                    font.pixelSize: 12
                                    Layout.fillWidth: true
                                    elide: Text.ElideRight
                                }

                                Text {
                                    text: modelData.memoryMb + " MB"
                                    color: "#A6D7BD"
                                    font.pixelSize: 12
                                }

                                Button {
                                    text: "End Task"
                                    onClicked: Orbit.killProcess(modelData.pid)
                                    background: Rectangle { radius: 10; color: "#3A232B" }
                                    contentItem: Text { text: "End Task"; color: "#FFB4C0"; font.pixelSize: 11; horizontalAlignment: Text.AlignHCenter }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // =========================================================================
    // Dialogs (Add PC, Pair 4-Digit PIN, Upload File)
    // =========================================================================
    Dialog {
        id: addPcDialog
        anchors.centerIn: parent
        width: 420
        modal: true
        padding: 24
        background: Rectangle { radius: 24; color: "#202532"; border.color: "#343C4E"; border.width: 1 }

        ColumnLayout {
            width: parent.width
            spacing: 16
            Text { text: "Add Windows PC"; color: "#EFF1F7"; font.pixelSize: 20; font.weight: Font.DemiBold }
            Text { text: "Copy the address from Orbit Host on your PC (LAN IP or Tailscale 100.x.x.x)."; color: "#A5ADC1"; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
            TextField {
                id: pcAddressInput
                Layout.fillWidth: true
                placeholderText: "e.g. 100.64.1.2"
                color: "#EFF1F7"
                background: Rectangle { radius: 12; color: "#121620"; border.color: "#39435A"; border.width: 1 }
                onAccepted: {
                    if (text.trim().length > 0) {
                        Orbit.addComputer(text.trim())
                        text = ""
                        addPcDialog.close()
                    }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Button {
                    text: "Cancel"
                    onClicked: addPcDialog.close()
                    background: Rectangle { radius: 14; color: "#2B3348" }
                    contentItem: Text { text: "Cancel"; color: "#EFF1F7"; horizontalAlignment: Text.AlignHCenter }
                }
                Button {
                    text: "Add PC →"
                    enabled: pcAddressInput.text.trim().length > 0
                    onClicked: {
                        Orbit.addComputer(pcAddressInput.text.trim())
                        pcAddressInput.text = ""
                        addPcDialog.close()
                    }
                    background: Rectangle { radius: 14; color: "#B7C5FF" }
                    contentItem: Text { text: "Add PC →"; color: "#151927"; font.weight: Font.DemiBold; horizontalAlignment: Text.AlignHCenter }
                }
            }
        }
    }

    Dialog {
        id: pairModal
        anchors.centerIn: parent
        width: 420
        modal: true
        visible: Orbit.pairing
        closePolicy: Popup.NoAutoClose
        padding: 24
        background: Rectangle { radius: 24; color: "#202532"; border.color: "#343C4E"; border.width: 1 }

        ColumnLayout {
            width: parent.width
            spacing: 18
            Text { text: "Pair with " + Orbit.pairingHost; color: "#EFF1F7"; font.pixelSize: 20; font.weight: Font.DemiBold }
            Text { text: "Enter this 4-digit code in Orbit Host on your Windows PC."; color: "#A5ADC1"; font.pixelSize: 13; wrapMode: Text.Wrap; Layout.fillWidth: true }
            Rectangle {
                Layout.fillWidth: true
                height: 96
                radius: 18
                color: "#121620"
                Text {
                    anchors.centerIn: parent
                    text: Orbit.pairingPin
                    color: "#B7C5FF"
                    font.pixelSize: 44
                    font.letterSpacing: 10
                    font.family: Qt.platform.os === "osx" ? "Menlo" : "Consolas"
                }
            }
            RowLayout {
                Layout.fillWidth: true
                Text { text: "Waiting for approval on your PC…"; color: "#929CB4"; font.pixelSize: 12 }
                Item { Layout.fillWidth: true }
                Button {
                    text: "Cancel"
                    onClicked: Orbit.cancelPairing()
                    background: Rectangle { radius: 14; color: "#2B3348" }
                    contentItem: Text { text: "Cancel"; color: "#EFF1F7"; horizontalAlignment: Text.AlignHCenter }
                }
            }
        }
    }

    Dialog {
        id: uploadDialog
        anchors.centerIn: parent
        width: 460
        modal: true
        padding: 24
        background: Rectangle { radius: 24; color: "#202532"; border.color: "#343C4E"; border.width: 1 }

        ColumnLayout {
            width: parent.width
            spacing: 14
            Text { text: "Upload File to PC"; color: "#EFF1F7"; font.pixelSize: 18; font.weight: Font.DemiBold }
            Text { text: "Destination folder: " + Orbit.currentFsPath; color: "#979FB4"; font.pixelSize: 12; elide: Text.ElideMiddle; Layout.fillWidth: true }
            TextField {
                id: localUploadPath
                Layout.fillWidth: true
                placeholderText: "Local Mac file path (e.g. /Users/you/Desktop/file.txt)"
                color: "#EFF1F7"
                background: Rectangle { radius: 12; color: "#121620"; border.color: "#39435A"; border.width: 1 }
            }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                Button { text: "Cancel"; onClicked: uploadDialog.close() }
                Button {
                    text: "Upload →"
                    enabled: localUploadPath.text.trim().length > 0
                    onClicked: {
                        Orbit.uploadLocalFile(localUploadPath.text.trim())
                        localUploadPath.text = ""
                        uploadDialog.close()
                    }
                }
            }
        }
    }

    footer: Rectangle {
        height: 46
        color: "#101218"
        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 24
            anchors.rightMargin: 24
            spacing: 16

            Text {
                text: Orbit.connected
                    ? ("Dirty-Tile OS Takeover · " + Orbit.bandwidthText + (desktopCanvas.remoteWidth > 0 ? (" · " + desktopCanvas.remoteWidth + " × " + desktopCanvas.remoteHeight) : ""))
                    : "Event-driven dirty-tile protocol · 0 KB/s when screen is static"
                color: "#929CB4"
                font.pixelSize: 12
            }

            Item { Layout.fillWidth: true }

            Text {
                visible: Orbit.statusMessage.length > 0
                text: Orbit.statusMessage
                color: "#B7C5FF"
                font.pixelSize: 12
            }
        }
    }
}
