"""Apply pinned UI, input, and low-latency overlays. Remote authentication stays upstream."""
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
    start = main.index("    NavigableDialog {\n        id: addPcDialog")
    main = main[:start] + (ROOT / "client" / "AddPcDialog.qml.part").read_text(encoding="utf-8-sig") + "\n}\n"

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
    pc = replace(pc, 'model.paired ? qsTr("Ready to connect") : qsTr("Pair this computer")', 'model.paired ? qsTr("Connect →") : qsTr("Pair →")')
    pc = replace(pc, 'color: model.online ? "#BAC8FF" : "#9299AA"\n            font.pointSize: 11', 'color: model.online ? "#151927" : "#9299AA"\n            font.pointSize: 11\n            padding: 10\n            background: Rectangle { radius: 16; color: model.online ? "#B7C5FF" : "#252B38" }')
    start = pc.index("    NavigableMessageDialog {\n        id: pairDialog")
    end = pc.index("    NavigableMessageDialog {\n        id: deletePcDialog", start)
    pc = pc[:start] + (ROOT / "client" / "PairDialog.qml.part").read_text(encoding="utf-8-sig") + "\n" + pc[end:]

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
    # Reapply upstream keyboard behavior after removing the experimental display remap.
    keyboard = original("app/streaming/input/keyboard.cpp")
    inputs = original("app/streaming/input/input.h")
    input_cpp = original("app/streaming/input/input.cpp")
    input_cpp = replace(input_cpp, "m_MouseCursorCapturedVisibilityState(SDL_DISABLE),", "m_MouseCursorCapturedVisibilityState(prefs.absoluteMouseMode ? SDL_ENABLE : SDL_DISABLE),")
    pacer_header = original("app/streaming/video/ffmpeg-renderers/pacer/pacer.h")
    pacer_header = replace(pacer_header, "bool m_Stopping;", "bool m_Stopping;\n    bool m_LatestFrameOnly;")
    pacer = original("app/streaming/video/ffmpeg-renderers/pacer/pacer.cpp")
    pacer = replace(pacer, '#include "pacer.h"', '#include "pacer.h"\n#include "settings/streamingpreferences.h"')
    pacer = replace(pacer, "m_Stopping(false),", "m_Stopping(false),\n    m_LatestFrameOnly(false),")
    pacer = replace(pacer, "    m_MaxVideoFps = maxVideoFps;", "    m_LatestFrameOnly = !enablePacing && !StreamingPreferences::get()->enableVsync;\n    m_MaxVideoFps = maxVideoFps;\n    if (m_LatestFrameOnly) SDL_LogInfo(SDL_LOG_CATEGORY_APPLICATION, \"Orbit low latency: newest decoded frame only\");")
    pacer = replace(pacer, "    if (m_RendererAttributes & RENDERER_ATTRIBUTE_NO_BUFFERING) {", "    if (m_LatestFrameOnly) {\n        // Keep the newest waiting frame for the next render, without accumulating latency.\n        frameDropTarget = 1;\n    }\n    else if (m_RendererAttributes & RENDERER_ATTRIBUTE_NO_BUFFERING) {")
    pacer = replace(pacer, "    if (queue.size() == MAX_QUEUED_FRAMES) {\n        AVFrame* frame = queue.dequeue();\n        av_frame_free(&frame);\n    }", "    const int limit = m_LatestFrameOnly ? 1 : MAX_QUEUED_FRAMES;\n    while (queue.size() >= limit) {\n        AVFrame* frame = queue.dequeue();\n        // Count renderer backlog separately from network packet loss.\n        m_VideoStats->pacerDroppedFrames++;\n        av_frame_free(&frame);\n    }")
    return {"app/gui/main.qml": main, "app/gui/PcView.qml": pc, "app/gui/NavigableDialog.qml": dialog,
            "app/settings/streamingpreferences.cpp": prefs, "app/main.cpp": cpp,
            "app/streaming/input/keyboard.cpp": keyboard, "app/streaming/input/input.h": inputs,
            "app/streaming/input/input.cpp": input_cpp,
            "app/streaming/video/ffmpeg-renderers/pacer/pacer.cpp": pacer,
            "app/streaming/video/ffmpeg-renderers/pacer/pacer.h": pacer_header}


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
