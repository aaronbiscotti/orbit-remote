#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENT="$ROOT/client"
BUILD="$ROOT/tools/client-build"
DEPLOY="$ROOT/dist/Orbit-Client-macOS"
rm -rf "$BUILD" "$DEPLOY"
mkdir -p "$BUILD" "$DEPLOY"
cd "$BUILD"
qmake "$CLIENT/orbit-client.pro" CONFIG+=release QMAKE_APPLE_DEVICE_ARCHS="x86_64 arm64"
make -j"$(sysctl -n hw.logicalcpu)"
macdeployqt "$BUILD/Orbit.app" -qmldir="$CLIENT/qml" -appstore-compliant
codesign --force --deep --sign - "$BUILD/Orbit.app"
codesign --verify --deep --strict --verbose=2 "$BUILD/Orbit.app"
lipo -archs "$BUILD/Orbit.app/Contents/MacOS/Orbit"
python3 "$ROOT/scripts/smoke-client.py" "$BUILD/Orbit.app/Contents/MacOS/Orbit"
ditto -c -k --sequesterRsrc --keepParent "$BUILD/Orbit.app" "$DEPLOY/Orbit-macOS.zip"
cp "$ROOT/NOTICE" "$DEPLOY/NOTICE.txt"
cp "$ROOT/LICENSE" "$DEPLOY/LICENSE.txt"
