using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Threading;

namespace ZCode.Uninstaller
{
    internal static class ProcessCleanup
    {
        public static void StopInstalledProcesses(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log,
            IProgress<string> progress)
        {
            if (options.NoProcessKill)
            {
                log.Write("process-cleanup-skipped reason=test-flag");
                return;
            }

            string installDir = context.InstallDir;
            int currentPid = Process.GetCurrentProcess().Id;
            progress?.Report(Strings.StoppingProcesses);

            for (int attempt = 1; attempt <= 3; attempt++)
            {
                List<ProcessInfo> matches = FindProcesses(installDir, currentPid, log);
                log.Write("process-scan attempt=" + attempt + " matches=" + matches.Count);
                if (matches.Count == 0)
                {
                    log.Write("process-cleanup-completed attempt=" + attempt);
                    return;
                }

                foreach (ProcessInfo match in matches)
                {
                    log.Write("process-kill pid=" + match.ProcessId + " path=" + match.ExecutablePath);
                    TryKill(match.ProcessId, log);
                }

                Thread.Sleep(750);
            }

            List<ProcessInfo> remaining = FindProcesses(installDir, currentPid, log);
            if (remaining.Count == 0)
            {
                log.Write("process-cleanup-completed");
                return;
            }

            var paths = new List<string>();
            foreach (ProcessInfo process in remaining)
            {
                paths.Add(process.ExecutablePath + " (pid=" + process.ProcessId + ")");
            }

            log.Write("process-cleanup-failed remaining=" + paths.Count);
            throw new UninstallBlockedException(
                "ZCode 仍在运行，无法完成卸载。请手动退出 ZCode（包括托盘中的实例）后重试。",
                paths);
        }

        private static List<ProcessInfo> FindProcesses(string installDir, int currentPid, UninstallerLog log)
        {
            var results = new List<ProcessInfo>();
            try
            {
                using (var searcher = new ManagementObjectSearcher(
                           "SELECT ProcessId, ExecutablePath FROM Win32_Process"))
                {
                    searcher.Options.Timeout = TimeSpan.FromSeconds(5);
                    searcher.Options.ReturnImmediately = true;
                    using (ManagementObjectCollection collection = searcher.Get())
                    {
                        foreach (ManagementBaseObject item in collection)
                        {
                            using (item)
                            {
                                uint pidValue;
                                try
                                {
                                    pidValue = Convert.ToUInt32(item["ProcessId"]);
                                }
                                catch
                                {
                                    continue;
                                }

                                if (pidValue == currentPid)
                                {
                                    continue;
                                }

                                string path = null;
                                try
                                {
                                    path = item["ExecutablePath"] as string;
                                }
                                catch
                                {
                                    // 受保护/提权进程可能读不到路径；不能按镜像名兜底，避免误杀便携版。
                                }

                                if (PathUtil.IsUnderDirectory(path, installDir))
                                {
                                    results.Add(new ProcessInfo((int)pidValue, path));
                                }
                            }
                        }
                    }
                }

                return results;
            }
            catch (Exception exception)
            {
                log.Write("process-scan-fallback reason=wmi-failed message=" + exception.Message);
            }

            try
            {
                foreach (Process process in Process.GetProcesses())
                {
                    using (process)
                    {
                        if (process.Id == currentPid)
                        {
                            continue;
                        }

                        string path = null;
                        try
                        {
                            path = process.MainModule == null ? null : process.MainModule.FileName;
                        }
                        catch
                        {
                            continue;
                        }

                        if (PathUtil.IsUnderDirectory(path, installDir))
                        {
                            results.Add(new ProcessInfo(process.Id, path));
                        }
                    }
                }
            }
            catch (Exception exception)
            {
                log.Write("process-scan-failed reason=fallback-failed message=" + exception.Message);
            }

            return results;
        }

        private static void TryKill(int pid, UninstallerLog log)
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = "taskkill.exe",
                    Arguments = "/PID " + pid + " /T /F",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null)
                    {
                        log.Write("process-kill-failed pid=" + pid + " reason=start-failed");
                        return;
                    }

                    if (!process.WaitForExit(3000))
                    {
                        log.Write("process-kill-timeout pid=" + pid);
                    }
                    else if (process.ExitCode != 0)
                    {
                        log.Write("process-kill-failed pid=" + pid + " exit-code=" + process.ExitCode);
                    }
                }
            }
            catch (Exception exception)
            {
                log.Write("process-kill-failed pid=" + pid + " message=" + exception.Message);
            }
        }

        private sealed class ProcessInfo
        {
            public ProcessInfo(int processId, string executablePath)
            {
                ProcessId = processId;
                ExecutablePath = executablePath ?? string.Empty;
            }

            public int ProcessId { get; }
            public string ExecutablePath { get; }
        }
    }
}
