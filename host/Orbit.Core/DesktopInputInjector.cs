using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Orbit.Core;

public static class DesktopInputInjector
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x01000;
    private const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint KEYEVENTF_SCANCODE = 0x0008;

    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    public static void InjectMouse(int monitorIndex, string action, double normX, double normY, string button, int deltaX, int deltaY)
    {
        if (!OperatingSystem.IsWindows()) return;
        _ = SecureDesktopManager.AttachThreadToInputDesktop();

        var monitors = DesktopCaptureEngine.GetMonitors();
        if (monitorIndex < 0 || monitorIndex >= monitors.Count) monitorIndex = 0;
        var mon = monitors[monitorIndex];

        normX = Math.Clamp(normX, 0.0, 1.0);
        normY = Math.Clamp(normY, 0.0, 1.0);

        var targetX = mon.Left + (int)Math.Round(normX * Math.Max(1, mon.Width - 1));
        var targetY = mon.Top + (int)Math.Round(normY * Math.Max(1, mon.Height - 1));

        var vLeft = GetSystemMetrics(SM_XVIRTUALSCREEN);
        var vTop = GetSystemMetrics(SM_YVIRTUALSCREEN);
        var vWidth = Math.Max(1, GetSystemMetrics(SM_CXVIRTUALSCREEN));
        var vHeight = Math.Max(1, GetSystemMetrics(SM_CYVIRTUALSCREEN));

        var absX = (int)Math.Round(((targetX - vLeft) * 65535.0) / Math.Max(1, vWidth - 1));
        var absY = (int)Math.Round(((targetY - vTop) * 65535.0) / Math.Max(1, vHeight - 1));

        _ = SetCursorPos(targetX, targetY);

        var flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        uint mouseData = 0;

        switch (action.ToLowerInvariant())
        {
            case "down":
                flags |= ButtonFlag(button, down: true);
                break;
            case "up":
                flags |= ButtonFlag(button, down: false);
                break;
            case "click":
                SendMouseSingle(absX, absY, flags | ButtonFlag(button, true), 0);
                SendMouseSingle(absX, absY, flags | ButtonFlag(button, false), 0);
                return;
            case "dblclick":
                for (var i = 0; i < 2; i++)
                {
                    SendMouseSingle(absX, absY, flags | ButtonFlag(button, true), 0);
                    SendMouseSingle(absX, absY, flags | ButtonFlag(button, false), 0);
                }
                return;
            case "wheel":
                if (deltaY != 0)
                {
                    SendMouseSingle(absX, absY, flags | MOUSEEVENTF_WHEEL, unchecked((uint)deltaY));
                }
                if (deltaX != 0)
                {
                    SendMouseSingle(absX, absY, flags | MOUSEEVENTF_HWHEEL, unchecked((uint)deltaX));
                }
                return;
        }

        SendMouseSingle(absX, absY, flags, mouseData);
    }

    private static uint ButtonFlag(string button, bool down) => button.ToLowerInvariant() switch
    {
        "right" => down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP,
        "middle" => down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP,
        _ => down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP
    };

    private static void SendMouseSingle(int dx, int dy, uint dwFlags, uint mouseData)
    {
        var input = new INPUT
        {
            type = INPUT_MOUSE,
            u = new InputUnion
            {
                mi = new MOUSEINPUT
                {
                    dx = dx,
                    dy = dy,
                    mouseData = mouseData,
                    dwFlags = dwFlags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        var sent = SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>());
        if (sent == 0)
        {
            // Fallback for desktops restricting SendInput
            mouse_event(dwFlags, (uint)dx, (uint)dy, mouseData, UIntPtr.Zero);
        }
    }

    public static void InjectKey(string action, ushort vk, bool ctrl, bool alt, bool shift, bool win)
    {
        if (!OperatingSystem.IsWindows() || vk == 0) return;
        _ = SecureDesktopManager.AttachThreadToInputDesktop();

        switch (action.ToLowerInvariant())
        {
            case "down":
                SendVirtualKey(vk, keyUp: false);
                break;
            case "up":
                SendVirtualKey(vk, keyUp: true);
                break;
            case "shortcut":
            case "press":
                if (ctrl) SendVirtualKey(0x11, false); // VK_CONTROL
                if (alt) SendVirtualKey(0x12, false);  // VK_MENU
                if (shift) SendVirtualKey(0x10, false); // VK_SHIFT
                if (win) SendVirtualKey(0x5B, false);   // VK_LWIN
                SendVirtualKey(vk, false);
                SendVirtualKey(vk, true);
                if (win) SendVirtualKey(0x5B, true);
                if (shift) SendVirtualKey(0x10, true);
                if (alt) SendVirtualKey(0x12, true);
                if (ctrl) SendVirtualKey(0x11, true);
                break;
        }
    }

    public static void InjectText(string text)
    {
        if (!OperatingSystem.IsWindows() || string.IsNullOrEmpty(text)) return;
        _ = SecureDesktopManager.AttachThreadToInputDesktop();

        var inputs = new List<INPUT>(text.Length * 2);
        foreach (var ch in text)
        {
            if (ch == '\r') continue;
            if (ch == '\n')
            {
                SendVirtualKey(0x0D, false);
                SendVirtualKey(0x0D, true);
                continue;
            }
            inputs.Add(new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE } }
            });
            inputs.Add(new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } }
            });
        }
        if (inputs.Count > 0)
        {
            var arr = inputs.ToArray();
            _ = SendInput((uint)arr.Length, arr, Marshal.SizeOf<INPUT>());
        }
    }

    private static void SendVirtualKey(ushort vk, bool keyUp)
    {
        var scan = (ushort)MapVirtualKeyW(vk, 0 /* MAPVK_VK_TO_VSC */);
        var flags = keyUp ? KEYEVENTF_KEYUP : 0u;
        if (IsExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
        if (scan != 0) flags |= KEYEVENTF_SCANCODE;

        var input = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = vk,
                    wScan = scan,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        if (SendInput(1, new[] { input }, Marshal.SizeOf<INPUT>()) == 0)
        {
            keybd_event((byte)vk, (byte)scan, flags, UIntPtr.Zero);
        }
    }

    private static bool IsExtendedKey(ushort vk) => vk is
        0x21 or 0x22 or 0x23 or 0x24 or // PageUp, PageDown, End, Home
        0x25 or 0x26 or 0x27 or 0x28 or // Arrow keys
        0x2D or 0x2E or                 // Insert, Delete
        0x5B or 0x5C or                 // Left/Right Win
        0xA3 or 0xA5;                   // Right Ctrl, Right Alt

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint MapVirtualKeyW(uint uCode, uint uMapType);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);
}

