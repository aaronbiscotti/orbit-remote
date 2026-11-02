# Orbit

A rounded, minimalist native **Remote OS Takeover** app for Windows → Mac. Instead of continuous high-bitrate game streaming that freezes or blurs on fluctuating networks, Orbit uses an **event-driven dirty-tile desktop protocol** over pinned TLS (`0 KB/s` when static) paired with a **`LocalSystem` (`NT AUTHORITY\SYSTEM`) session takeover engine** and native Mac panels for Terminal, Files, and Task Manager.

## Why Remote OS Takeover instead of Video Streaming?

1. **Zero Idle Bitrate & Backpressure-Paced Dirty Tiles**:
   - Only changed `128×128` screen regions are hashed, encoded (`PNG` for lossless crisp text or adaptive `JPEG`), and transmitted over TLS TCP (`47995`).
   - When your Windows desktop is static, Orbit sends **0 KB/s**.
   - Every frame delta waits for a lightweight `frame_ack` before sending the next delta, eliminating frame backlog, black screens, and UDP packet-loss corruption over Tailscale or weak Wi-Fi.
2. **Full `SYSTEM` & UAC Administrator Prompt (`WinSta0\Winlogon`) Control**:
   - Standard user or even elevated user-desktop streaming processes go blind when Windows switches to the **`WinSta0\Winlogon` Secure Desktop** for **UAC Administrator prompts** or the **Windows Lock / Login Screen**.
   - Orbit's Windows host includes a native `LocalSystem` service (`OrbitHostService`) that spawns the session takeover agent inside the active console session (`WTSGetActiveConsoleSessionId()`) as `NT AUTHORITY\SYSTEM`, dynamically attaching its capture and input threads via `OpenInputDesktop` / `SetThreadDesktop` to both `WinSta0\Default` and `WinSta0\Winlogon`.
   - You can see and click **"Yes" on UAC Administrator prompts**, interact with elevated Task Manager/apps, send `Ctrl+Alt+Delete` (`SendSAS`), and unlock the Windows Lock Screen remotely from your Mac.
3. **Native OS Control Panels (Zero Video Bandwidth)**:
   - **Desktop Takeover**: Interactive dirty-tile desktop with Mac `⌘ Command ⇄ Ctrl` shortcut translation, dynamic resolution matching (`Fit Window`), and a **Physical PC Privacy Curtain** (`WDA_EXCLUDEFROMCAPTURE`) that blanks your physical PC monitor while you work from your Mac.
   - **Remote Terminal**: Execute PowerShell or CMD commands directly on your PC as Administrator/`SYSTEM` and read output as pure text.
   - **Remote Files**: Browse Windows drives and folders, download files to your Mac (`~/Downloads`), and upload files from your Mac to your PC.
   - **Remote Processes**: Inspect running Windows processes (with PID, RAM usage, and `Elevated` status), end stuck tasks, or lock/restart the PC.

## Quick Start

1. Open **Orbit Host** on your Windows PC. It guides you through **Protect PC → Allow access → Connect Mac**:
   - **Protect PC**: Choose an Orbit Host password (at least 12 characters) and click **Save & continue**.
   - **Allow access**: Click **Allow connections** and approve the Windows prompt to add scoped firewall rules (`LocalSubnet` and Tailscale `100.64.0.0/10` on TCP port `47995`).
   - **Enable Administrator & UAC Takeover**: Click **Enable administrator control** once while at the PC and approve UAC. This registers `OrbitHostService` (`LocalSystem`) and starts the `SYSTEM` session takeover agent so UAC prompts and elevated apps remain controllable while you are away.
2. On your Mac, open `Orbit.app`, click **Add PC**, and enter your PC's LAN or Tailscale (`100.x.x.x`) address.
3. Click **Pair This Mac →** on the PC card. A 4-digit pairing code appears on your Mac.
4. Enter the 4-digit code in **Orbit Host** on your PC and click **Pair Mac →**. Orbit verifies the cryptographic commitment and pins both devices' identities.
5. Click **Take Over PC →** on your Mac to take control of your Windows PC.

## Build & Verify

```powershell
dotnet run --project tests/Orbit.Tests -c Release
dotnet publish host/Orbit.Host -c Release -r win-x64 --self-contained true -o dist/Orbit-Host
./scripts/setup-host.ps1
./scripts/start-host.ps1
```

Client builds require Qt 6 (`QtCore`, `QtGui`, `QtNetwork`, `QtQml`, `QtQuick`, `QtQuickControls2`) and Python 3:
- Verify client sources: `python scripts/apply-client.py --check`
- Build Windows client: `./scripts/build-client-windows.ps1`
- Build Universal macOS client (`Orbit.app`): `bash scripts/build-client-mac.sh`

GPL-3.0; see [NOTICE](NOTICE) and [LICENSE](LICENSE).
