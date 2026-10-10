#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE="$ROOT/vendor/moonlight"
BUILD="$ROOT/tools/client-build"
DEPLOY="$ROOT/dist/Orbit-Client-macOS"
mkdir -p "$BUILD" "$DEPLOY"
cd "$ENGINE"
python3 setup-deps.py
cd "$BUILD"
qmake "$ENGINE/moonlight-qt.pro" CONFIG+=release QMAKE_APPLE_DEVICE_ARCHS="x86_64 arm64"
make -j"$(sysctl -n hw.logicalcpu)" release
macdeployqt "$BUILD/app/Moonlight.app" -qmldir="$ENGINE/app/gui" -appstore-compliant
cp -R "$BUILD/app/Moonlight.app" "$BUILD/app/Orbit.app"
PLIST="$BUILD/app/Orbit.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Orbit' "$PLIST"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier local.orbit.remote' "$PLIST"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Orbit' "$PLIST" || /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Orbit' "$PLIST"
# A local development signature; notarization requires the owner's Apple account.
codesign --force --deep --sign - "$BUILD/app/Orbit.app"
ditto -c -k --sequesterRsrc --keepParent "$BUILD/app/Orbit.app" "$DEPLOY/Orbit-macOS.zip"
cp "$ROOT/NOTICE" "$DEPLOY/NOTICE.txt"
cp "$ENGINE/LICENSE" "$DEPLOY/Moonlight-LICENSE.txt"
