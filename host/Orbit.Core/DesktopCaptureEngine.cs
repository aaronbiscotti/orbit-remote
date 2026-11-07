using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;
using System.Windows.Forms;

namespace Orbit.Core;

public sealed record MonitorDescriptor(int Index, string Name, int Width, int Height, int Left, int Top, bool Primary);

public sealed record TileDescriptor(int X, int Y, int W, int H, int Offset, int Length, string Format);

public sealed record CapturedFrameDelta(
    long Sequence,
    int ScreenWidth,
    int ScreenHeight,
    string DesktopName,
    bool IsSecureDesktop,
    string Privilege,
    int CursorX,
    int CursorY,
    bool FullFrame,
    IReadOnlyList<TileDescriptor> Tiles,
    byte[] Payload);

/// <summary>
/// Zero-allocation Win32 CreateDIBSection screen capture paired with AVX2 Vector256 SIMD
/// pixel diffing and sub-tile tight bounding-box cropping.
/// </summary>
public sealed unsafe class DesktopCaptureEngine : IDisposable
{
    public const int TileSize = 256;

    private const int SRCCOPY = 0x00CC0020;
    private const int CAPTUREBLT = 0x40000000;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;
    private const uint DIB_RGB_COLORS = 0;
    private const uint BI_RGB = 0;

    // Persistent Win32 DIB Section resources (allocated once per resolution)
    private IntPtr memDc;
    private IntPtr dibBitmap;
    private IntPtr oldBitmap;
    private byte* dibBits;
    private Bitmap? dibWrappedBitmap;
    private int dibWidth;
    private int dibHeight;

    // Persistent 32-byte aligned previous-frame pixel buffer for AVX2 Vector256 SIMD comparison
    private byte* prevFrameBuffer;
    private nuint prevBufferBytes;
    private int prevWidth;
    private int prevHeight;

    // Reusable tile scratch buffers to avoid per-frame allocations
    private readonly MemoryStream payloadStream = new(256 * 1024);
    private readonly Bitmap fullTileScratch = new(TileSize, TileSize, PixelFormat.Format32bppRgb);
    private readonly Graphics fullTileGraphics;

    private int previousMonitor = -1;
    private string previousDesktop = "";
    private string previousQuality = "";
    private long sequence;
    private bool disposed;

    private static readonly ImageCodecInfo? JpegEncoder = ImageCodecInfo.GetImageDecoders()
        .FirstOrDefault(c => c.FormatID == ImageFormat.Jpeg.Guid);

    public DesktopCaptureEngine()
    {
        fullTileGraphics = Graphics.FromImage(fullTileScratch);
        fullTileGraphics.CompositingMode = CompositingMode.SourceCopy;
        fullTileGraphics.InterpolationMode = InterpolationMode.NearestNeighbor;
    }

    public static IReadOnlyList<MonitorDescriptor> GetMonitors()
    {
        try
        {
            var screens = Screen.AllScreens;
            if (screens.Length > 0)
            {
                return screens.Select((s, i) => new MonitorDescriptor(
                    i,
                    $"Display {i + 1}",
                    s.Bounds.Width,
                    s.Bounds.Height,
                    s.Bounds.Left,
                    s.Bounds.Top,
                    s.Primary)).ToArray();
            }
        }
        catch { }

        var w = Math.Max(GetSystemMetrics(SM_CXSCREEN), 1280);
        var h = Math.Max(GetSystemMetrics(SM_CYSCREEN), 720);
        return new[] { new MonitorDescriptor(0, "Display 1", w, h, 0, 0, true) };
    }

    public void Invalidate()
    {
        prevWidth = 0;
        prevHeight = 0;
    }

    public CapturedFrameDelta CaptureNextDelta(int monitorIndex, string quality, bool forceFullFrame)
    {
        var desktopState = SecureDesktopManager.AttachThreadToInputDesktop();
        var monitors = GetMonitors();
        if (monitorIndex < 0 || monitorIndex >= monitors.Count) monitorIndex = 0;
        var mon = monitors[monitorIndex];

        GetCursorPos(out var pt);
        var relCursorX = Math.Clamp(pt.X - mon.Left, 0, Math.Max(1, mon.Width - 1));
        var relCursorY = Math.Clamp(pt.Y - mon.Top, 0, Math.Max(1, mon.Height - 1));

        var desktopChanged = !string.Equals(previousDesktop, desktopState.Name, StringComparison.OrdinalIgnoreCase)
            || previousMonitor != monitorIndex
            || !string.Equals(previousQuality, quality, StringComparison.OrdinalIgnoreCase);

        previousDesktop = desktopState.Name;
        previousMonitor = monitorIndex;
        previousQuality = quality;

        if (TryCaptureDirectToDib(mon.Left, mon.Top, mon.Width, mon.Height) && dibWrappedBitmap != null)
        {
            return ComputeDeltaCore(
                dibBits,
                mon.Width * 4,
                dibWrappedBitmap,
                mon.Width,
                mon.Height,
                desktopState.Name,
                desktopState.IsSecureDesktop,
                SecureDesktopManager.PrivilegeLabel(desktopState.Privilege),
                relCursorX,
                relCursorY,
                quality,
                forceFullFrame || desktopChanged);
        }

        using var fallback = CreateDiagnosticBitmap(mon.Width, mon.Height, desktopState);
        return ComputeDeltaFromBitmap(
            fallback,
            desktopState.Name,
            desktopState.IsSecureDesktop,
            SecureDesktopManager.PrivilegeLabel(desktopState.Privilege),
            relCursorX,
            relCursorY,
            quality,
            forceFullFrame || desktopChanged);
    }

