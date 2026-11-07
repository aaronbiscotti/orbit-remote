#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
command -v cmake >/dev/null
openssl_root="${ORBIT_OPENSSL_ROOT:-$(brew --prefix openssl@3)}"
git submodule update --init --recursive vendor/moonlight-common-c
cmake -S native/video-bridge -B work/video-bridge-build -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR="$openssl_root"
cmake --build work/video-bridge-build --parallel 8
mkdir -p dist/video-engine
cp work/video-bridge-build/orbit-video-bridge dist/video-engine/
cp vendor/moonlight-common-c/LICENSE.txt dist/video-engine/Moonlight-LICENSE.txt
cp "$openssl_root/LICENSE.txt" dist/video-engine/OpenSSL-LICENSE.txt
cp vendor/moonlight-common-c/enet/LICENSE dist/video-engine/ENet-LICENSE.txt
cp vendor/moonlight-common-c/nanors/LICENSE dist/video-engine/NanoRS-LICENSE.txt
codesign --force --sign - dist/video-engine/orbit-video-bridge

# Focus the supervised native player without launching a second instance.
swiftc "$repo_root/native/window-focus/main.swift" -o "$repo_root/dist/video-engine/orbit-focus-player"
