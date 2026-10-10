# Orbit

A rounded, minimalist native remote-PC app for Windows → Mac. The Windows companion manages a local Sunshine host; the native client uses a pinned Moonlight engine with Orbit's interface and a requested 1080p / 120 fps profile. Your actual console desktop, audio, mouse, and keyboard are streamed. No Electron or browser runs inside the client.

## First test

1. Orbit Host guides you through **Protect PC → Allow access → Connect Mac**. Choose a password of at least 12 characters and click **Save & continue**. If Windows permission is needed, click **Allow connections** and approve the administrator prompt. Permission that is already enabled is detected automatically. For a portable installation, download the Windows host ZIP from the [private release](https://github.com/aaronbiscotti/orbit-remote/releases/latest), extract it, and open **Launch Orbit.cmd**. On later launches, enter your saved login and click **Unlock & continue**.
2. Download the macOS ZIP from the [private release](https://github.com/aaronbiscotti/orbit-remote/releases/latest), extract it on the Mac, and move `Orbit.app` to Applications. It supports Apple Silicon and Intel Macs running macOS 13 or newer. This is a development build, locally signed, not Apple-notarized. If macOS blocks it, use the standard Privacy & Security “Open Anyway” flow for this app. Do not disable Gatekeeper globally.
3. With both devices on the same network, click **Add PC** in Orbit on the Mac and enter the address shown on Orbit Host. Click the PC card. The Mac displays a four-digit pairing code.
4. Orbit Host automatically shows the code field when your Mac requests pairing. Enter the code and click **Pair Mac**. If multiple devices are waiting, select the intended device first. The host validates the cryptographic handshake; a wrong code fails. Your client saves its device certificate for future connections.
5. On the Mac, click your PC and select **Desktop**. Use **Settings** to adjust resolution, frame rate, bitrate, and the decoder. The footer says **Requested**; it does not claim a measured 120 fps. Use Control+Option+Shift+S to toggle the streaming statistics overlay. Control+Option+Shift+Q disconnects.

The client is a native Qt application, not a Swift client. Hardware decoding on macOS comes from Moonlight's VideoToolbox/Metal renderer. Hardware acceleration is detected at runtime; software fallback is possible and triggers a warning. Default profile: 1920×1080, 120 fps requested, absolute mouse mode, automatic codec/decoder selection, Discord presence disabled. No performance measurements on a physical Mac have been made yet.

## While away

Install [Tailscale](https://tailscale.com/download) on the PC and Mac, sign in to the same account, and enter the PC's Tailscale address in **Add PC**. Use `tailscale ping <pc>` on the Mac to verify a direct connection. Relay connections can be too slow for high-bitrate video. No router port forwarding is configured. Sunshine's admin interface is limited to localhost; you manage device authorization locally on the PC.

For your personal devices, use a personal account whose tailnet you control. A school or employer domain may place you in a shared organization tailnet with its own administrators and access policies. See [Tailscale's device visibility explanation](https://tailscale.com/docs/concepts/device-visibility).

The PC must stay powered, logged into an interactive desktop, and awake. Orbit Host includes an optional keep-awake checkbox, released when its window closes. This initial portable host is not a Windows service; it does not provide reliable access to the login screen after reboot or UAC secure desktop. Autorun, wake-on-LAN and service installation are future work. Sunshine continues running after closing the companion; `scripts/stop-host.ps1` stops this project's instance.

Click **Allow connections** when prompted by Orbit Host and approve Windows' administrator prompt to add the inbound firewall rules. The app verifies the active rules before advancing. **More options → Check access** checks permission again. You can also run `scripts/enable-firewall.ps1` in an administrator PowerShell. It scopes streaming ports to your local subnet and Tailscale address range and leaves the admin port unopened. No firewall settings are changed by the normal launcher. Run the companion from the project folder so it can find its runtime and setup scripts.

## Displays and limitations

One host display streams at a time. Switch with Control+Option+Shift+F1…F12 on the Mac; Fn may also be needed. Simultaneous windows for all host monitors are **not implemented**. 120 fps requires suitable host and client display modes, hardware decode, and sufficient network bandwidth. There is no zero-latency guarantee.

The client still includes Moonlight's mature app grid and advanced settings; the connection screen, cards, toolbar, pairing dialogs, and default profile are customized for Orbit. Access credentials use the upstream engine's certificate store, not a newly implemented macOS Keychain integration.

## Build

```powershell
git clone --recurse-submodules https://github.com/aaronbiscotti/orbit-remote.git
cd orbit-remote
dotnet run --project tests/Orbit.Tests -c Release
dotnet publish host/Orbit.Host -c Release -r win-x64 --self-contained true -o dist/Orbit-Host
./scripts/setup-host.ps1
./scripts/start-host.ps1
```

Requires .NET SDK 8 for building; the published Windows host includes its runtime. Portable Sunshine is pinned to `v2026.914.233613` and its download is checked against GitHub's SHA-256 digest. On Windows, runtime/profile files stay under ignored `runtime/`. The profile directory is restricted to the current user, SYSTEM and administrators. Existing settings are preserved on rerun. Admin passwords are not persisted by Orbit, and TLS validates the exact certificate from this project's local Sunshine profile. Both LAN and WAN streams require encryption.

Client builds require Qt 6.11.2, Python 3, recursive submodules and the upstream build prerequisites. Apply `python scripts/apply-client.py`, then run `scripts/build-client-windows.ps1` from an MSVC developer shell, or `bash scripts/build-client-mac.sh` on macOS. GitHub Actions builds all three packages. The Moonlight submodule is pinned to `a57e947d7185fd01384f6973df4df59ae2968d01`; overlays are deterministic and checked with `python scripts/apply-client.py --check`.

The client intentionally stays in its pinned, modified submodule locally. All modifications are reproduced from tracked overlays; the parent Git status will show `vendor/moonlight` as modified. Use `git submodule update --init --recursive` after cloning, then apply the overlay. Do not commit host profiles, client certificates, logs, or generated binaries.

GPL-3.0; see [NOTICE](NOTICE) and [LICENSE](LICENSE). This project builds on Sunshine and Moonlight and preserves their notices.
