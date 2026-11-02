# Orbit

A high-performance, installable **Electron + Native SIMD/SYSTEM Remote OS Takeover** application for Windows (Host + Client) and macOS (Client). Instead of continuous high-bitrate video streaming that freezes or blurs on fluctuating networks, Orbit pairs a GPU-accelerated Electron interface with a native C# / Win32 / AVX2 SIMD **`LocalSystem` (`NT AUTHORITY\SYSTEM`) session takeover engine** over pinned TLS (`0 KB/s` when static).

## Why Orbit Remote OS Takeover Instead of Video Streaming?

1. **Zero Idle Bitrate & Sub-Millisecond Hardware AVX2 SIMD Dirty Tiles**:
   - Captures the desktop directly into a persistent Win32 `CreateDIBSection` (`SRCCOPY | CAPTUREBLT`) with zero per-frame allocations.
   - Diffs `1920×1080` frames in **`0.84 ms` (`1,191 fps` capacity)** using hardware AVX2 `Vector256<byte>` SIMD intrinsics, crops tight dirty sub-rectangles, and encodes only the changed pixels (`PNG` for lossless text or adaptive `JPEG`).
   - Renders dirty sub-tiles directly onto a GPU-accelerated `<canvas desynchronized="true">` in Electron using asynchronous off-thread `createImageBitmap()` decoding and `ArrayBuffer` zero-copy IPC.
   - Waits for a lightweight `frame_ack` after every delta so frames never queue up or corrupt over weak Wi-Fi or Tailscale. When your desktop is static, Orbit sends **`0 KB/s`**.
2. **Full `SYSTEM` & UAC Administrator Prompt (`WinSta0\Winlogon`) Control**:
   - Standard user or even elevated user-desktop streaming processes go blind when Windows switches to the **`WinSta0\Winlogon` Secure Desktop** for **UAC Administrator prompts** or the **Windows Lock / Login Screen**.
   - Orbit's bundled Windows engine includes a native `LocalSystem` service (`OrbitHostService`) that spawns the takeover agent inside the active console session (`WTSGetActiveConsoleSessionId()`) as `NT AUTHORITY\SYSTEM`, dynamically attaching its capture and input threads via `OpenInputDesktop` / `SetThreadDesktop` to both `WinSta0\Default` and `WinSta0\Winlogon`.
   - You can see and click **"Yes" on UAC Administrator prompts**, interact with elevated Task Manager/apps, send `Ctrl+Alt+Delete` (`SendSAS`), and unlock the Windows Lock Screen remotely from your Mac.
3. **Native OS Control Panels (Zero Video Bandwidth)**:
   - **Desktop Takeover**: Interactive dirty-tile desktop with Mac `⌘ Command ⇄ Ctrl` shortcut translation, dynamic resolution matching (`Fit Window`), and a **Physical PC Privacy Curtain** (`WDA_EXCLUDEFROMCAPTURE`) that blanks your physical PC monitor while you work from your Mac.
   - **Remote Terminal**: Execute PowerShell or CMD commands directly on your PC as Administrator/`SYSTEM` and read output as pure text.
   - **Remote Files**: Browse Windows drives and folders, download files to your Mac (`~/Downloads`), and upload files from your Mac to your PC.
   - **Remote Processes**: Inspect running Windows processes (with PID, RAM usage, and `Elevated` status), end stuck tasks, or lock/restart the PC.

## Install & Quick Start

### 1. Install Orbit
- **Windows PC**: Run **`Orbit Setup 1.0.0.exe`** (in `dist/electron/` or from GitHub Actions `Orbit-Windows-Installer`) to install the unified Orbit Electron app with the bundled native `Orbit.Host` engine.
- **Mac**: Open **`Orbit-1.0.0-universal.dmg`** (from GitHub Actions `Orbit-macOS-Installer`) and drag `Orbit.app` to `Applications`.

### 2. Set Up Your Windows PC (**Host This PC** tab)
1. Open **Orbit** on your Windows PC. The bundled native takeover engine (`127.0.0.1:47990` / TLS `47995`) starts automatically.
2. Under **Step 1 · Protect This PC**, set an Orbit Host password (at least 12 characters) and click **Save Password**.
3. Under **Step 2 · Windows Firewall & UAC Service**, click:
   - **Allow Firewall (`47995`)** to allow LAN and Tailscale (`100.64.0.0/10`) connections.
   - **Enable SYSTEM & UAC Takeover** once while at the PC and approve the UAC prompt. This registers `OrbitHostService` (`LocalSystem`) so UAC prompts and the lock screen remain visible and clickable when you are away.

### 3. Connect & Take Over from Your Mac (**Remote Takeover** tab)
1. Open **Orbit** on your Mac and enter your PC's LAN IP or Tailscale (`100.x.x.x`) IP.
2. Click **Pair This Device →**. A 4-digit pairing PIN appears on your Mac.
3. Enter that 4-digit PIN in **Step 3 · Pair a Remote Mac or PC** on your Windows PC and click **Pair Device →**.
4. Click **Take Over PC →** on your Mac to take control of your Windows PC.

## Build & Verify from Source

```powershell
# 1. Run native SIMD + protocol + SYSTEM architecture unit tests (47 assertions)
dotnet run --project tests/Orbit.Tests -c Release

# 2. Publish native Windows takeover engine (bundled into Electron extraResources)
dotnet publish host/Orbit.Host -c Release -r win-x64 --self-contained true -o dist/Orbit-Host

# 3. Install Electron dependencies & run smoke test
npm install
npm run smoke

# 4. Build installable packages
npm run dist:win   # Produces dist/electron/Orbit Setup 1.0.0.exe
npm run dist:mac   # Produces dist/electron/Orbit-1.0.0-universal.dmg (on macOS)
```

GPL-3.0; see [NOTICE](NOTICE) and [LICENSE](LICENSE).
