using System;
using System.Globalization;

namespace ZCode.Uninstaller
{
    internal static class Strings
    {
        private static bool Zh =>
            CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals("zh", StringComparison.OrdinalIgnoreCase);

        public static string AppTitle => Zh ? "卸载 ZCode" : "Uninstall ZCode";
        public static string UninstallButton => Zh ? "卸载" : "Uninstall";
        public static string CancelButton => Zh ? "取消" : "Cancel";
        public static string CloseButton => Zh ? "关闭" : "Close";
        public static string StoppingProcesses => Zh ? "正在关闭 ZCode 进程…" : "Closing ZCode processes…";
        public static string DeletingFiles => Zh ? "正在删除程序文件…" : "Removing program files…";
        public static string CleaningShortcuts => Zh ? "正在清理快捷方式…" : "Cleaning shortcuts…";
        public static string CleaningRegistry => Zh ? "正在清理注册表…" : "Cleaning registry entries…";
        public static string DeletingData => Zh ? "正在删除本地数据…" : "Removing local data…";
        public static string Finishing => Zh ? "正在完成…" : "Finishing…";
        public static string Done => Zh ? "卸载完成。" : "Uninstall completed.";
        public static string DoneWithErrors => Zh ? "卸载未完全完成，请查看日志。" : "Uninstall is incomplete; see the log.";
        public static string LogPathLabel => Zh ? "日志：" : "Log: ";
        public static string RebootNote => Zh
            ? "部分卸载器文件将在下次登录/重启时清理。"
            : "Remaining uninstaller files will be removed on the next sign-in or reboot.";
        public static string DeleteDataLabel => Zh
            ? "同时删除本地会话、凭据、插件和缓存（不可恢复）"
            : "Also delete local sessions, credentials, plugins, and caches (cannot be undone)";
        public static string DeleteDataWarning => Zh
            ? "会删除 %USERPROFILE%\\.zcode 和 %APPDATA%\\ZCode；正式版和 Preview 共享 .zcode。"
            : "This removes %USERPROFILE%\\.zcode and %APPDATA%\\ZCode; production and Preview share .zcode.";
        public static string AccessDeniedHint => Zh
            ? "如果日志包含 access-denied-security-software，请联系 IT 将 ZCodeUninstall.exe 和 ZCode.exe（签名：北京智谱华章）加入白名单。"
            : "If the log contains access-denied-security-software, ask IT to allow ZCodeUninstall.exe and ZCode.exe (signer: Zhipu) in the endpoint policy.";
        public static string FormDescription(string product) => Zh
            ? "将删除 " + product + " 的程序文件和快捷方式。会话、凭据和设置默认保留。"
            : "Program files and shortcuts for " + product + " will be removed. Sessions, credentials, and settings are preserved by default.";
        public static string StatusReady => Zh ? "准备就绪。" : "Ready.";
        public static string StatusRunning => Zh ? "正在卸载，请勿关闭窗口…" : "Uninstalling; do not close this window…";
        public static string ElevationRequired => Zh
            ? "此安装需要管理员权限才能卸载。请在弹出的 UAC 提示中允许，或联系 IT。"
            : "Uninstalling this per-machine installation requires administrator rights. Approve the UAC prompt or contact IT.";
        public static string EmbeddedDataTitle => Zh ? "安装目录包含数据" : "Data inside the install directory";
        public static string DryRunTitle => Zh ? "卸载预演" : "Uninstall dry run";

        public static string ConfirmText(string product) => Zh
            ? "确定要卸载 " + product + " 吗？\n\n将删除程序文件和快捷方式；会话、凭据和设置默认保留。"
            : "Uninstall " + product + "?\n\nProgram files and shortcuts will be removed; sessions, credentials, and settings are preserved by default.";

        public static string PortableRefusal(string product) => Zh
            ? "这是 " + product + " 的便携版或未完成安装，不能用此卸载器清理。\n\n请直接删除程序目录；如需强制运行，请加 --force。"
            : "This looks like a portable " + product + " copy or an incomplete installation. This uninstaller will not remove it.\n\nDelete the program folder directly, or pass --force to override.";

        public static string EmbeddedDataPrompt(string paths) => Zh
            ? "安装目录内检测到 ZCode 数据目录：\n\n" + paths +
              "\n\n继续卸载会永久删除这些数据。是否继续？"
            : "ZCode data directories were found inside the install directory:\n\n" + paths +
              "\n\nContinuing will permanently delete this data. Continue?";

        public static string UnexpectedError(string message) => Zh
            ? "卸载器遇到错误：" + message
            : "The uninstaller failed: " + message;

        public static string UninstallSuccess(string product) => Zh
            ? product + " 已卸载。"
            : product + " has been uninstalled.";

        public static string UninstallPartial(string logPath, int failed) => Zh
            ? "卸载未完全完成（失败项：" + failed + "）。\n\n" + AccessDeniedHint + "\n\n日志：" + logPath
            : "Uninstall is incomplete (" + failed + " failure(s)).\n\n" + AccessDeniedHint + "\n\nLog: " + logPath;

        public static string ZhText(string zh, string en) => Zh ? zh : en;
    }
}
