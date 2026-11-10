using System;
using System.Collections.Generic;

namespace ZCode.Uninstaller
{
    internal static class UninstallRunner
    {
        public static UninstallResult Run(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log,
            IProgress<string> progress,
            bool dryRun)
        {
            string mode = dryRun ? "dry-run" : options.Silent ? "silent" : "interactive";
            log.Write("custom-uninstaller-started mode=" + mode);

            if (dryRun)
            {
                FileCleanupResult dryRunResult = FileCleanup.Run(context, options, log, progress);
                log.Write("dry-run registry-cleanup-skipped shortcuts-cleanup-skipped");
                int dryRunExit = dryRunResult.FailedCount == 0 ? 0 : 2;
                return new UninstallResult
                {
                    ExitCode = dryRunExit,
                    Success = dryRunExit == 0,
                    Message = dryRunExit == 0
                        ? Strings.ZhText(
                            "预演完成，未修改任何内容。日志：" + log.LogPath,
                            "Dry run completed; nothing was changed. Log: " + log.LogPath)
                        : Strings.UninstallPartial(log.LogPath, dryRunResult.FailedCount),
                };
            }

            try
            {
                ProcessCleanup.StopInstalledProcesses(context, options, log, progress);
            }
            catch (UninstallBlockedException exception)
            {
                log.Write("cleanup-failed reason=process-still-running count=" + exception.Paths.Count);
                return new UninstallResult
                {
                    ExitCode = 2,
                    Success = false,
                    Message = exception.Message + Environment.NewLine + Environment.NewLine +
                              Strings.LogPathLabel + log.LogPath,
                };
            }

            progress?.Report(Strings.DeletingFiles);
            FileCleanupResult fileResult = FileCleanup.Run(context, options, log, progress);
            if (!fileResult.AppFilesRemoved)
            {
                log.Write("cleanup-failed reason=app-files-remaining failed=" + fileResult.FailedCount);
                return new UninstallResult
                {
                    ExitCode = 2,
                    Success = false,
                    Message = Strings.UninstallPartial(log.LogPath, fileResult.FailedCount),
                };
            }

            progress?.Report(Strings.CleaningShortcuts);
            ShellCleanupResult shellResult = ShellCleanup.Delete(context, options, log);

            progress?.Report(Strings.CleaningRegistry);
            bool registrySuccess = RegistryCleanup.Delete(context, options, log);

            progress?.Report(
                options.DeleteUserData || options.DeleteAppData ? Strings.DeletingData : Strings.Finishing);
            bool dataSuccess = DataCleanup.Run(context, options, log);

            int failureCount = fileResult.FailedCount +
                               (shellResult.Success ? 0 : 1) +
                               (registrySuccess ? 0 : 1) +
                               (dataSuccess ? 0 : 1);
            int exitCode = failureCount == 0 ? 0 : 2;

            if (exitCode == 0)
            {
                log.Write("cleanup-completed files=" + fileResult.DeletedCount +
                          " failed=0 self-cleanup=" + fileResult.SelfCleanupScheduled);
            }
            else
            {
                log.Write("cleanup-failed reason=partial-cleanup failed=" + failureCount);
            }

            string message = exitCode == 0
                ? Strings.UninstallSuccess(context.ProductName) +
                  (fileResult.SelfCleanupScheduled ? Environment.NewLine + Strings.RebootNote : string.Empty) +
                  Environment.NewLine + Environment.NewLine + Strings.LogPathLabel + log.LogPath
                : Strings.UninstallPartial(log.LogPath, failureCount);

            return new UninstallResult
            {
                ExitCode = exitCode,
                Success = exitCode == 0,
                RebootRequired = fileResult.SelfCleanupScheduled,
                Message = message,
            };
        }
    }
}