    public CapturedFrameDelta ComputeDeltaFromBitmap(
        Bitmap bitmap,
        string desktopName,
        bool isSecureDesktop,
        string privilege,
        int cursorX,
        int cursorY,
        string quality,
        bool forceFullFrame)
    {
        var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var bmpData = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            return ComputeDeltaCore(
                (byte*)bmpData.Scan0,
                bmpData.Stride,
                null,
                bitmap.Width,
                bitmap.Height,
                desktopName,
                isSecureDesktop,
                privilege,
                cursorX,
                cursorY,
                quality,
                forceFullFrame,
                bmpData);
        }
        finally
        {
            bitmap.UnlockBits(bmpData);
        }
    }

    private CapturedFrameDelta ComputeDeltaCore(
        byte* currBase,
        int stride,
        Bitmap? directBitmap,
        int width,
        int height,
        string desktopName,
        bool isSecureDesktop,
        string privilege,
        int cursorX,
        int cursorY,
        string quality,
        bool forceFullFrame,
        BitmapData? lockedData = null)
    {
        var full = forceFullFrame || prevWidth != width || prevHeight != height || prevFrameBuffer == null;
        EnsurePreviousFrameBuffer(width, height, stride);

        var cols = (width + TileSize - 1) / TileSize;
        var rows = (height + TileSize - 1) / TileSize;
        var dirtyRects = new List<Rectangle>();

        for (var r = 0; r < rows; r++)
        {
            var tileY = r * TileSize;
            var tileH = Math.Min(TileSize, height - tileY);

            for (var c = 0; c < cols; c++)
            {
                var tileX = c * TileSize;
                var tileW = Math.Min(TileSize, width - tileX);

                if (full)
                {
                    CopyTileToPreviousBuffer(currBase, prevFrameBuffer, stride, tileX, tileY, tileW, tileH);
                    dirtyRects.Add(new Rectangle(tileX, tileY, tileW, tileH));
                }
                else if (TryFindDirtySubRectSimd(currBase, prevFrameBuffer, stride, tileX, tileY, tileW, tileH, out var subRect))
                {
                    dirtyRects.Add(subRect);
                }
            }
        }

        if (dirtyRects.Count == 0)
        {
            return new CapturedFrameDelta(
                sequence,
                width,
                height,
                desktopName,
                isSecureDesktop,
                privilege,
                cursorX,
                cursorY,
                false,
                Array.Empty<TileDescriptor>(),
                Array.Empty<byte>());
        }

        sequence++;
        payloadStream.Position = 0;
        payloadStream.SetLength(0);

        var descriptors = new List<TileDescriptor>(dirtyRects.Count);
        var usePng = string.Equals(quality, "crisp", StringComparison.OrdinalIgnoreCase);
        var jpegQuality = string.Equals(quality, "low", StringComparison.OrdinalIgnoreCase) ? 55L : 82L;

        using var encoderParams = new EncoderParameters(1);
        encoderParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, jpegQuality);

        foreach (var rect in dirtyRects)
        {
            var offset = (int)payloadStream.Position;
            string format;

            if (rect.Width == TileSize && rect.Height == TileSize && directBitmap != null)
            {
                fullTileGraphics.DrawImage(directBitmap, new Rectangle(0, 0, TileSize, TileSize), rect, GraphicsUnit.Pixel);
                format = WriteTileImage(fullTileScratch, payloadStream, usePng, encoderParams);
            }
            else
            {
                // Wrap the exact sub-rectangle scanline pointer directly with zero pixel copying!
                var subScan0 = (IntPtr)(currBase + rect.Y * stride + rect.X * 4);
                using var subView = new Bitmap(rect.Width, rect.Height, stride, PixelFormat.Format32bppRgb, subScan0);
                format = WriteTileImage(subView, payloadStream, usePng, encoderParams);
            }

            var length = (int)payloadStream.Position - offset;
            descriptors.Add(new TileDescriptor(rect.X, rect.Y, rect.Width, rect.Height, offset, length, format));
        }

        return new CapturedFrameDelta(
            sequence,
            width,
            height,
            desktopName,
            isSecureDesktop,
            privilege,
            cursorX,
            cursorY,
            full,
            descriptors,
            payloadStream.ToArray());
    }

    /// <summary>
    /// Uses AVX2 / Vector256 SIMD (32 bytes = 8 pixels per instruction) to detect changed rows inside a macro-tile,
    /// computes the tight bounding box of modified pixels, and updates the previous-frame buffer in-place.
    /// </summary>
    [MethodImpl(MethodImplOptions.AggressiveOptimization)]
    private static bool TryFindDirtySubRectSimd(
        byte* currBase,
        byte* prevBase,
        int stride,
        int tileX,
        int tileY,
        int tileW,
        int tileH,
        out Rectangle dirtySubRect)
    {
        var minY = int.MaxValue;
        var maxY = -1;
        var minX = int.MaxValue;
        var maxX = -1;
        var rowBytes = tileW * 4;

        for (var y = 0; y < tileH; y++)
        {
            var absY = tileY + y;
            var offset = absY * stride + tileX * 4;
            var currRow = currBase + offset;
            var prevRow = prevBase + offset;

            if (!RowsEqualSimd(currRow, prevRow, rowBytes, out var firstDiffPixel, out var lastDiffPixel))
            {
                if (y < minY) minY = y;
                maxY = y;
                if (firstDiffPixel < minX) minX = firstDiffPixel;
                if (lastDiffPixel > maxX) maxX = lastDiffPixel;

                Buffer.MemoryCopy(currRow, prevRow, rowBytes, rowBytes);
            }
        }

        if (maxY < 0)
        {
            dirtySubRect = default;
            return false;
        }

        // Pad tight bounding box slightly to 4-pixel boundaries for clean sub-tile encoding
        var localX = Math.Max(0, minX & ~3);
        var localY = Math.Max(0, minY & ~3);
        var localRight = Math.Min(tileW, (maxX + 4) & ~3);
        var localBottom = Math.Min(tileH, (maxY + 4) & ~3);

        var w = Math.Max(4, localRight - localX);
        var h = Math.Max(4, localBottom - localY);
        if (localX + w > tileW) w = tileW - localX;
        if (localY + h > tileH) h = tileH - localY;

        dirtySubRect = new Rectangle(tileX + localX, tileY + localY, w, h);
        return true;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining | MethodImplOptions.AggressiveOptimization)]
    private static bool RowsEqualSimd(byte* currRow, byte* prevRow, int byteLength, out int firstDiffPixel, out int lastDiffPixel)
    {
        var i = 0;
        var foundDiff = false;
        firstDiffPixel = 0;
        lastDiffPixel = 0;

        if (Vector256.IsHardwareAccelerated && byteLength >= 32)
        {
            for (; i <= byteLength - 32; i += 32)
            {
                var vCurr = Vector256.Load(currRow + i);
                var vPrev = Vector256.Load(prevRow + i);
                if (!Vector256.EqualsAll(vCurr, vPrev))
                {
                    var pixelStart = i >> 2;
                    if (!foundDiff)
                    {
                        foundDiff = true;
                        firstDiffPixel = pixelStart;
                    }
                    lastDiffPixel = pixelStart + 7;
                }
            }
        }

        for (; i < byteLength; i += 4)
        {
            if (*(uint*)(currRow + i) != *(uint*)(prevRow + i))
            {
                var px = i >> 2;
                if (!foundDiff)
                {
                    foundDiff = true;
                    firstDiffPixel = px;
                }
                lastDiffPixel = px;
            }
        }

        return !foundDiff;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static void CopyTileToPreviousBuffer(byte* currBase, byte* prevBase, int stride, int tileX, int tileY, int tileW, int tileH)
    {
        var rowBytes = tileW * 4;
        for (var y = 0; y < tileH; y++)
        {
            var offset = (tileY + y) * stride + tileX * 4;
            Buffer.MemoryCopy(currBase + offset, prevBase + offset, rowBytes, rowBytes);
        }
    }

    private void EnsurePreviousFrameBuffer(int width, int height, int stride)
    {
        var needed = (nuint)(Math.Abs(stride) * height);
        if (prevFrameBuffer == null || prevBufferBytes < needed)
        {
            if (prevFrameBuffer != null)
            {
                NativeMemory.AlignedFree(prevFrameBuffer);
                prevFrameBuffer = null;
            }
            prevFrameBuffer = (byte*)NativeMemory.AlignedAlloc(needed, 32);
            prevBufferBytes = needed;
            NativeMemory.Clear(prevFrameBuffer, needed);
        }
        prevWidth = width;
        prevHeight = height;
    }

    private bool TryCaptureDirectToDib(int left, int top, int width, int height)
    {
        var screenDc = GetDC(IntPtr.Zero);
        if (screenDc == IntPtr.Zero) return false;

        try
        {
            if (memDc == IntPtr.Zero || dibBitmap == IntPtr.Zero || dibWidth != width || dibHeight != height)
            {
                ReleaseDibResources();
                memDc = CreateCompatibleDC(screenDc);
                if (memDc == IntPtr.Zero) return false;

                var bmi = new BITMAPINFOHEADER
                {
                    biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                    biWidth = width,
                    biHeight = -height, // Top-down DIB section
                    biPlanes = 1,
                    biBitCount = 32,
                    biCompression = BI_RGB
                };

                dibBitmap = CreateDIBSection(screenDc, ref bmi, DIB_RGB_COLORS, out var ppvBits, IntPtr.Zero, 0);
                if (dibBitmap == IntPtr.Zero || ppvBits == IntPtr.Zero)
                {
                    ReleaseDibResources();
                    return false;
                }

                oldBitmap = SelectObject(memDc, dibBitmap);
                dibBits = (byte*)ppvBits;
                dibWidth = width;
                dibHeight = height;
                dibWrappedBitmap = new Bitmap(width, height, width * 4, PixelFormat.Format32bppRgb, ppvBits);
            }

            return BitBlt(memDc, 0, 0, width, height, screenDc, left, top, SRCCOPY | CAPTUREBLT);
        }
        finally
        {
            _ = ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    private static string WriteTileImage(Bitmap tile, Stream output, bool usePng, EncoderParameters encoderParams)
    {
        if (usePng || JpegEncoder == null)
        {
            tile.Save(output, ImageFormat.Png);
            return "png";
        }
        tile.Save(output, JpegEncoder, encoderParams);
        return "jpeg";
    }

    private static Bitmap CreateDiagnosticBitmap(int dstW, int dstH, DesktopState desktopState)
    {
        var fallback = new Bitmap(dstW, dstH, PixelFormat.Format32bppArgb);
        using var gfx = Graphics.FromImage(fallback);
        gfx.Clear(Color.FromArgb(16, 18, 24));
        using var cardBrush = new SolidBrush(Color.FromArgb(27, 31, 42));
        using var accentBrush = new SolidBrush(Color.FromArgb(183, 197, 255));
        using var textBrush = new SolidBrush(Color.FromArgb(238, 241, 250));
        using var titleFont = new Font("Segoe UI", 18, FontStyle.Bold);
        using var bodyFont = new Font("Segoe UI", 11, FontStyle.Regular);

        var cardRect = new Rectangle(Math.Max(20, (dstW - 620) / 2), Math.Max(20, (dstH - 220) / 2), Math.Min(620, dstW - 40), 220);
        gfx.FillRectangle(cardBrush, cardRect);
        var title = desktopState.IsSecureDesktop
            ? "Windows Secure Desktop (UAC / Lock Screen) is active"
            : "Waiting for interactive Windows display";
        var hint = desktopState.Privilege == PrivilegeTier.System
            ? "Switching thread desktop to WinSta0\\Winlogon…"
            : "Enable OS Takeover Service (SYSTEM) in Orbit Host to view and approve UAC prompts and the Windows Lock Screen.";
        gfx.DrawString(title, titleFont, accentBrush, new RectangleF(cardRect.X + 28, cardRect.Y + 36, cardRect.Width - 56, 60));
        gfx.DrawString(hint, bodyFont, textBrush, new RectangleF(cardRect.X + 28, cardRect.Y + 104, cardRect.Width - 56, 80));
        return fallback;
    }

    private void ReleaseDibResources()
    {
        dibWrappedBitmap?.Dispose();
        dibWrappedBitmap = null;
        if (memDc != IntPtr.Zero && oldBitmap != IntPtr.Zero)
        {
            _ = SelectObject(memDc, oldBitmap);
            oldBitmap = IntPtr.Zero;
        }
        if (dibBitmap != IntPtr.Zero)
        {
            _ = DeleteObject(dibBitmap);
            dibBitmap = IntPtr.Zero;
        }
        if (memDc != IntPtr.Zero)
        {
            _ = DeleteDC(memDc);
            memDc = IntPtr.Zero;
        }
        dibBits = null;
        dibWidth = 0;
        dibHeight = 0;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        ReleaseDibResources();
        if (prevFrameBuffer != null)
        {
            NativeMemory.AlignedFree(prevFrameBuffer);
            prevFrameBuffer = null;
        }
        fullTileGraphics.Dispose();
        fullTileScratch.Dispose();
        payloadStream.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateDIBSection(IntPtr hdc, [In] ref BITMAPINFOHEADER pbmi, uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr hgdiobj);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool BitBlt(IntPtr hdc, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hdcSrc, int nXSrc, int nYSrc, int dwRop);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);
}
