using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;

namespace ZCode.Uninstaller
{
    internal static class UpdateDelegation
    {
        public static int Run(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log)
        {
            log.Write("custom-uninstaller-started mode=updated");
            log.Write("update-delegation-started install-dir=" + context.InstallDir);
            if (string.IsNullOrWhiteSpace(context.OfficialUninstallerPath) ||
                !System.IO.File.Exists(context.OfficialUninstallerPath))
            {
                log.Write("update-delegation-failed reason=official-uninstaller-missing");
                return 2;
            }

            var args = new List<string>
            {
                "/S",
                "/KEEP_APP_DATA",
                context.AllUsers ? "/allusers" : "/currentuser",
            };
            if (options.KeepShortcuts)
            {
                args.Add("--keep-shortcuts");
            }

            if (options.DeleteAppData)
            {
                args.Add("--delete-app-data");
            }
            else
            {
                args.Add("--updated");
            }

            string commandLine = string.Join(" ", args.Select(PathUtil.QuoteArgument));
            // electron-builder 通过 `_?=<installDir>` 让旧卸载器原地运行；
            // 该参数必须保持在最后，且目录可能包含空格，不能加引号。
            commandLine += " _?=" + context.InstallDir;

            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = context.OfficialUninstallerPath,
                    Arguments = commandLine,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = context.InstallDir,
                };
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null)
                    {
                        log.Write("update-delegation-failed reason=process-start-null");
                        return 2;
                    }

                    process.WaitForExit();
                    log.Write("update-delegation-completed exit-code=" + process.ExitCode);
                    return process.ExitCode;
                }
            }
            catch (Exception exception)
            {
                log.Write("update-delegation-failed reason=exception message=" + exception.Message);
                return 2;
            }
        }
    }
}
