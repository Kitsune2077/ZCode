using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

namespace ZCode.Uninstaller
{
    internal static class ShellCleanup
    {
        public static ShellCleanupResult Delete(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log)
        {
            var result = new ShellCleanupResult();
            if (options.NoShortcuts)
            {
                log.Write("shortcut-cleanup-skipped reason=test-flag");
                return result;
            }

            var shortcuts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            AddShortcuts(shortcuts, Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), log);
            AddShortcuts(shortcuts, Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), log);
            AddShortcuts(shortcuts, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), log);
            AddShortcuts(shortcuts, Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory), log);

            AddShortcuts(
                shortcuts,
                Path.Combine(
                    context.AppDataDir,
                    "Microsoft",
                    "Internet Explorer",
                    "Quick Launch",
                    "User Pinned",
                    "TaskBar"),
                log);

            foreach (string shortcut in shortcuts)
            {
                string target = ReadShortcutTarget(shortcut);
                if (string.IsNullOrWhiteSpace(target))
                {
                    log.Write("shortcut-skipped path=" + shortcut + " reason=target-unreadable");
                    if (string.Equals(
                            Path.GetFileNameWithoutExtension(shortcut),
                            context.ShortcutName,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        result.FailedCount++;
                        result.Success = false;
                    }

                    continue;
                }

                if (!PathUtil.IsUnderDirectory(target, context.InstallDir))
                {
                    continue;
                }

                if (TryDeleteShortcut(shortcut, log))
                {
                    result.DeletedCount++;
                }
                else
                {
                    result.FailedCount++;
                    result.Success = false;
                }
            }

            DeleteMenuDirectory(context, log);
            NativeMethods.SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
            log.Write("shortcut-cleanup-completed deleted=" + result.DeletedCount +
                      " failed=" + result.FailedCount);
            return result;
        }

        private static void AddShortcuts(
            HashSet<string> shortcuts,
            string directory,
            UninstallerLog log)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory))
            {
                return;
            }

            try
            {
                foreach (string path in Directory.EnumerateFiles(directory, "*.lnk", SearchOption.AllDirectories))
                {
                    shortcuts.Add(path);
                }
            }
            catch (Exception exception)
            {
                log.Write("shortcut-scan-failed path=" + directory + " message=" + exception.Message);
            }
        }

        private static void DeleteMenuDirectory(InstallContext context, UninstallerLog log)
        {
            if (string.IsNullOrWhiteSpace(context.MenuDirectory))
            {
                return;
            }

            DeleteMenuDirectoryUnder(
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                context.MenuDirectory,
                log);
            DeleteMenuDirectoryUnder(
                Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
                context.MenuDirectory,
                log);
        }

        private static void DeleteMenuDirectoryUnder(string startMenu, string menuDirectory, UninstallerLog log)
        {
            if (string.IsNullOrWhiteSpace(startMenu) ||
                string.IsNullOrWhiteSpace(menuDirectory) ||
                menuDirectory.IndexOfAny(new[] { '\\', '/', ':' }) >= 0 ||
                menuDirectory.Contains(".."))
            {
                if (!string.IsNullOrWhiteSpace(menuDirectory))
                {
                    log.Write("shortcut-menu-skipped reason=invalid-menu-directory value=" + menuDirectory);
                }

                return;
            }

            string directory = Path.Combine(startMenu, "Programs", menuDirectory);
            try
            {
                if (Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any())
                {
                    Directory.Delete(directory, false);
                    log.Write("shortcut-menu-deleted path=" + directory);
                }
            }
            catch (Exception exception)
            {
                log.Write("shortcut-menu-delete-failed path=" + directory + " message=" + exception.Message);
            }
        }

        private static bool TryDeleteShortcut(string path, UninstallerLog log)
        {
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    File.SetAttributes(path, FileAttributes.Normal);
                    File.Delete(path);
                    log.Write("shortcut-deleted path=" + path);
                    return true;
                }
                catch (Exception exception)
                {
                    if (attempt == 3)
                    {
                        log.WriteFailure(path, "shortcut-delete-failed", exception.HResult & 0xFFFF, exception.Message);
                        return false;
                    }

                    Thread.Sleep(150);
                }
            }

            return false;
        }

        private static string ReadShortcutTarget(string path)
        {
            object shell = null;
            object shortcut = null;
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null)
                {
                    return null;
                }

                shell = Activator.CreateInstance(shellType);
                shortcut = shellType.InvokeMember(
                    "CreateShortcut",
                    BindingFlags.InvokeMethod,
                    null,
                    shell,
                    new object[] { path });
                if (shortcut == null)
                {
                    return null;
                }

                return shortcut.GetType().InvokeMember(
                    "TargetPath",
                    BindingFlags.GetProperty,
                    null,
                    shortcut,
                    null) as string;
            }
            catch
            {
                return null;
            }
            finally
            {
                ReleaseComObject(shortcut);
                ReleaseComObject(shell);
            }
        }

        private static void ReleaseComObject(object value)
        {
            if (value == null || !Marshal.IsComObject(value))
            {
                return;
            }

            try
            {
                Marshal.FinalReleaseComObject(value);
            }
            catch
            {
                // COM 释放失败不影响清理结果。
            }
        }
    }
}
