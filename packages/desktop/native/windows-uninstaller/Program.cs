using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace ZCode.Uninstaller
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            CommandLineOptions options;
            try
            {
                options = CommandLineOptions.Parse(ApplyRawInstallDir(args));
            }
            catch (Exception exception)
            {
                MessageBox.Show(
                    Strings.UnexpectedError(exception.Message),
                    Strings.AppTitle,
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }

            UninstallerLog log = UninstallerLog.Create(options);
            try
            {
                if (options.ShowVersion)
                {
                    log.Write("version " + BuildInfo.VersionLine);
                    return 0;
                }

                InstallContext context = InstallContext.Resolve(options, log);
                if (options.Updated)
                {
                    return UpdateDelegation.Run(context, options, log);
                }

                if (context.IsPortable && !options.Force)
                {
                    log.Write("custom-uninstaller-refused reason=portable");
                    if (!options.Silent)
                    {
                        MessageBox.Show(
                            Strings.PortableRefusal(context.ProductName),
                            Strings.AppTitle,
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                    }

                    return 1;
                }

                if (context.RequiresElevation)
                {
                    int elevationResult = ElevationHelper.RelaunchElevated(options, context, log);
                    if (elevationResult != 0 && !options.Silent)
                    {
                        MessageBox.Show(
                            Strings.ElevationRequired,
                            Strings.AppTitle,
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                    }

                    return elevationResult;
                }

                if (options.DryRun)
                {
                    UninstallResult dryRun = UninstallRunner.Run(context, options, log, null, true);
                    if (!options.Silent)
                    {
                        MessageBox.Show(
                            dryRun.Message,
                            Strings.DryRunTitle,
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                    }

                    return dryRun.ExitCode;
                }

                if (options.Silent)
                {
                    UninstallResult silent = UninstallRunner.Run(context, options, log, null, false);
                    return silent.ExitCode;
                }

                using (var form = new UninstallerForm(context, options, log))
                {
                    form.ShowDialog();
                    return form.ExitCode;
                }
            }
            catch (UninstallBlockedException exception)
            {
                log.Write("cleanup-failed reason=process-still-running count=" + exception.Paths.Count);
                if (!options.Silent)
                {
                    MessageBox.Show(
                        exception.Message + Environment.NewLine + Environment.NewLine +
                        string.Join(Environment.NewLine, exception.Paths) +
                        Environment.NewLine + Environment.NewLine + Strings.LogPathLabel + log.LogPath,
                        Strings.AppTitle,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                }

                return 2;
            }
            catch (EmbeddedDataException exception)
            {
                log.Write("cleanup-failed reason=embedded-data-present count=" + exception.Paths.Count);
                if (!options.Silent)
                {
                    MessageBox.Show(
                        exception.Message + Environment.NewLine + Environment.NewLine +
                        string.Join(Environment.NewLine, exception.Paths) +
                        Environment.NewLine + Environment.NewLine + Strings.LogPathLabel + log.LogPath,
                        Strings.AppTitle,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                }

                return 2;
            }
            catch (Exception exception)
            {
                log.Write("custom-uninstaller-failed reason=unexpected-error message=" + exception.Message);
                if (!options.Silent)
                {
                    MessageBox.Show(
                        Strings.UnexpectedError(exception.Message) + Environment.NewLine +
                        Environment.NewLine + Strings.LogPathLabel + log.LogPath,
                        Strings.AppTitle,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                }

                return 2;
            }
        }

        /// <summary>
        /// NSIS 的 `_?=<installDir>` 是命令行最后一段且不加引号；路径含空格时
        /// argv 会在空格处截断。这里从原始命令行取整段，再作为显式覆盖参数追加，
        /// 由 CommandLineOptions 的最后一次赋值覆盖 argv 解析结果。
        /// </summary>
        private static string[] ApplyRawInstallDir(string[] args)
        {
            string commandLine = Environment.CommandLine ?? string.Empty;
            int index = commandLine.IndexOf("_?=", StringComparison.OrdinalIgnoreCase);
            if (index < 0)
            {
                return args;
            }

            string value = commandLine.Substring(index + 3).Trim();
            if (value.Length >= 2 && value[0] == '"' && value[value.Length - 1] == '"')
            {
                value = value.Substring(1, value.Length - 2);
            }

            if (value.Length == 0)
            {
                return args;
            }

            var forwarded = new List<string>(args ?? new string[0])
            {
                "--install-dir=" + value,
            };
            return forwarded.ToArray();
        }
    }
}
