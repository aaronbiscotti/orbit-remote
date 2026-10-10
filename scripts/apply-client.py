"""Apply a reproducible UI overlay without changing the streaming/authentication engine."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "vendor" / "moonlight"
REVISION = "a57e947d7185fd01384f6973df4df59ae2968d01"


def original(path):
    return subprocess.check_output(["git", "show", f"HEAD:{path}"], cwd=ENGINE).decode("utf-8")


def replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f"Overlay anchor changed: {old[:90]!r}")
    return text.replace(old, new, 1)


def overlays():
    main = original("app/gui/main.qml")
    main = replace(main, "width: 1280\n    height: 600", "width: 980\n    height: 680\n    minimumWidth: 720\n    minimumHeight: 520\n    title: \"Orbit\"\n    color: \"#101218\"\n    Material.theme: Material.Dark\n    Material.accent: \"#B7C5FF\"\n    Material.foreground: \"#EFF1F7\"\n    font.family: Qt.platform.os === \"osx\" ? \"Helvetica Neue\" : \"Segoe UI\"")
    main = replace(main, 'Material.background = "#303030"', 'Material.background = "#101218"')
    start = main.index("    header: ToolBar {")
    end = main.index("    ErrorMessageDialog {", start)
    main = main[:start] + (ROOT / "client" / "Header.qml.part").read_text(encoding="utf-8") + "\n\n" + main[end:]
    main = replace(main, 'property string label: qsTr("Enter the IP address of your host PC:")', 'title: qsTr("Add your PC")\n        property string label: qsTr("PC address (local or Tailscale)")')
    main = replace(main, "id: editText\n                Layout.fillWidth", "id: editText\n                placeholderText: qsTr(\"100.x.x.x or your PC name\")\n                Layout.preferredWidth: 340\n                Layout.fillWidth")

    pc = original("app/gui/PcView.qml")
    pc = replace(pc, "cellWidth: 310; cellHeight: 330;", "cellWidth: 332; cellHeight: 284;")
    pc = replace(pc, 'objectName: qsTr("Computers")', 'objectName: qsTr("Your computers")')
    start = pc.index("    Row {\n        anchors.centerIn: parent")
    end = pc.index("    model: computerModel", start)
    pc = pc[:start] + (ROOT / "client" / "EmptyState.qml.part").read_text(encoding="utf-8") + "\n\n" + pc[end:]
    pc = replace(pc, "width: 300; height: 320;", "width: 308; height: 256;\n        background: Rectangle {\n            radius: 26\n            color: parent.hovered ? \"#242936\" : \"#1B1F2A\"\n            border.width: parent.highlighted ? 2 : 1\n            border.color: parent.highlighted ? \"#B7C5FF\" : \"#303645\"\n        }")
    pc = replace(pc, 'id: pcIcon\n            anchors.horizontalCenter: parent.horizontalCenter', 'id: pcIcon\n            y: 32\n            anchors.horizontalCenter: parent.horizontalCenter')
    pc = replace(pc, "width: 200\n                height: 200", "width: 96\n                height: 96")
    pc = replace(pc, "anchors.verticalCenterOffset: !model.online ? -18 : -16", "anchors.verticalCenterOffset: -6")
    pc = replace(pc, "width: parent.width\n            anchors.top: pcIcon.bottom\n            anchors.bottom: parent.bottom\n            font.pointSize: 36", "width: parent.width - 40\n            anchors.horizontalCenter: parent.horizontalCenter\n            anchors.top: pcIcon.bottom\n            anchors.topMargin: 18\n            height: 40\n            font.pointSize: 21")
    pc = replace(pc, "        Loader {\n            id: pcContextMenuLoader", "        Label {\n            anchors.horizontalCenter: parent.horizontalCenter\n            anchors.bottom: parent.bottom\n            anchors.bottomMargin: 30\n            text: model.statusUnknown ? qsTr(\"Checking connection…\") : !model.online ? qsTr(\"Offline\") : model.paired ? qsTr(\"Ready to connect\") : qsTr(\"Pair this computer\")\n            color: model.online ? \"#BAC8FF\" : \"#9299AA\"\n            font.pointSize: 11\n        }\n\n        Loader {\n            id: pcContextMenuLoader")
    pc = replace(pc, 'text:qsTr("Please enter %1 on your host PC. This dialog will close when pairing is completed.").arg(pin)+"\\n\\n"+\n             qsTr("If your host PC is running Sunshine, navigate to the Sunshine web UI to enter the PIN.")', 'title: qsTr("Pair your Mac")\n        imageSrc: "qrc:/res/baseline-lock-24px.svg"\n        text: qsTr("Your pairing code: %1").arg(pin) + "\\n\\n" +\n              qsTr("Enter this code in Orbit Host on your PC, or in Sunshine settings. Pairing saves a device credential for future connections.")')

    dialog = original("app/gui/NavigableDialog.qml")
    dialog = replace(dialog, "modal: true", 'modal: true\n    padding: 26\n    background: Rectangle {\n        radius: 26\n        color: "#202532"\n        border.color: "#343C4E"\n        border.width: 1\n    }')
    prefs = original("app/settings/streamingpreferences.cpp")
    prefs = replace(prefs, "fps = settings.value(SER_FPS, 60).toInt();", "fps = settings.value(SER_FPS, 120).toInt();")
    prefs = replace(prefs, "absoluteMouseMode = settings.value(SER_ABSMOUSEMODE, false).toBool();", "absoluteMouseMode = settings.value(SER_ABSMOUSEMODE, true).toBool();")
    prefs = replace(prefs, "richPresence = settings.value(SER_RICHPRESENCE, true).toBool();", "richPresence = settings.value(SER_RICHPRESENCE, false).toBool();")
    cpp = original("app/main.cpp")
    cpp = replace(cpp, 'QCoreApplication::setOrganizationName("Moonlight Game Streaming Project");', 'QCoreApplication::setOrganizationName("Orbit Remote");')
    cpp = replace(cpp, 'QCoreApplication::setOrganizationDomain("moonlight-stream.com");', 'QCoreApplication::setOrganizationDomain("orbit.local");')
    cpp = replace(cpp, 'QCoreApplication::setApplicationName("Moonlight");', 'QCoreApplication::setApplicationName("Orbit");')
    return {"app/gui/main.qml": main, "app/gui/PcView.qml": pc, "app/gui/NavigableDialog.qml": dialog,
            "app/settings/streamingpreferences.cpp": prefs, "app/main.cpp": cpp}


if __name__ == "__main__":
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ENGINE).decode().strip()
    if revision != REVISION:
        sys.exit("Unexpected Moonlight revision. Initialize the pinned submodule before applying overlays.")
    for path, content in overlays().items():
        target = ENGINE / path
        if "--check" in sys.argv:
            if target.read_text(encoding="utf-8") != content:
                sys.exit(f"Overlay is missing or stale: {path}")
        else:
            target.write_text(content, encoding="utf-8", newline="\n")
    print("Orbit overlay verified." if "--check" in sys.argv else "Orbit overlay applied.")
