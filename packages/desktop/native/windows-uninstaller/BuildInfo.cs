using System;
using System.Reflection;

namespace ZCode.Uninstaller
{
    internal static class BuildInfo
    {
        public static string ProductName
        {
            get
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                AssemblyProductAttribute product =
                    assembly.GetCustomAttribute<AssemblyProductAttribute>();
                if (product != null && !string.IsNullOrWhiteSpace(product.Product))
                {
                    return product.Product.Trim();
                }

                return "ZCode";
            }
        }

        public static string VersionLine
        {
            get
            {
                Assembly assembly = Assembly.GetExecutingAssembly();
                AssemblyInformationalVersionAttribute informational =
                    assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>();
                string version = assembly.GetName().Version == null
                    ? "0.0.0.0"
                    : assembly.GetName().Version.ToString();
                string info = informational == null ? string.Empty : informational.InformationalVersion;
                return "ZCODE_UNINSTALLER\t1\t" + ProductName + "\t" + version + "\t" + info;
            }
        }
    }
}