/// <summary>
/// Dynamically resizes the Windows display resolution to match the Mac client and restores it on disconnect,
/// and manages the physical PC Privacy Curtain (blanking the physical monitor via WDA_EXCLUDEFROMCAPTURE while
/// still allowing remote screen capture).
/// </summary>
public static class DisplayTakeoverManager
{
    private const int ENUM_CURRENT_SETTINGS = -1;
    private const int DM_PELSWIDTH = 0x00080000;
    private const int DM_PELSHEIGHT = 0x00100000;
    private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    private static DEVMODEW? savedMode;
    private static Thread? curtainThread;
    private static Form? curtainForm;
    private static volatile bool curtainActive;

    public static bool IsPrivacyCurtainActive => curtainActive;

    public static bool SetResolution(int width, int height)
    {
        if (!OperatingSystem.IsWindows() || width < 800 || height < 600) return false;
        var mode = new DEVMODEW { dmSize = (short)Marshal.SizeOf<DEVMODEW>() };
        if (!EnumDisplaySettingsW(null, ENUM_CURRENT_SETTINGS, ref mode)) return false;

        if (savedMode == null) savedMode = mode;
        if (mode.dmPelsWidth == width && mode.dmPelsHeight == height) return true;

        mode.dmPelsWidth = width;
        mode.dmPelsHeight = height;
        mode.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
        return ChangeDisplaySettingsW(ref mode, 0) == 0;
    }

    public static void RestoreResolution()
    {
        if (!OperatingSystem.IsWindows() || savedMode == null) return;
        var mode = savedMode.Value;
        _ = ChangeDisplaySettingsW(ref mode, 0);
        savedMode = null;
    }

    public static void SetPrivacyCurtain(bool enabled)
    {
        if (!OperatingSystem.IsWindows()) return;
        if (!enabled)
        {
            curtainActive = false;
            var form = curtainForm;
            if (form != null && !form.IsDisposed)
            {
                try { form.BeginInvoke(new Action(() => form.Close())); } catch { }
            }
            curtainForm = null;
            return;
        }

        if (curtainActive && curtainForm != null && !curtainForm.IsDisposed) return;
        curtainActive = true;

        curtainThread = new Thread(() =>
        {
            try
            {
                var bounds = SystemInformation.VirtualScreen;
                var form = new Form
                {
                    FormBorderStyle = FormBorderStyle.None,
                    StartPosition = FormStartPosition.Manual,
                    Bounds = bounds,
                    BackColor = Color.FromArgb(10, 12, 16),
                    TopMost = true,
                    ShowInTaskbar = false,
                    Text = "Orbit Privacy Curtain"
                };

                var label = new Label
                {
                    Text = "◌  Orbit Remote Takeover Active\nPhysical screen blanked while controlled from your Mac",
                    ForeColor = Color.FromArgb(140, 150, 175),
                    Font = new Font("Segoe UI", 15, FontStyle.Regular),
                    TextAlign = ContentAlignment.MiddleCenter,
                    Dock = DockStyle.Fill
                };
                form.Controls.Add(label);

                form.Shown += (_, _) =>
                {
                    // WDA_EXCLUDEFROMCAPTURE hides this black curtain window from BitBlt/DXGI capture so the
                    // Mac user sees the real Windows desktop while anyone physically at the PC sees a locked black screen!
                    _ = SetWindowDisplayAffinity(form.Handle, WDA_EXCLUDEFROMCAPTURE);
                };

                curtainForm = form;
                Application.Run(form);
            }
            catch { }
            finally
            {
                curtainActive = false;
            }
        })
        { IsBackground = true };
        curtainThread.SetApartmentState(ApartmentState.STA);
        curtainThread.Start();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DEVMODEW
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettingsW(string? lpszDeviceName, int iModeNum, ref DEVMODEW lpDevMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsW(ref DEVMODEW lpDevMode, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
}
