using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace ZCode.Uninstaller
{
    /// <summary>
    /// 只按安装路径识别 electron-builder 的安装/卸载键，不按产品名盲删。
    /// 这样同机的便携版、Preview 版或另一个自定义安装目录不会被误清理。
    /// </summary>
    internal static class RegistryCleanup
    {
        private const string UninstallSubKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";

        public static RegistryFootprint Discover(string installDir, bool skip)
        {
            var footprint = new RegistryFootprint();
            if (skip || string.IsNullOrWhiteSpace(installDir))
            {
                return footprint;
            }

            foreach (Root root in EnumerateRoots())
            {
                using (root)
                {
                    DiscoverUninstallKeys(root, installDir, footprint);
                    DiscoverInstallKeys(root, installDir, footprint);
                }
            }

            return footprint;
        }

        public static string FindInstallDirByProduct(string productName)
        {
            if (string.IsNullOrWhiteSpace(productName))
            {
                return null;
            }

            foreach (Root root in EnumerateRoots())
            {
                using (root)
                {
                    using (RegistryKey uninstall = root.Key.OpenSubKey(UninstallSubKey))
                    {
                        if (uninstall == null)
                        {
                            continue;
                        }

                        foreach (string name in uninstall.GetSubKeyNames())
                        {
                            using (RegistryKey key = uninstall.OpenSubKey(name))
                            {
                                if (key == null)
                                {
                                    continue;
                                }

                                string displayName = key.GetValue("DisplayName") as string;
                                string uninstallString = key.GetValue("UninstallString") as string;
                                if (!MatchesProduct(displayName, productName))
                                {
                                    continue;
                                }

                                string executable = PathUtil.ExtractExecutablePath(uninstallString);
                                if (string.IsNullOrEmpty(executable))
                                {
                                    continue;
                                }

                                string directory = System.IO.Path.GetDirectoryName(executable);
                                if (!string.IsNullOrEmpty(directory))
                                {
                                    return directory;
                                }
                            }
                        }
                    }
                }
            }

            return null;
        }

        public static bool Delete(InstallContext context, CommandLineOptions options, UninstallerLog log)
        {
            if (options.NoRegistry)
            {
                log.Write("registry-cleanup-skipped reason=test-flag");
                return true;
            }

            bool success = true;
            foreach (RegistryKeyRef key in context.Footprint.UninstallKeys)
            {
                success &= DeleteKey(key, "uninstall", log);
            }

            foreach (RegistryKeyRef key in context.Footprint.InstallKeys)
            {
                success &= DeleteKey(key, "install", log);
            }

            success &= DeleteProtocolIfOwned(context, log);
            success &= DeleteContextMenuIfOwned(context, "Directory", log);
            success &= DeleteContextMenuIfOwned(context, "Drive", log);
            return success;
        }

        private static void DiscoverUninstallKeys(Root root, string installDir, RegistryFootprint footprint)
        {
            try
            {
                using (RegistryKey uninstall = root.Key.OpenSubKey(UninstallSubKey))
                {
                    if (uninstall == null)
                    {
                        return;
                    }

                    foreach (string name in uninstall.GetSubKeyNames())
                    {
                        try
                        {
                            using (RegistryKey key = uninstall.OpenSubKey(name))
                            {
                                if (key == null)
                                {
                                    continue;
                                }

                                string uninstallString = key.GetValue("UninstallString") as string;
                                string installLocation = key.GetValue("InstallLocation") as string;
                                if (!MatchesInstall(uninstallString, installLocation, installDir))
                                {
                                    continue;
                                }

                                footprint.UninstallKeys.Add(new RegistryKeyRef
                                {
                                    Hive = root.Hive,
                                    View = root.View,
                                    SubKey = UninstallSubKey + "\\" + name,
                                    DisplayName = key.GetValue("DisplayName") as string,
                                    UninstallString = uninstallString,
                                    InstallLocation = installLocation,
                                    ShortcutName = key.GetValue("ShortcutName") as string,
                                    MenuDirectory = key.GetValue("MenuDirectory") as string,
                                });
                            }
                        }
                        catch
                        {
                            // 单个受保护/损坏的键不应让整个卸载器失去入口发现能力。
                        }
                    }
                }
            }
            catch
            {
                // 注册表视图不可读时继续尝试其他视图；安装目录本身仍是主判据。
            }
        }

        private static void DiscoverInstallKeys(Root root, string installDir, RegistryFootprint footprint)
        {
            try
            {
                using (RegistryKey software = root.Key.OpenSubKey("Software"))
                {
                    if (software == null)
                    {
                        return;
                    }

                    foreach (string name in software.GetSubKeyNames())
                    {
                        if (IsReservedSoftwareKey(name))
                        {
                            continue;
                        }

                        try
                        {
                            using (RegistryKey key = software.OpenSubKey(name))
                            {
                                if (key == null)
                                {
                                    continue;
                                }

                                string installLocation = key.GetValue("InstallLocation") as string;
                                if (!PathUtil.SamePath(installLocation, installDir))
                                {
                                    continue;
                                }

                                var reference = new RegistryKeyRef
                                {
                                    Hive = root.Hive,
                                    View = root.View,
                                    SubKey = "Software\\" + name,
                                    DisplayName = key.GetValue("DisplayName") as string,
                                    InstallLocation = installLocation,
                                    ShortcutName = key.GetValue("ShortcutName") as string,
                                    MenuDirectory = key.GetValue("MenuDirectory") as string,
                                };
                                footprint.InstallKeys.Add(reference);

                                if (footprint.ShortcutName == null &&
                                    !string.IsNullOrEmpty(reference.ShortcutName))
                                {
                                    footprint.ShortcutName = reference.ShortcutName;
                                }

                                if (footprint.MenuDirectory == null &&
                                    !string.IsNullOrEmpty(reference.MenuDirectory))
                                {
                                    footprint.MenuDirectory = reference.MenuDirectory;
                                }
                            }
                        }
                        catch
                        {
                            // 同上：受保护的 Software 子键不阻断其他安装键的发现。
                        }
                    }
                }
            }
            catch
            {
                // 某个注册表视图不可读时继续尝试其他视图。
            }
        }

        private static bool MatchesInstall(string uninstallString, string installLocation, string installDir)
        {
            if (PathUtil.SamePath(installLocation, installDir))
            {
                return true;
            }

            string executable = PathUtil.ExtractExecutablePath(uninstallString);
            return PathUtil.IsUnderDirectory(executable, installDir);
        }

        private static bool MatchesProduct(string displayName, string productName)
        {
            if (string.IsNullOrWhiteSpace(displayName) || string.IsNullOrWhiteSpace(productName))
            {
                return false;
            }

            return displayName.Equals(productName, StringComparison.OrdinalIgnoreCase) ||
                   displayName.StartsWith(productName + " ", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsReservedSoftwareKey(string name)
        {
            return name.Equals("Microsoft", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Classes", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Policies", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("RegisteredApplications", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("WOW6432Node", StringComparison.OrdinalIgnoreCase);
        }

        private static bool DeleteKey(RegistryKeyRef reference, string kind, UninstallerLog log)
        {
            try
            {
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(reference.Hive, reference.View))
                {
                    using (RegistryKey existing = baseKey.OpenSubKey(reference.SubKey))
                    {
                        if (existing == null)
                        {
                            log.Write("registry-skipped kind=" + kind + " hive=" + reference.Hive +
                                      " key=" + reference.SubKey + " reason=missing");
                            return true;
                        }
                    }

                    baseKey.DeleteSubKeyTree(reference.SubKey, false);
                }

                log.Write("registry-deleted kind=" + kind + " hive=" + reference.Hive + " key=" + reference.SubKey);
                return true;
            }
            catch (UnauthorizedAccessException exception)
            {
                log.WriteFailure(reference.SubKey, "registry-access-denied", 5, exception.Message);
                return false;
            }
            catch (Exception exception)
            {
                log.WriteFailure(reference.SubKey, "registry-error", 0, exception.Message);
                return false;
            }
        }

        private static bool DeleteProtocolIfOwned(InstallContext context, UninstallerLog log)
        {
            const string protocol = @"Software\Classes\zcode";
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(protocol + @"\shell\open\command"))
                {
                    if (key == null)
                    {
                        return true;
                    }

                    string command = key.GetValue(null) as string;
                    string executable = PathUtil.ExtractExecutablePath(command);
                    if (!PathUtil.IsUnderDirectory(executable, context.InstallDir))
                    {
                        log.Write("registry-skipped kind=protocol reason=not-owned");
                        return true;
                    }
                }

                Registry.CurrentUser.DeleteSubKeyTree(protocol, false);
                log.Write("registry-deleted kind=protocol key=" + protocol);
                return true;
            }
            catch (UnauthorizedAccessException exception)
            {
                log.WriteFailure(protocol, "registry-access-denied", 5, exception.Message);
                return false;
            }
            catch (Exception exception)
            {
                log.WriteFailure(protocol, "registry-error", 0, exception.Message);
                return false;
            }
        }

        private static bool DeleteContextMenuIfOwned(InstallContext context, string scope, UninstallerLog log)
        {
            string path = @"Software\Classes\" + scope + @"\shell\ZCode.OpenInZCode";
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path))
                {
                    if (key == null)
                    {
                        return true;
                    }

                    string command = null;
                    using (RegistryKey commandKey = key.OpenSubKey("command"))
                    {
                        if (commandKey != null)
                        {
                            command = commandKey.GetValue(null) as string;
                        }
                    }

                    string icon = key.GetValue("Icon") as string;
                    bool owned = PathUtil.IsUnderDirectory(PathUtil.ExtractExecutablePath(command), context.InstallDir) ||
                                 PathUtil.IsUnderDirectory(PathUtil.ExtractExecutablePath(icon), context.InstallDir);
                    if (!owned)
                    {
                        log.Write("registry-skipped kind=context-menu scope=" + scope + " reason=not-owned");
                        return true;
                    }
                }

                Registry.CurrentUser.DeleteSubKeyTree(path, false);
                log.Write("registry-deleted kind=context-menu scope=" + scope + " key=" + path);
                return true;
            }
            catch (UnauthorizedAccessException exception)
            {
                log.WriteFailure(path, "registry-access-denied", 5, exception.Message);
                return false;
            }
            catch (Exception exception)
            {
                log.WriteFailure(path, "registry-error", 0, exception.Message);
                return false;
            }
        }

        private static IEnumerable<Root> EnumerateRoots()
        {
            Root currentUser = TryCreateRoot(RegistryHive.CurrentUser, RegistryView.Default);
            if (currentUser != null)
            {
                yield return currentUser;
            }

            Root machine64 = TryCreateRoot(RegistryHive.LocalMachine, RegistryView.Registry64);
            if (machine64 != null)
            {
                yield return machine64;
            }

            Root machine32 = TryCreateRoot(RegistryHive.LocalMachine, RegistryView.Registry32);
            if (machine32 != null)
            {
                yield return machine32;
            }
        }

        private static Root TryCreateRoot(RegistryHive hive, RegistryView view)
        {
            try
            {
                return new Root(hive, view);
            }
            catch
            {
                return null;
            }
        }

        private sealed class Root : IDisposable
        {
            public Root(RegistryHive hive, RegistryView view)
            {
                Hive = hive;
                View = view;
                Key = RegistryKey.OpenBaseKey(hive, view);
            }

            public RegistryHive Hive { get; }
            public RegistryView View { get; }
            public RegistryKey Key { get; }

            public void Dispose()
            {
                Key.Dispose();
            }
        }
    }
}
