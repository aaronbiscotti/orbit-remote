# Native stream window on macOS

The macOS Electron client now opens the official Moonlight player in its own window. Electron remains the connection manager for Files, Terminal, and Processes; it does not receive, decode, or draw streaming video. `electron/native-video-session.js` supervises a single player, waits for exit before restarting, prefers the PC's home-network address when it answers (else the Tailscale fallback), and uses full-screen HEVC hardware decoding (not a macOS full-screen Space), absolute desktop mouse input, 120 fps target, and no extra frame-pacing queue. Closing the Orbit manager window leaves the native stream running; Disconnect or quitting Orbit stops it.

Install the official Moonlight 6.2.0 app at `/Applications/Moonlight.app`. The release DMG SHA-256 is `43617e5210d53968fcfb4a46526d1625a9056c6fe97e731673c31193dae776fc`. This Mac's existing paired identity and GPU host were migrated to Moonlight's private preferences; pairing credentials are not shipped in builds. New installations must pair Moonlight with Sunshine separately. The launcher reports an installation error if Moonlight is absent.

Paired GPU connections with cached display metadata skip the legacy capture connection on startup. The native stream stays independent when Orbit changes tabs. Display switching uses Sunshine's Control+Option+Shift+F1/F2 shortcuts in the stream window. Quality presets use 25/12/6 Mbps at 1080p; 120 fps is requested, not guaranteed. Moonlight's own statistics overlay measures the native pipeline. The old embedded modules below remain available for non-macOS development, but are not started on this Mac.

Run `npm run test:video` for native lifecycle and existing transport tests.

## Previous embedded transport implementation

# Embedded GPU desktop transport

Orbit keeps the Electron interface. `video-session.js` authenticates Sunshine HTTPS against the paired server certificate, launches/resumes an encrypted stream, and runs this headless Moonlight transport helper. Encoded frames go over stdio to Electron WebCodecs; there is no external player window or unauthenticated local network listener. The helper uses the pinned `vendor/moonlight-common-c` submodule and statically linked OpenSSL.

Build on macOS (CMake, Xcode command-line tools and Homebrew OpenSSL 3):

```
npm ci
npm run build:video:mac
npm run test:video
npm run dist:mac:gpu
```

The GPU distribution command currently builds for Apple Silicon. The regular platform-independent tile client remains available for PCs without a GPU profile.

This installation reuses the already-paired Sunshine identity in the Mac's private `Orbit/video-identity.json`, with a certificate-pinned per-PC `video` profile in `orbit-client.json`. These files contain private credentials and must never be committed or included in installers. New-PC GPU provisioning is not yet exposed in the Electron pairing UI. Existing tile pairing still works.

The installed profile uses Sunshine on port 48989, direct LAN with Tailscale fallback, HEVC when the platform decoder supports it, and a 120 fps target. The application displays measured received/rendered frame rate and network round-trip time; the target is not a guarantee. Quality settings select 25/12/6 Mbps. Crisp uses the selected monitor’s native resolution (up to 3840×2160); Balanced and Low Data use 1080p. Monitor mappings belong to each PC because Windows Forms and DXGI enumerate displays in different orders.

The transport keeps at most eight compressed video frames awaiting decoder acknowledgement, requests a new keyframe after any encoded-frame drop, and bounds the decoder queue after startup. Decoded frames are drawn immediately and released. The standard remote cursor is included in video and the duplicate Mac cursor is hidden. Mouse input uses up to 250 updates/sec with a trailing update to avoid losing the final position.

The legacy control connection is closed while viewing the GPU desktop, so its tile stream does not compete with GPU video. Terminal/Files/Processes reconnect it on demand. Screen blanking remains disabled.

Known limits: the cursor is still subject to the video/network round trip; Wi-Fi jitter can prevent 120 fps. A per-PC local-cursor metadata channel, new-PC GPU provisioning UI, and automatic bitrate negotiation are future work, not features of this build.
