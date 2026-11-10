using System;
using System.IO;

namespace ZCode.Uninstaller
{
    internal static class PathUtil
    {
        public static bool IsUnderDirectory(string candidate, string directory)
        {
            if (string.IsNullOrWhiteSpace(candidate) || string.IsNullOrWhiteSpace(directory))
            {
                return false;
            }

            string fullCandidate;
            string fullDirectory;
            try
            {
                fullCandidate = Normalize(candidate);
                fullDirectory = Normalize(directory);
            }
            catch
            {
                return false;
            }

            if (string.Equals(fullCandidate, fullDirectory, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            return fullCandidate.StartsWith(fullDirectory + "\\", StringComparison.OrdinalIgnoreCase);
        }

        public static bool SamePath(string left, string right)
        {
            if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right))
            {
                return false;
            }

            try
            {
                return string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        public static string Normalize(string value)
        {
            string full = Path.GetFullPath(value.Trim());
            if (full.Length > 3)
            {
                full = full.TrimEnd('\\', '/');
            }

            return full;
        }

        /// <summary>
        /// 从 UninstallString/command/Icon 值中提取 exe 路径。
        /// 支持带引号、带参数和 Icon 的 ",0" 后缀。
        /// </summary>
        public static string ExtractExecutablePath(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            string text = value.Trim();
            string candidate;
            if (text[0] == '"')
            {
                int closing = text.IndexOf('"', 1);
                candidate = closing > 1 ? text.Substring(1, closing - 1) : text.Trim('"');
            }
            else
            {
                // Icon/旧注册表值可能不带引号且路径含空格；优先截到 .exe。
                int exeIndex = text.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                if (exeIndex > 0)
                {
                    candidate = text.Substring(0, exeIndex + 4);
                }
                else
                {
                    int space = text.IndexOf(' ');
                    candidate = space > 0 ? text.Substring(0, space) : text;
                }
            }

            candidate = candidate.Trim();
            int comma = candidate.LastIndexOf(',');
            if (comma > 0)
            {
                string suffix = candidate.Substring(comma + 1);
                bool numeric = suffix.Length > 0;
                foreach (char character in suffix)
                {
                    if (!char.IsDigit(character))
                    {
                        numeric = false;
                        break;
                    }
                }

                if (numeric)
                {
                    candidate = candidate.Substring(0, comma);
                }
            }

            return candidate.Length == 0 ? null : candidate;
        }

        public static string QuoteArgument(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return "\"\"";
            }

            if (value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
            {
                return value;
            }

            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
