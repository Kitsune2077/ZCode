/**
 * session-import 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sessionImportModule = {
  id: "session-import",
  requires: ["services", "session", "shared"],
  provides: ["session-import"],
  publicEntrypoints: [
    "contract.ts",
    "opencodeNativeSessionImportRepo.ts",
    "opencodeNativeSessionImportService.ts",
    "../dsh-native/dshNativeSessionImportRepo.ts",
    "../dsh-native/dshNativeSessionImportService.ts",
  ],
} as const;
