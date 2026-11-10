using System;
using System.Collections.Generic;
using Microsoft.Win32;

namespace ZCode.Uninstaller
{
    internal sealed class RegistryKeyRef
    {
        public RegistryHive Hive { get; set; }
        public RegistryView View { get; set; }
        public string SubKey { get; set; }
        public string DisplayName { get; set; }
        public string UninstallString { get; set; }
        public string InstallLocation { get; set; }
        public string ShortcutName { get; set; }
        public string MenuDirectory { get; set; }
    }

    internal sealed class RegistryFootprint
    {
        public List<RegistryKeyRef> InstallKeys { get; } = new List<RegistryKeyRef>();
        public List<RegistryKeyRef> UninstallKeys { get; } = new List<RegistryKeyRef>();
        public string ShortcutName { get; set; }
        public string MenuDirectory { get; set; }

        public bool HasAny
        {
            get { return InstallKeys.Count > 0 || UninstallKeys.Count > 0; }
        }

        public bool HasMachineKeys
        {
            get
            {
                foreach (RegistryKeyRef key in InstallKeys)
                {
                    if (key.Hive == RegistryHive.LocalMachine)
                    {
                        return true;
                    }
                }

                foreach (RegistryKeyRef key in UninstallKeys)
                {
                    if (key.Hive == RegistryHive.LocalMachine)
                    {
                        return true;
                    }
                }

                return false;
            }
        }
    }
}
