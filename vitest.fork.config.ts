import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 本 fork 的单测入口（`pnpm test:unit`）。
 *
 * 上游 3.17 退役了 App 单测执行链：`vitest.config.ts` 只注册 engineering 项目与 CUA，
 * 根 package.json 删除了 test:unit。fork 自己维护的功能（NewAPI 接入、便携数据目录、
 * PowerShell 7、ZIP 技能导入、自定义更新源、外部会话导入）仍需要回归守卫，因此用一份
 * **独立配置**显式列出这些文件，不去改动上游的 vitest.config.ts。
 *
 * 新增 fork 测试时，把文件加进下方 include 即可（相对仓库根）。
 */
const forkTestFiles = [
  "packages/desktop/test/autoUpdaterReadyState.test.ts",
  "packages/desktop/test/browserDataManager.test.ts",
  "packages/desktop/test/desktopPortableHome.test.ts",
  "packages/desktop/test/releaseFeedUpdateProvider.test.ts",
  "packages/services/test/dshNativeImport.test.ts",
  "packages/services/test/newApiAccount.test.ts",
  "packages/services/test/newApiHttpError.test.ts",
  "packages/services/test/newApiModelFilter.test.ts",
  "packages/services/test/newApiModelSync.test.ts",
  "packages/services/test/newApiProvisioning.test.ts",
  "packages/services/test/newApiSession.test.ts",
  "packages/services/test/opencodeNativeImport.test.ts",
  "packages/services/test/providerModelFetch.test.ts",
  // TODO(fork): 上游 3.17 把技能同步重构为 data-sync 的 IDataSyncCategoryService，
  // 原 skillSyncService 的候选/导入/导出 API 与其断言全部失效；
  // 本 fork 的「本地 ZIP 导入」仍保留在 skillSyncService 上，但该测试需按新 API 重写后再启用。
  // "packages/services/test/skillSyncService.test.ts",
  "packages/services/test/skillZipArchive.test.ts",
  "packages/services/test/skillsService.test.ts",
  "packages/services/test/systemService.test.ts",
  "packages/services/test/zcodeNativeImport.test.ts",
  "packages/shared/test/appSettings.test.ts",
  "packages/ui/test/newApiAccountHook.test.ts",
  "packages/ui/test/newApiAccountRefresh.test.ts",
  "packages/ui/test/newApiConnection.test.ts",
  "packages/ui/test/newApiModelSyncToast.test.ts",
  "packages/ui/test/newApiTokenErrorFeedback.test.ts",
  "packages/ui/test/settingsDataBaseDirControl.test.ts",
  "packages/ui/test/settingsUsageTabFallback.test.ts",
  // TODO(fork): 上游 3.17 用 data-sync 入口替换了远端技能同步弹窗并移除了 @testing-library 依赖，
  // 这两个 UI 测试需要按新组件结构（useSettingsDataSyncEntry + dataSync.dialog）重写。
  // "packages/ui/test/skillZipImportDialog.test.ts",
  // "packages/ui/test/skillsSection.test.ts",
  "packages/ui/test/usageStatusBarModel.test.ts",
  "packages/ui/test/v4ComposerToolbarRecovery.test.ts",
];

export default defineConfig({
  // 与根配置一致：固定注入事件上报端点，便于在单测里验证遥测链路。
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；具体子路径必须排在包根别名前。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    name: "fork",
    include: forkTestFiles,
    setupFiles: ["./vitest.setup.ts"],
    // 与根配置相同的超时/并发取向：Windows 上临时目录清理会偶发 EPERM，低配机 spawn 也慢。
    hookTimeout: 30_000,
    testTimeout: 30_000,
    maxWorkers: 4,
  },
});
