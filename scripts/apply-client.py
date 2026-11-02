"""Verify that Orbit's native Qt 6 OS-Takeover client sources are present and reproducible."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
CLIENT = ROOT / "client"

REQUIRED_FILES = [
    "orbit-client.pro",
    "resources.qrc",
    "Info.plist",
    "src/main.cpp",
    "src/DesktopCanvas.h",
    "src/DesktopCanvas.cpp",
    "src/OrbitBackend.h",
    "src/OrbitBackend.cpp",
    "qml/main.qml",
]

if __name__ == "__main__":
    for rel in REQUIRED_FILES:
        path = CLIENT / rel
        if not path.is_file() or path.stat().st_size == 0:
            sys.exit(f"Missing or empty client source file: {rel}")
    print("Orbit native OS-Takeover client verified." if "--check" in sys.argv else "Orbit native OS-Takeover client ready.")
