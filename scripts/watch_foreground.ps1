param(
    [int]$IntervalMs = 250,
    # Capri's process: the watcher stops when she does, even if she crashed
    [int]$ParentPid = 0
)

# Streams the window the user is working in, one JSON line each time it changes:
# which window, where it is (real pixels), whether it covers its whole monitor, and what Windows
# says about interrupting the user right now (SHQueryUserNotificationState)

$code = @"
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ForegroundWatch {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int pquns);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    static Dictionary<uint, string> names = new Dictionary<uint, string>();

    static string ProcessName(uint pid) {
        string name;
        if (names.TryGetValue(pid, out name)) return name;
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { name = ""; }
        names[pid] = name;
        return name;
    }

    static string Esc(string s) {
        var sb = new StringBuilder();
        foreach (char c in s) {
            if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
            else if (c < 32) sb.Append(' ');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static bool Alive(int pid) {
        if (pid <= 0) return true;
        try { return !Process.GetProcessById(pid).HasExited; } catch { return false; }
    }

    public static void Run(int intervalMs, int parentPid) {
        // Real pixels on every monitor, like the other window scripts (Capri converts them)
        try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch {} }

        string last = "";
        int ticks = 0;
        while (true) {
            if (++ticks % 8 == 0 && !Alive(parentPid)) return;
            IntPtr hWnd = GetForegroundWindow();
            int quns = 0;
            try { SHQueryUserNotificationState(out quns); } catch {}

            string line;
            RECT r;
            if (hWnd == IntPtr.Zero || !GetWindowRect(hWnd, out r)) {
                line = "{\"Hwnd\":0,\"Quns\":" + quns + "}";
            } else {
                var title = new StringBuilder(256); GetWindowText(hWnd, title, 256);
                var cls = new StringBuilder(128); GetClassName(hWnd, cls, 128);
                uint pid; GetWindowThreadProcessId(hWnd, out pid);

                // Covers its whole monitor, taskbar included, without being a maximized window
                bool fullscreen = false;
                IntPtr mon = MonitorFromWindow(hWnd, 2);
                var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
                if (mon != IntPtr.Zero && GetMonitorInfo(mon, ref mi) && !IsZoomed(hWnd)) {
                    fullscreen = r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top &&
                                 r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
                }

                line = string.Format(
                    "{{\"Hwnd\":{0},\"Pid\":{1},\"Process\":\"{2}\",\"Class\":\"{3}\",\"Title\":\"{4}\",\"Left\":{5},\"Top\":{6},\"Width\":{7},\"Height\":{8},\"Fullscreen\":{9},\"Quns\":{10}}}",
                    (long)hWnd, pid, Esc(ProcessName(pid)), Esc(cls.ToString()), Esc(title.ToString()),
                    r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, fullscreen ? "true" : "false", quns);
            }

            if (line != last) {
                last = line;
                Console.WriteLine(line);
                Console.Out.Flush();
            }
            Thread.Sleep(intervalMs);
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
} catch {
    # already loaded
}

[ForegroundWatch]::Run($IntervalMs, $ParentPid)
