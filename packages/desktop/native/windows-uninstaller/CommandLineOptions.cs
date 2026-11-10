using System;
using System.Collections.Generic;
using System.Linq;

namespace ZCode.Uninstaller
{
    /// <summary>
    /// 解析官方旧卸载器协议和本工具自己的测试/IT 参数。
    /// 未识别的参数保留在 OriginalArgs 中，供 --updated 委托时按白名单重建。
    /// </summary>
    internal sealed class CommandLineOptions
    {
        public bool Silent { get; private set; }
        public bool Updated { get; private set; }
        public bool AllUsers { get; private set; }
        public bool CurrentUser { get; private set; }
        public bool KeepShortcuts { get; private set; }
        public bool DeleteAppData { get; private set; }
        public bool DeleteUserData { get; set; }
        public bool DryRun { get; private set; }
        public bool Force { get; set; }
        public bool ShowVersion { get; private set; }
        public bool Elevated { get; private set; }
        public bool NoRegistry { get; private set; }
        public bool NoShortcuts { get; private set; }
        public bool NoProcessKill { get; private set; }
        public bool NoSelfDelete { get; private set; }
        public string InstallDirOverride { get; private set; }
        public string LogPathOverride { get; private set; }
        public string ProfileDirOverride { get; private set; }
        public string AppDataDirOverride { get; private set; }
        public string[] OriginalArgs { get; private set; }

        public static CommandLineOptions Parse(string[] args)
        {
            var options = new CommandLineOptions
            {
                OriginalArgs = args == null ? new string[0] : args.ToArray(),
            };

            for (int i = 0; i < options.OriginalArgs.Length; i++)
            {
                string arg = options.OriginalArgs[i] ?? string.Empty;
                if (arg.Length == 0)
                {
                    continue;
                }

                if (Is(arg, "/S") || Is(arg, "--silent") || Is(arg, "-s"))
                {
                    options.Silent = true;
                }
                else if (Is(arg, "/allusers") || Is(arg, "--allusers"))
                {
                    options.AllUsers = true;
                }
                else if (Is(arg, "/currentuser") || Is(arg, "--currentuser"))
                {
                    options.CurrentUser = true;
                }
                else if (Is(arg, "--updated"))
                {
                    options.Updated = true;
                }
                else if (Is(arg, "--keep-shortcuts"))
                {
                    options.KeepShortcuts = true;
                }
                else if (Is(arg, "--delete-app-data"))
                {
                    options.DeleteAppData = true;
                }
                else if (Is(arg, "--delete-user-data"))
                {
                    options.DeleteUserData = true;
                }
                else if (Is(arg, "--dry-run"))
                {
                    options.DryRun = true;
                }
                else if (Is(arg, "--force"))
                {
                    options.Force = true;
                }
                else if (Is(arg, "--version"))
                {
                    options.ShowVersion = true;
                }
                else if (Is(arg, "--elevated"))
                {
                    options.Elevated = true;
                }
                else if (Is(arg, "--no-registry"))
                {
                    options.NoRegistry = true;
                }
                else if (Is(arg, "--no-shortcuts"))
                {
                    options.NoShortcuts = true;
                }
                else if (Is(arg, "--no-process-kill"))
                {
                    options.NoProcessKill = true;
                }
                else if (Is(arg, "--no-self-delete"))
                {
                    options.NoSelfDelete = true;
                }
                else if (TryReadValue(arg, i, options.OriginalArgs, "--install-dir", out string installDir, out int installDirIndex))
                {
                    options.InstallDirOverride = installDir;
                    i = installDirIndex;
                }
                else if (TryReadValue(arg, i, options.OriginalArgs, "--log", out string logPath, out int logPathIndex))
                {
                    options.LogPathOverride = logPath;
                    i = logPathIndex;
                }
                else if (TryReadValue(arg, i, options.OriginalArgs, "--profile-dir", out string profileDir, out int profileDirIndex))
                {
                    options.ProfileDirOverride = profileDir;
                    i = profileDirIndex;
                }
                else if (TryReadValue(arg, i, options.OriginalArgs, "--appdata-dir", out string appDataDir, out int appDataDirIndex))
                {
                    options.AppDataDirOverride = appDataDir;
                    i = appDataDirIndex;
                }
                else if (arg.StartsWith("_?=", StringComparison.OrdinalIgnoreCase))
                {
                    // electron-builder 用 `_?=<installDir>` 把安装目录传给旧卸载器；
                    // 目录可能包含空格，因此这里按剩余整段解析，不再按空白拆分。
                    options.InstallDirOverride = TrimQuotes(arg.Substring(3));
                }
            }

            if (options.Updated)
            {
                // 更新委托必须完全无 UI；即使调用方漏传 /S，也不能阻塞新安装器。
                options.Silent = true;
            }

            return options;
        }

        private static bool TryReadValue(
            string arg,
            int index,
            string[] args,
            string name,
            out string value,
            out int consumedIndex)
        {
            value = null;
            consumedIndex = index;
            if (arg.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase))
            {
                value = TrimQuotes(arg.Substring(name.Length + 1));
                return value.Length > 0;
            }

            if (!Is(arg, name))
            {
                return false;
            }

            if (index + 1 >= args.Length)
            {
                return false;
            }

            value = TrimQuotes(args[index + 1]);
            consumedIndex = index + 1;
            return value.Length > 0;
        }

        private static bool Is(string value, string expected)
        {
            return string.Equals(value, expected, StringComparison.OrdinalIgnoreCase);
        }

        private static string TrimQuotes(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            string trimmed = value.Trim();
            if (trimmed.Length >= 2 && trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"')
            {
                return trimmed.Substring(1, trimmed.Length - 2);
            }

            return trimmed;
        }
    }
}
