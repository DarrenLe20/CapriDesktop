param(
    [Parameter(Mandatory=$true)]
    [long]$Hwnd
)

$code = @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class WindowTracker {
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // Real pixels on every monitor, same as get_windowed_apps.ps1 (Capri converts them)
    static void UsePhysicalPixels() {
        try {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
        } catch {}
        try { SetProcessDPIAware(); } catch {}
    }

    public static void Track(long hwndLong) {
        UsePhysicalPixels();
        IntPtr hWnd = new IntPtr(hwndLong);
        int lastL = -99999, lastT = -99999, lastW = -99999, lastH = -99999;

        while (true) {
            if (!IsWindow(hWnd) || !IsWindowVisible(hWnd) || IsIconic(hWnd)) {
                Console.WriteLine("CLOSED");
                Console.Out.Flush();
                break;
            }

            RECT r;
            if (GetWindowRect(hWnd, out r)) {
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (r.Left != lastL || r.Top != lastT || w != lastW || h != lastH) {
                    lastL = r.Left;
                    lastT = r.Top;
                    lastW = w;
                    lastH = h;
                    Console.WriteLine(string.Format("{0},{1},{2},{3}", r.Left, r.Top, w, h));
                    Console.Out.Flush();
                }
            } else {
                Console.WriteLine("CLOSED");
                Console.Out.Flush();
                break;
            }

            Thread.Sleep(30);
        }
    }
}
"@

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
} catch {
    # already loaded
}

[WindowTracker]::Track($Hwnd)
