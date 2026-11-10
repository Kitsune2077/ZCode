using System;
using System.Collections.Generic;
using System.IO;

namespace ZCode.Uninstaller
{
    internal sealed class UninstallBlockedException : Exception
    {
        public UninstallBlockedException(string message, IReadOnlyList<string> paths)
            : base(message)
        {
            Paths = paths ?? new string[0];
        }

        public IReadOnlyList<string> Paths { get; }
    }

    internal sealed class EmbeddedDataException : Exception
    {
        public EmbeddedDataException(string message, IReadOnlyList<string> paths)
            : base(message)
        {
            Paths = paths ?? new string[0];
        }

        public IReadOnlyList<string> Paths { get; }
    }

    internal sealed class UninstallResult
    {
        public int ExitCode { get; set; }
        public bool Success { get; set; }
        public bool RebootRequired { get; set; }
        public string Message { get; set; }
    }

    internal sealed class FileCleanupResult
    {
        public bool AppFilesRemoved { get; set; }
        public bool DryRun { get; set; }
        public bool SelfCleanupScheduled { get; set; }
        public bool AccessDenied { get; set; }
        public bool FileInUse { get; set; }
        public int DeletedCount { get; set; }
        public int FailedCount { get; set; }
        public List<string> FailedPaths { get; } = new List<string>();
        public List<string> Messages { get; } = new List<string>();
    }

    internal sealed class ShellCleanupResult
    {
        public bool Success { get; set; } = true;
        public int DeletedCount { get; set; }
        public int FailedCount { get; set; }
    }

    internal sealed class FileDeleteFailure
    {
        public string Path { get; set; }
        public string Reason { get; set; }
        public int Code { get; set; }
        public string Detail { get; set; }
    }
}
