using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.Win32;

namespace ZCode.Uninstaller
{
    internal static class FileCleanup
    {
        public static FileCleanupResult Run(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log,
            IProgress<string> progress)
        {
            var result = new FileCleanupResult();
            string installDir = context.InstallDir;
            string selfPath = Process.GetCurrentProcess().MainModule.FileName;
            bool selfInInstallDir = PathUtil.IsUnderDirectory(selfPath, installDir);
            // 不跟随 junction/reparse point，避免用户放在安装目录里的链接把删除带到外部目录。
            FileSystemSnapshot snapshot = FileSystemWalker.Collect(installDir, log);
            if (!snapshot.Complete)
            {
                result.FailedCount++;
                result.AccessDenied = true;
                result.Messages.Add("目录扫描不完整，可能存在被安全软件拒绝访问的子目录。");
            }

            if (!options.Force)
            {
                List<string> embedded = FindEmbeddedDataDirectories(snapshot);
                if (embedded.Count > 0)
                {
                    log.Write("cleanup-failed reason=embedded-data-present count=" + embedded.Count);
                    throw new EmbeddedDataException(
                        "安装目录内检测到 ZCode 数据目录。继续卸载会删除这些数据，请先备份/迁移。",
                        embedded);
                }
            }

            progress?.Report(Strings.DeletingFiles);
            if (options.DryRun)
            {
                log.Write("dry-run install-dir=" + installDir + " files=" + snapshot.Files.Count +
                          " official=" + (context.OfficialUninstallerPath ?? "<missing>"));
                foreach (string file in snapshot.Files.Take(20))
                {
                    log.Write("dry-run-file path=" + file);
                }

                result.DryRun = true;
                result.AppFilesRemoved = true;
                return result;
            }

            foreach (string file in snapshot.Files)
            {
                if (ShouldDeleteInFirstPass(file, context, selfPath, selfInInstallDir, log))
                {
                    DeleteOne(file, result, log);
                }
            }

            // 先删主程序：只有它成功删除后，才能删除官方 Uninstall*.exe；
            // 否则残留目录会让应用下次启动被误判为便携版。
            if (File.Exists(context.AppExePath))
            {
                if (!TryDeleteFile(context.AppExePath, log, out FileDeleteFailure appFailure))
                {
                    AddFailure(result, appFailure, log);
                    result.AppFilesRemoved = false;
                    log.Write("cleanup-failed reason=app-executable-not-removed path=" + context.AppExePath);
                    return result;
                }

                result.DeletedCount++;
            }

            result.AppFilesRemoved = true;

            if (!string.IsNullOrEmpty(context.OfficialUninstallerPath) &&
                File.Exists(context.OfficialUninstallerPath))
            {
                if (TryDeleteFile(context.OfficialUninstallerPath, log, out FileDeleteFailure officialFailure))
                {
                    result.DeletedCount++;
                }
                else
                {
                    AddFailure(result, officialFailure, log);
                }
            }

            DeleteEmptyDirectories(installDir, snapshot.Directories, selfInInstallDir, result, log);

            if (!options.NoSelfDelete)
            {
                if (selfInInstallDir)
                {
                    if (result.AccessDenied)
                    {
                        log.Write("self-cleanup-skipped reason=access-denied-security-software");
                    }
                    else
                    {
                        if (ScheduleRunOnceCleanup(context, installDir, log))
                        {
                            result.SelfCleanupScheduled = true;
                        }
                        else
                        {
                            result.FailedCount++;
                            log.Write("self-cleanup-failed reason=runonce-write-failed path=" + installDir);
                        }
                    }
                }
                else if (result.AccessDenied)
                {
                    log.Write("install-dir-cleanup-skipped reason=access-denied-security-software");
                }
                else
                {
                    TryDeleteInstallDirectory(installDir, context, result, log);
                }
            }
            else
            {
                log.Write("self-cleanup-skipped reason=test-flag");
            }

            return result;
        }

