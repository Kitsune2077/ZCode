using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;

namespace ZCode.Uninstaller
{
    internal static class ElevationHelper
    {
        public static bool IsAdministrator()
        {
            try
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                {
                    var principal = new WindowsPrincipal(identity);
                    return principal.IsInRole(WindowsBuiltInRole.Administrator);
                }
            }
            catch
            {
                return false;
            }
        }

        public static int RelaunchElevated(
            CommandLineOptions options,
            InstallContext context,
            UninstallerLog log)
        {
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            var forwarded = new List<string>(options.OriginalArgs ?? new string[0]);
            if (!Contains(forwarded, "--elevated"))
            {
                forwarded.Add("--elevated");
            }

            // 提权可能换成另一个管理员账户；显式带上原用户的 profile/appdata，
            // 确保 --delete-user-data 删除的是发起卸载的用户数据。
            if (!ContainsPrefix(forwarded, "--profile-dir") && !string.IsNullOrWhiteSpace(context.UserProfileDir))
            {
                forwarded.Add("--profile-dir=" + context.UserProfileDir);
            }

            if (!ContainsPrefix(forwarded, "--appdata-dir") && !string.IsNullOrWhiteSpace(context.AppDataDir))
            {
                forwarded.Add("--appdata-dir=" + context.AppDataDir);
            }

            var arguments = new List<string>();
            foreach (string argument in forwarded)
            {
                arguments.Add(PathUtil.QuoteArgument(argument));
            }

            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = string.Join(" ", arguments),
                    Verb = "runas",
                    UseShellExecute = true,
                    WorkingDirectory = context.InstallDir,
                };
                Process.Start(startInfo);
                log.Write("custom-uninstaller-elevation-started");
                return 0;
            }
            catch (Win32Exception exception)
            {
                int code = exception.NativeErrorCode;
                log.Write("custom-uninstaller-elevation-failed code=" + code + " message=" + exception.Message);
                return code == 1223 ? 1 : 2;
            }
            catch (Exception exception)
            {
                log.Write("custom-uninstaller-elevation-failed code=0 message=" + exception.Message);
                return 2;
            }
        }

        private static bool Contains(IEnumerable<string> values, string expected)
        {
            foreach (string value in values)
            {
                if (string.Equals(value, expected, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }

        private static bool ContainsPrefix(IEnumerable<string> values, string prefix)
        {
            foreach (string value in values)
            {
                if (value.StartsWith(prefix + "=", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }

            return false;
        }
    }
}
