using System;
using System.Collections.Generic;
using System.IO;

namespace ZCode.Uninstaller
{
    internal sealed class FileSystemSnapshot
    {
        public List<string> Files { get; } = new List<string>();
        public List<string> Directories { get; } = new List<string>();
        public bool Complete { get; set; } = true;
    }

    /// <summary>
    /// 卸载器专用遍历：不跟随 junction/reparse point，避免用户放在安装目录中的链接
    /// 把删除动作带到安装目录之外。扫描失败只标记 snapshot.Complete=false，由调用方
    /// 汇总成可见失败，而不是静默漏删。
    /// </summary>
    internal static class FileSystemWalker
    {
        public static FileSystemSnapshot Collect(string root, UninstallerLog log)
        {
            var snapshot = new FileSystemSnapshot();
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
            {
                return snapshot;
            }

            var pending = new Stack<string>();
            pending.Push(root);
            while (pending.Count > 0)
            {
                string directory = pending.Pop();
                try
                {
                    foreach (string file in Directory.EnumerateFiles(directory))
                    {
                        snapshot.Files.Add(file);
                    }

                    foreach (string child in Directory.EnumerateDirectories(directory))
                    {
                        FileAttributes attributes;
                        try
                        {
                            attributes = File.GetAttributes(child);
                        }
                        catch (Exception exception)
                        {
                            snapshot.Complete = false;
                            log.WriteFailure(child, "scan-failed", exception.HResult & 0xFFFF, exception.Message);
                            continue;
                        }

                        if ((attributes & FileAttributes.ReparsePoint) != 0)
                        {
                            log.Write("scan-skip-reparse-point path=" + child);
                            continue;
                        }

                        snapshot.Directories.Add(child);
                        pending.Push(child);
                    }
                }
                catch (Exception exception)
                {
                    snapshot.Complete = false;
                    log.WriteFailure(directory, "scan-failed", exception.HResult & 0xFFFF, exception.Message);
                }
            }

            return snapshot;
        }
    }
}
