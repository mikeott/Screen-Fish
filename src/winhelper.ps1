$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class RRWin {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int i);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);

    static readonly HashSet<string> SkipClasses = new HashSet<string> {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"
    };

    // Physical pixel coordinates on every display
    public static void InitDpi() {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) { }
        try { SetProcessDPIAware(); } catch (Exception) { }
    }

    static string Esc(string s) {
        var sb = new StringBuilder("\"");
        foreach (char c in s ?? "") {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string Title(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ClassName(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // Visible frame bounds without the invisible resize border
    static bool Bounds(IntPtr h, out RECT r) {
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true;
        return GetWindowRect(h, out r);
    }

    static string AppName(uint pid, Dictionary<uint, string> cache) {
        string name;
        if (cache.TryGetValue(pid, out name)) return name;
        name = "";
        try {
            using (var p = Process.GetProcessById((int)pid)) {
                name = p.ProcessName;
                try {
                    var d = p.MainModule.FileVersionInfo.FileDescription;
                    if (!string.IsNullOrWhiteSpace(d)) name = d.Trim();
                } catch (Exception) { }
            }
        } catch (Exception) { }
        cache[pid] = name;
        return name;
    }

    static string Virtual() {
        return "{\"x\":" + GetSystemMetrics(76) + ",\"y\":" + GetSystemMetrics(77) +
               ",\"width\":" + GetSystemMetrics(78) + ",\"height\":" + GetSystemMetrics(79) + "}";
    }

    public static string List() {
        var sb = new StringBuilder("[");
        var cache = new Dictionary<uint, string>();
        bool first = true;

        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            if ((GetWindowLongW(h, -20) & 0x80) != 0) return true;

            int cloaked;
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;

            string title = Title(h);
            if (title.Length == 0 || SkipClasses.Contains(ClassName(h))) return true;

            RECT r;
            if (!Bounds(h, out r) || r.R - r.L < 40 || r.B - r.T < 40) return true;

            uint pid;
            GetWindowThreadProcessId(h, out pid);

            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"hwnd\":").Append(h.ToInt64())
              .Append(",\"pid\":").Append(pid)
              .Append(",\"title\":").Append(Esc(title))
              .Append(",\"app\":").Append(Esc(AppName(pid, cache)))
              .Append(",\"x\":").Append(r.L).Append(",\"y\":").Append(r.T)
              .Append(",\"width\":").Append(r.R - r.L).Append(",\"height\":").Append(r.B - r.T)
              .Append('}');
            return true;
        }, IntPtr.Zero);

        return "{\"windows\":" + sb.Append(']') + ",\"virtual\":" + Virtual() + "}";
    }

    public static string Rect(long id) {
        var h = new IntPtr(id);
        if (!IsWindow(h)) return "{\"exists\":false}";
        RECT r;
        Bounds(h, out r);
        return "{\"exists\":true,\"minimized\":" + (IsIconic(h) ? "true" : "false") +
               ",\"x\":" + r.L + ",\"y\":" + r.T + ",\"width\":" + (r.R - r.L) + ",\"height\":" + (r.B - r.T) +
               ",\"virtual\":" + Virtual() + "}";
    }

    public static string Front(long id) {
        var h = new IntPtr(id);
        if (!IsWindow(h)) return "{\"exists\":false}";
        if (IsIconic(h)) ShowWindow(h, 9);
        if (!SetForegroundWindow(h)) {
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(h);
        }
        return "{\"exists\":true}";
    }
}
'@

[RRWin]::InitDpi()
[Console]::Out.WriteLine('{"id":0,"ok":true,"ready":true}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $p = $line.Trim().Split(' ')
    if ($p.Length -lt 2) { continue }
    $id = [int]$p[0]
    try {
        switch ($p[1]) {
            'list'  { $json = [RRWin]::List() }
            'rect'  { $json = [RRWin]::Rect([Int64]$p[2]) }
            'front' { $json = [RRWin]::Front([Int64]$p[2]) }
            default { $json = 'null' }
        }
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"data":' + $json + '}')
    } catch {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false}')
    }
    [Console]::Out.Flush()
}
