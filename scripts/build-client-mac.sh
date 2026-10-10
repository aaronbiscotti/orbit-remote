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
python3 - "$BUILD/app/Orbit.app/Contents/Info.plist" <<'PY'
import plistlib, sys
path = sys.argv[1]
with open(path, 'rb') as file:
    data = plistlib.load(file)
data.update(CFBundleName='Orbit', CFBundleDisplayName='Orbit', CFBundleIdentifier='local.orbit.remote')
with open(path, 'wb') as file:
    plistlib.dump(data, file)
PY
# A local development signature; notarization requires the owner's Apple account.
codesign --force --deep --sign - "$BUILD/app/Orbit.app"
ditto -c -k --sequesterRsrc --keepParent "$BUILD/app/Orbit.app" "$DEPLOY/Orbit-macOS.zip"
cp "$ROOT/NOTICE" "$DEPLOY/NOTICE.txt"
cp "$ENGINE/LICENSE" "$DEPLOY/Moonlight-LICENSE.txt"
