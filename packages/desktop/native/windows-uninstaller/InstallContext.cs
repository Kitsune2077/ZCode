using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Principal;

namespace ZCode.Uninstaller
{
    internal sealed class InstallContext
    {
        public string InstallDir { get; private set; }
        public string ProductName { get; private set; }
        public string ProductVersion { get; private set; }
        public string AppExePath { get; private set; }
        public string OfficialUninstallerPath { get; private set; }
        public RegistryFootprint Footprint { get; private set; }
        public bool IsPortable { get; private set; }
        public bool AllUsers { get; private set; }
        public bool IsElevated { get; private set; }
        public bool RequiresElevation { get; private set; }
        public string ShortcutName { get; private set; }
        public string MenuDirectory { get; private set; }
        public string UserProfileDir { get; private set; }
        public string AppDataDir { get; private set; }
        public string LocalAppDataDir { get; private set; }

        public static InstallContext Resolve(CommandLineOptions options, UninstallerLog log)
        {
            string productName = BuildInfo.ProductName;
            string installDir = ResolveInstallDir(options, productName);
            if (string.IsNullOrWhiteSpace(installDir))
            {
                throw new InvalidOperationException("无法确定 ZCode 安装目录。");
            }

            installDir = Path.GetFullPath(installDir.Trim());
            if (installDir.Length > 3)
            {
                installDir = installDir.TrimEnd('\\', '/');
            }

            string driveRoot = Path.GetPathRoot(installDir);
            if (!string.IsNullOrEmpty(driveRoot) &&
                string.Equals(
                    driveRoot.TrimEnd('\\', '/'),
                    installDir.TrimEnd('\\', '/'),
                    StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("安装目录不能是驱动器根目录。");
            }

            RegistryFootprint footprint = RegistryCleanup.Discover(installDir, options.NoRegistry);
            string official = FindOfficialUninstaller(installDir);
            bool isPortable = official == null && !footprint.HasAny;

            bool allUsers = options.AllUsers ||
                            (!options.CurrentUser &&
                             (footprint.HasMachineKeys || IsUnderProgramFiles(installDir)));
            bool elevated = ElevationHelper.IsAdministrator();
            string appExe = ResolveAppExecutable(installDir, productName);

            var context = new InstallContext
            {
                InstallDir = installDir,
                ProductName = productName,
                ProductVersion = GetInformationalVersion(),
                AppExePath = appExe,
                OfficialUninstallerPath = official,
                Footprint = footprint,
                IsPortable = isPortable,
                AllUsers = allUsers,
                IsElevated = elevated,
                RequiresElevation = allUsers && !elevated && !options.Elevated && !options.DryRun,
                ShortcutName = string.IsNullOrWhiteSpace(footprint.ShortcutName)
                    ? productName
                    : footprint.ShortcutName,
                MenuDirectory = footprint.MenuDirectory,
                UserProfileDir = options.ProfileDirOverride ??
                                 Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                AppDataDir = options.AppDataDirOverride ??
                             Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                LocalAppDataDir = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            };

            log.Write(
                "custom-uninstaller-context install-dir=" + context.InstallDir +
                " product=" + context.ProductName +
                " official=" + (context.OfficialUninstallerPath ?? "<missing>") +
                " install-keys=" + context.Footprint.InstallKeys.Count +
                " uninstall-keys=" + context.Footprint.UninstallKeys.Count +
                " all-users=" + context.AllUsers +
                " elevated=" + context.IsElevated +
                " portable=" + context.IsPortable);
            return context;
        }

        private static string ResolveInstallDir(CommandLineOptions options, string productName)
        {
            if (!string.IsNullOrWhiteSpace(options.InstallDirOverride))
            {
                return options.InstallDirOverride;
            }

            if (options.Updated)
            {
                string fromRegistry = RegistryCleanup.FindInstallDirByProduct(productName);
                if (!string.IsNullOrWhiteSpace(fromRegistry))
                {
                    return fromRegistry;
                }
            }

            string executable = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
            return Path.GetDirectoryName(executable);
        }

        private static string FindOfficialUninstaller(string installDir)
        {
            try
            {
                string[] candidates = Directory.GetFiles(installDir, "Uninstall*.exe", SearchOption.TopDirectoryOnly);
                string preferred = candidates.FirstOrDefault(
                    path => !string.Equals(
                        Path.GetFileName(path),
                        "ZCodeUninstall.exe",
                        StringComparison.OrdinalIgnoreCase));
                return preferred;
            }
            catch
            {
                return null;
            }
        }

        private static string ResolveAppExecutable(string installDir, string productName)
        {
            string expected = Path.Combine(installDir, productName + ".exe");
            if (File.Exists(expected))
            {
                return expected;
            }

            try
            {
                return Directory.GetFiles(installDir, "*.exe", SearchOption.TopDirectoryOnly)
                    .Where(path => !Path.GetFileName(path).StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase))
                    .Where(path => !Path.GetFileName(path).Equals("ZCodeUninstall.exe", StringComparison.OrdinalIgnoreCase))
                    .FirstOrDefault(path => Path.GetFileName(path).StartsWith("ZCode", StringComparison.OrdinalIgnoreCase));
            }
            catch
            {
                return expected;
            }
        }

        private static bool IsUnderProgramFiles(string installDir)
        {
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            return PathUtil.IsUnderDirectory(installDir, programFiles) ||
                   PathUtil.IsUnderDirectory(installDir, programFilesX86);
        }

        private static string GetInformationalVersion()
        {
            AssemblyInformationalVersionAttribute attribute = Assembly.GetExecutingAssembly()
                .GetCustomAttribute<AssemblyInformationalVersionAttribute>();
            return attribute == null ? string.Empty : attribute.InformationalVersion;
        }
    }
}
