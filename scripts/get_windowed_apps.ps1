Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WindowedAppHelper {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

    public const int DWMWA_CLOAKED = 14;

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

    public const uint MONITOR_DEFAULTTONULL = 0;

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    // Real pixels on every monitor (Capri converts them). Without this, a window on a monitor with another
    // scale than the main one comes back at the wrong place
    public static void UsePhysicalPixels() {
        try {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
        } catch {}
        try { SetProcessDPIAware(); } catch {}
    }

    public class WindowEntry {
        public long Hwnd;
        public string Title;
        public int Left;
        public int Top;
        public int Width;
        public int Height;
        public bool IsBrowser;
        public int ZOrder;
    }

    public static List<WindowEntry> GetWindowedApps(int screenWidth, int screenHeight) {
        UsePhysicalPixels();
        IntPtr hwinsta = OpenWindowStation("WinSta0", false, 0x037F);
        if (hwinsta != IntPtr.Zero) SetProcessWindowStation(hwinsta);
        IntPtr hdesk = OpenDesktop("Default", 0, false, 0x01FF);
        if (hdesk != IntPtr.Zero) SetThreadDesktop(hdesk);

        var list = new List<WindowEntry>();
        int order = 0;

        EnumDesktopWindows(hdesk, (hWnd, lParam) => {
            order++;
            if (!IsWindowVisible(hWnd) || IsIconic(hWnd) || IsZoomed(hWnd)) return true;

            int cloaked = 0;
            DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int));
            if (cloaked != 0) return true;

            RECT r;
            if (!GetWindowRect(hWnd, out r)) return true;
            int w = r.Right - r.Left;
            int h = r.Bottom - r.Top;

            // Filter out tiny windows/widgets
            if (w < 320 || h < 220) return true;

            // Filter out windows on no monitor at all. Negative positions are fine: that's a monitor
            // to the left of (or above) the main one
            IntPtr monitor = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONULL);
            if (monitor == IntPtr.Zero) return true;

            // Filter out maximized or near full-screen snapped windows (leaving at least some room for windowed mode),
            // measured against the window's own monitor
            int monW = screenWidth;
            int monH = screenHeight;
            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(monitor, ref mi)) {
                monW = mi.rcMonitor.Right - mi.rcMonitor.Left;
                monH = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
            }
            if (w >= (monW - 30) && h >= (monH - 85)) return true;

            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString().Trim();
            if (string.IsNullOrEmpty(title)) return true;

            string lower = title.ToLowerInvariant();
            if (lower == "program manager" ||
                lower.Contains("overlay") ||
                lower.Contains("experiencia de entrada") ||
                lower.Contains("input experience") ||
                lower.Contains("capri") ||
                lower.Contains("cyber companion") ||
                lower.Contains("capri desktop") ||
                lower.Contains("taskbar") ||
                lower.Contains("default ime") ||
                lower.Contains("msctfime ui")) return true;

            // Check if process name or title is a browser
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            string procName = "";
            try {
                if (pid > 0) {
                    var proc = System.Diagnostics.Process.GetProcessById((int)pid);
                    procName = proc.ProcessName.ToLowerInvariant();
                }
            } catch {}

            bool isBrowser = lower.Contains("opera") ||
                             lower.Contains("chrome") ||
                             lower.Contains("edge") ||
                             lower.Contains("brave") ||
                             lower.Contains("firefox") ||
                             procName.Contains("opera") ||
                             procName.Contains("chrome") ||
                             procName.Contains("msedge") ||
                             procName.Contains("brave") ||
                             procName.Contains("firefox");

            list.Add(new WindowEntry {
                Hwnd = (long)hWnd,
                Title = title,
                Left = r.Left,
                Top = r.Top,
                Width = w,
                Height = h,
                IsBrowser = isBrowser,
                ZOrder = order
            });

            return true;
        }, IntPtr.Zero);

        return list;
    }
}
"@

try {
    Add-Type -AssemblyName System.Windows.Forms
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    $sw = $screen.Bounds.Width
    $sh = $screen.Bounds.Height
} catch {
    $sw = 1920
    $sh = 1080
}

$apps = [WindowedAppHelper]::GetWindowedApps($sw, $sh)
# Sort browsers first, then by Z-order
$sorted = $apps | Sort-Object { if ($_.IsBrowser) { 0 } else { 1 } }, ZOrder

$json = $sorted | ConvertTo-Json -Compress
if ($null -eq $json -or $json -eq "") {
    Write-Output "[]"
} else {
    # If single object, format as array
    if (-not $json.StartsWith("[")) {
        $json = "[$json]"
    }
    Write-Output $json
}
