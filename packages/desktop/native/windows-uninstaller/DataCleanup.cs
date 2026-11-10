using System;
using System.IO;

namespace ZCode.Uninstaller
{
    internal static class DataCleanup
    {
        public static bool Run(
            InstallContext context,
            CommandLineOptions options,
            UninstallerLog log)
        {
            if (!options.DeleteAppData && !options.DeleteUserData)
            {
                log.Write("data-cleanup-skipped reason=preserve-by-default");
                return true;
            }

            bool success = true;
            string appDataProduct = Path.Combine(context.AppDataDir, context.ProductName);
            if (options.DeleteAppData || options.DeleteUserData)
            {
                success &= DeleteDataDirectory(appDataProduct, context.ProductName, log);
            }

            if (options.DeleteUserData)
            {
                string userZcode = Path.Combine(context.UserProfileDir, ".zcode");
                success &= DeleteDataDirectory(userZcode, ".zcode", log);
            }

            return success;
        }

        private static bool DeleteDataDirectory(string path, string expectedLeaf, UninstallerLog log)
        {
            if (string.IsNullOrWhiteSpace(path) ||
                !string.Equals(Path.GetFileName(path), expectedLeaf, StringComparison.OrdinalIgnoreCase))
            {
                log.WriteFailure(path, "data-path-refused", 0, "unexpected data path");
                return false;
            }

            if (!Directory.Exists(path))
            {
                log.Write("data-cleanup-skipped path=" + path + " reason=missing");
                return true;
            }

            log.Write("data-cleanup-started path=" + path);
            bool deleted = FileCleanup.TryDeleteDirectoryTree(path, log);
            log.Write("data-cleanup-" + (deleted ? "completed" : "failed") + " path=" + path);
            return deleted;
        }
    }
}
