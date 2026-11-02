# Orbit Client

Orbit is a native Qt 6 (`QtCore`, `QtGui`, `QtNetwork`, `QtQml`, `QtQuick`, `QtQuickControls2`) remote OS takeover client for macOS (`Orbit.app`) and Windows (`Orbit.exe`). It does not embed a browser or Electron.

Instead of continuous video streaming, the client speaks Orbit's length-prefixed TLS takeover protocol (`47995`):
- **Dirty-tile desktop canvas (`DesktopCanvas`)**: Receives only changed `128×128` tiles (`0 KB/s` when static) and sends `frame_ack` backpressure acknowledgements after each frame paint.
- **Cryptographic 4-digit PIN pairing & server TLS pinning (`OrbitBackend`)**: Pairs using a SHA-256 server certificate commitment and authenticates sessions with channel-bound `HMAC-SHA256`.
- **Full OS Takeover Controls**: Interactive desktop (`WinSta0\Default` and `WinSta0\Winlogon` UAC / Lock Screen), `Ctrl+Alt+Del` (`SendSAS`), physical PC Privacy Curtain (`WDA_EXCLUDEFROMCAPTURE`), dynamic window resolution matching, bidirectional clipboard sync, remote PowerShell/CMD terminal, remote file explorer & transfer, and remote Windows Task Manager.
