using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace ZCode.Uninstaller
{
    /// <summary>
    /// 与官方卸载器共用 %TEMP%\ZCode-uninstaller.log 的格式：
    /// 每条带 [pid=N]，阶段 marker 保持 ASCII，便于安装器/IT 检索。
    /// </summary>
    internal sealed class UninstallerLog
    {
        private readonly object gate = new object();
        private readonly bool explicitPath;
        private bool disabled;
        private string path;

        private UninstallerLog(string path, bool explicitPath)
        {
            this.path = path;
            this.explicitPath = explicitPath;
        }

        public string LogPath
        {
            get
            {
                lock (gate)
                {
                    return path;
                }
            }
        }

        public static UninstallerLog Create(CommandLineOptions options)
        {
            string requested = options == null ? null : options.LogPathOverride;
            bool explicitPath = !string.IsNullOrWhiteSpace(requested);
            string initial;
            if (explicitPath)
            {
                try
                {
                    initial = Path.GetFullPath(requested);
                }
                catch
                {
                    explicitPath = false;
                    initial = Path.Combine(Path.GetTempPath(), "ZCode-uninstaller.log");
                }
            }
            else
            {
                initial = Path.Combine(Path.GetTempPath(), "ZCode-uninstaller.log");
            }

            var log = new UninstallerLog(initial, explicitPath);
            log.Write("custom-uninstaller-process-started");
            return log;
        }

        public void Write(string message)
        {
            lock (gate)
            {
                if (disabled)
                {
                    return;
                }

                string line = "[pid=" + Process.GetCurrentProcess().Id + "] " + OneLine(message) +
                              Environment.NewLine;
                if (TryAppend(path, line))
                {
                    return;
                }

                if (!explicitPath)
                {
                    string fallback = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "ZCode",
                        "uninstaller.log");
                    if (TryAppend(fallback, line))
                    {
                        path = fallback;
                        return;
                    }
                }

                // 日志不可写不应改变清理结果；UI 会显示原始路径。
                disabled = true;
            }
        }

        public void WriteFailure(string pathValue, string reason, int code, string detail)
        {
            Write(
                "cleanup-failed path=" + (pathValue ?? string.Empty) +
                " reason=" + (reason ?? "unknown") +
                " code=" + code +
                (string.IsNullOrEmpty(detail) ? string.Empty : " detail=" + detail));
        }

        private static bool TryAppend(string target, string line)
        {
            try
            {
                string directory = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                File.AppendAllText(target, line, new UTF8Encoding(false));
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string OneLine(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            return value.Replace("\r", " ").Replace("\n", " ");
        }
    }
}