        public static bool TryDeleteDirectoryTree(string path, UninstallerLog log)
        {
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path))
            {
                return true;
            }

            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    Directory.Delete(path, true);
                    log.Write("directory-deleted path=" + path);
                    return true;
                }
                catch (Exception exception)
                {
                    int code = GetErrorCode(exception);
                    if (attempt == 3)
                    {
                        log.WriteFailure(path, Classify(exception), code, exception.Message);
                        return false;
                    }

                    Thread.Sleep(200);
                }
            }

            return false;
        }

        private static bool ShouldDeleteInFirstPass(
            string file,
            InstallContext context,
            string selfPath,
            bool selfInInstallDir,
            UninstallerLog log)
        {
            if (selfInInstallDir && PathUtil.SamePath(file, selfPath))
            {
                return false;
            }

            if (PathUtil.SamePath(file, context.AppExePath))
            {
                return false;
            }

            if (!string.IsNullOrEmpty(context.OfficialUninstallerPath) &&
                PathUtil.SamePath(file, context.OfficialUninstallerPath))
            {
                return false;
            }

            if (PathUtil.SamePath(file, log.LogPath))
            {
                return false;
            }

            return true;
        }

        private static void DeleteOne(string file, FileCleanupResult result, UninstallerLog log)
        {
            if (TryDeleteFile(file, log, out FileDeleteFailure failure))
            {
                result.DeletedCount++;
                return;
            }

            AddFailure(result, failure, log);
        }

        private static bool TryDeleteFile(
            string path,
            UninstallerLog log,
            out FileDeleteFailure failure)
        {
            failure = null;
            for (int attempt = 1; attempt <= 3; attempt++)
            {
                try
                {
                    File.SetAttributes(path, FileAttributes.Normal);
                    File.Delete(path);
                    return true;
                }
                catch (Exception exception)
                {
                    if (attempt == 3)
                    {
                        failure = new FileDeleteFailure
                        {
                            Path = path,
                            Reason = Classify(exception),
                            Code = GetErrorCode(exception),
                            Detail = exception.Message,
                        };
                        log.WriteFailure(failure.Path, failure.Reason, failure.Code, failure.Detail);
                        return false;
                    }

                    Thread.Sleep(200);
                }
            }

            return false;
        }

        private static void AddFailure(
            FileCleanupResult result,
            FileDeleteFailure failure,
            UninstallerLog log)
        {
            if (failure == null)
            {
                return;
            }

            result.FailedCount++;
            result.FailedPaths.Add(failure.Path);
            if (failure.Reason == "access-denied-security-software")
            {
                result.AccessDenied = true;
            }
            else if (failure.Reason == "file-in-use")
            {
                result.FileInUse = true;
            }

            result.Messages.Add(failure.Path + " (" + failure.Reason + ", code=" + failure.Code + ")");
            log.Write("cleanup-file-failed path=" + failure.Path + " reason=" + failure.Reason +
                      " code=" + failure.Code);
        }

        private static void DeleteEmptyDirectories(
            string installDir,
            List<string> directories,
            bool selfInInstallDir,
            FileCleanupResult result,
            UninstallerLog log)
        {
            foreach (string directory in directories.OrderByDescending(value => value.Length))
            {
                try
                {
                    Directory.Delete(directory, false);
                }
                catch (IOException)
                {
                    // 目录仍包含失败/保留文件，保留目录结构。
                }
                catch (UnauthorizedAccessException exception)
                {
                    result.FailedCount++;
                    result.AccessDenied = true;
                    log.WriteFailure(directory, "access-denied-security-software", 5, exception.Message);
                }
            }

            if (!selfInInstallDir)
            {
                try
                {
                    if (Directory.Exists(installDir) && !Directory.EnumerateFileSystemEntries(installDir).Any())
                    {
                        Directory.Delete(installDir, false);
                    }
                }
                catch (Exception exception)
                {
                    log.WriteFailure(installDir, Classify(exception), GetErrorCode(exception), exception.Message);
                }
            }
        }

        private static void TryDeleteInstallDirectory(
            string installDir,
            InstallContext context,
            FileCleanupResult result,
            UninstallerLog log)
        {
            try
            {
                if (Directory.Exists(installDir) && !Directory.EnumerateFileSystemEntries(installDir).Any())
                {
                    Directory.Delete(installDir, false);
                    log.Write("directory-deleted path=" + installDir);
                    return;
                }
            }
            catch (Exception exception)
            {
                string reason = Classify(exception);
                log.WriteFailure(installDir, reason, GetErrorCode(exception), exception.Message);
                if (reason == "access-denied-security-software")
                {
                    result.AccessDenied = true;
                    result.FailedCount++;
                    return;
                }
            }

            if (ScheduleRunOnceCleanup(context, installDir, log))
            {
                result.SelfCleanupScheduled = true;
            }
            else
            {
                result.FailedCount++;
                log.Write("self-cleanup-failed reason=runonce-write-failed path=" + installDir);
            }
        }

        private static bool ScheduleRunOnceCleanup(
            InstallContext context,
            string installDir,
            UninstallerLog log)
        {
            string command = Path.Combine(
                                  Environment.GetFolderPath(Environment.SpecialFolder.System),
                                  "cmd.exe") +
                              " /c rmdir /s /q \"" + installDir + "\"";
            string valueName = "ZCodeUninstallCleanup_" + StabilizeValueName(installDir);
            bool written = false;

            if (context.AllUsers && ElevationHelper.IsAdministrator())
            {
                written = TryWriteRunOnce(Registry.LocalMachine, valueName, command, log);
            }

            if (!written)
            {
                written = TryWriteRunOnce(Registry.CurrentUser, valueName, command, log);
            }

            if (written)
            {
                log.Write("self-cleanup-scheduled target=runonce path=" + installDir);
            }
            else
            {
                log.WriteFailure(installDir, "runonce-write-failed", 0, command);
            }

            return written;
        }

        private static string StabilizeValueName(string value)
        {
            // 同一台机器可能同时安装正式版和 Preview；RunOnce 值名必须按目录隔离，
            // 否则两者都待清理时后写入的会覆盖前一个。
            int hash = 17;
            string normalized = (value ?? string.Empty).ToLowerInvariant();
            foreach (char character in normalized)
            {
                hash = unchecked(hash * 31 + character);
            }

            return (hash & 0x7fffffff).ToString("x8");
        }

        private static bool TryWriteRunOnce(
            RegistryKey root,
            string valueName,
            string command,
            UninstallerLog log)
        {
            try
            {
                using (RegistryKey key = root.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\RunOnce"))
                {
                    if (key == null)
                    {
                        return false;
                    }

                    key.SetValue(valueName, command, RegistryValueKind.String);
                    return true;
                }
            }
            catch (Exception exception)
            {
                log.Write("runonce-write-failed root=" + root.Name + " message=" + exception.Message);
                return false;
            }
        }

        private static List<string> FindEmbeddedDataDirectories(FileSystemSnapshot snapshot)
        {
            return snapshot.Directories
                .Where(directory => string.Equals(
                    Path.GetFileName(directory),
                    ".zcode",
                    StringComparison.OrdinalIgnoreCase))
                .ToList();
        }

        private static string Classify(Exception exception)
        {
            int code = GetErrorCode(exception);
            if (exception is UnauthorizedAccessException || code == 5)
            {
                return "access-denied-security-software";
            }

            if (code == 32 || code == 33)
            {
                return "file-in-use";
            }

            return "io-error";
        }

        private static int GetErrorCode(Exception exception)
        {
            int code = exception.HResult & 0xFFFF;
            return code;
        }
    }
}
