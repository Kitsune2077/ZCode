using System;
using System.Runtime.InteropServices;

namespace ZCode.Uninstaller
{
    internal static class NativeMethods
    {
        [DllImport("shell32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        internal static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
    }
}
