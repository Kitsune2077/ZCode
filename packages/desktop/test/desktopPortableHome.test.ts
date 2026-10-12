import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// 官方 v3.15.1 已把单测迁移到 vitest：root vitest 会收集所有 *.test.ts，
// node:test 风格的文件因为没有 vitest 套件而整体报 No test suite found。
import { test } from "vitest";
import {
  ensurePortableHomeWritable,
  planEarlyDataBaseDir,
  portableAwareSettingsFile,
  resolvePortableAppHomeDir,
  resolvePortableDataDir,
  type EarlyDataBaseDirPlanInput,
} from "../src/main/desktopPortableHome.js";

function planWith(overrides: Partial<EarlyDataBaseDirPlanInput> = {}) {
  return planEarlyDataBaseDir({
    env: {},
    homeDir: "C:\\Users\\tester",
    portableHomeDir: null,
    portableDataDir: null,
    readConfiguredDataBaseDir: () => null,
    ...overrides,
  });
}

test("portable detection: nsis layout with an uninstaller is not portable", () => {
  const result = resolvePortableAppHomeDir({
    platform: "win32",
    isPackaged: true,
    executablePath: "C:\\Program Files\\ZCode\\ZCode.exe",
    listDirEntries: () => ["ZCode.exe", "resources", "Uninstall ZCode.exe"],
  });
  assert.equal(result, null);
});

test("portable detection: unpacked zip layout without an uninstaller resolves to the exe dir", () => {
  // win32 判定逻辑本身与宿主无关，但反斜杠假路径的 dirname 切分由 node:path 按
  // 宿主 OS 计算（posix 上会得到 "."）。按宿主语义推导期望值，保持「返回 exe 所在
  // 目录」的断言语义，测试得以在 Linux CI 上运行（官方 v3.15.1 起单测跑在 Linux）。
  const exePath = "E:\\ZCodePortable\\ZCode.exe";
  const result = resolvePortableAppHomeDir({
    platform: "win32",
    isPackaged: true,
    executablePath: exePath,
    listDirEntries: () => ["ZCode.exe", "resources", "electron.exe"],
  });
  assert.equal(result, dirname(exePath));
});

test("portable detection: dev runtime and non-windows platforms never match", () => {
  assert.equal(
    resolvePortableAppHomeDir({
      platform: "win32",
      isPackaged: false,
      executablePath: "E:\\ZCodePortable\\ZCode.exe",
      listDirEntries: () => [],
    }),
    null,
  );
  assert.equal(
    resolvePortableAppHomeDir({
      platform: "darwin",
      isPackaged: true,
      executablePath: "/Applications/ZCode.app/Contents/MacOS/ZCode",
      listDirEntries: () => [],
    }),
    null,
  );
});

test("portable detection: unreadable app dir falls back to non-portable", () => {
  const result = resolvePortableAppHomeDir({
    platform: "win32",
    isPackaged: true,
    executablePath: "E:\\ZCodePortable\\ZCode.exe",
    listDirEntries: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(result, null);
});

test("plan priority: explicit env overrides never activate the portable branch", () => {
  const dataEnv = planWith({
    env: { ZCODE_DATA_BASE_DIR: "D:\\MyData" },
    portableHomeDir: "E:\\ZCodePortable",
    readConfiguredDataBaseDir: () => "E:\\ZCodePortable",
  });
  assert.equal(dataEnv.dataBaseDir, null);
  assert.equal(dataEnv.propagateSettingsHomeEnv, false);
  assert.equal(dataEnv.settingsHome, "C:\\Users\\tester");

  const settingsHomeEnv = planWith({
    env: { ZCODE_DESKTOP_HOME_DIR: "C:\\e2e-home" },
    portableHomeDir: "E:\\ZCodePortable",
  });
  assert.equal(settingsHomeEnv.dataBaseDir, null);
  assert.equal(settingsHomeEnv.propagateSettingsHomeEnv, false);
  assert.equal(settingsHomeEnv.settingsHome, "C:\\e2e-home");
});

test("plan priority: configured dataBaseDir inside the portable setting.json wins over the exe dir", () => {
  const plan = planWith({
    portableHomeDir: "E:\\ZCodePortable",
    readConfiguredDataBaseDir: (settingsHome) => {
      assert.equal(settingsHome, "E:\\ZCodePortable");
      return "D:\\MyData";
    },
  });
  assert.equal(plan.settingsHome, "E:\\ZCodePortable");
  assert.equal(plan.dataBaseDir, "D:\\MyData");
  assert.equal(plan.propagateSettingsHomeEnv, true);
});

test("plan priority: portable without explicit config defaults the data dir to the exe dir", () => {
  const plan = planWith({ portableHomeDir: "E:\\ZCodePortable" });
  assert.equal(plan.settingsHome, "E:\\ZCodePortable");
  assert.equal(plan.dataBaseDir, "E:\\ZCodePortable");
  assert.equal(plan.propagateSettingsHomeEnv, true);
});

test("plan priority: a manually created data dir replaces the portable anchor", () => {
  // 场景 H：锚点整体切换，settings 读取位置与数据根默认都落到 data 目录。
  const readFrom: string[] = [];
  const plan = planWith({
    portableHomeDir: "E:\\ZCodePortable",
    portableDataDir: "E:\\ZCodePortable\\data",
    readConfiguredDataBaseDir: (settingsHome) => {
      readFrom.push(settingsHome);
      return null;
    },
  });
  assert.deepEqual(readFrom, ["E:\\ZCodePortable\\data"]);
  assert.equal(plan.settingsHome, "E:\\ZCodePortable\\data");
  assert.equal(plan.dataBaseDir, "E:\\ZCodePortable\\data");
  assert.equal(plan.propagateSettingsHomeEnv, true);
});

test("plan priority: explicit env still wins over the portable data dir", () => {
  // 场景 I：e2e/开发者显式隔离不被 data 目录约定覆盖。
  const plan = planWith({
    env: { ZCODE_DESKTOP_HOME_DIR: "C:\\e2e-home" },
    portableHomeDir: "E:\\ZCodePortable",
    portableDataDir: "E:\\ZCodePortable\\data",
  });
  assert.equal(plan.settingsHome, "C:\\e2e-home");
  assert.equal(plan.dataBaseDir, null);
  assert.equal(plan.propagateSettingsHomeEnv, false);
});

test("plan priority: dataBaseDir configured inside the data anchor wins over the data dir default", () => {
  // 场景 K：setting.json 改从 data 锚点读取，其中的显式 dataBaseDir 依旧生效。
  const readFrom: string[] = [];
  const plan = planWith({
    portableHomeDir: "E:\\ZCodePortable",
    portableDataDir: "E:\\ZCodePortable\\data",
    readConfiguredDataBaseDir: (settingsHome) => {
      readFrom.push(settingsHome);
      return "D:\\MyData";
    },
  });
  assert.deepEqual(readFrom, ["E:\\ZCodePortable\\data"]);
  assert.equal(plan.settingsHome, "E:\\ZCodePortable\\data");
  assert.equal(plan.dataBaseDir, "D:\\MyData");
  assert.equal(plan.propagateSettingsHomeEnv, true);
});

test("resolvePortableDataDir: only an existing directory under a portable home counts", () => {
  const exeDir = "E:\\ZCodePortable";
  // 非便携（null home）→ 约定不可用。
  assert.equal(resolvePortableDataDir(null, () => true), null);
  // 目录存在 → 返回约定路径。
  assert.equal(resolvePortableDataDir(exeDir, () => true), "E:\\ZCodePortable\\data");
  // 不存在 / 同名文件（directoryExists 为 false）→ 维持便携默认。
  assert.equal(resolvePortableDataDir(exeDir, () => false), null);
});

test("resolvePortableDataDir: detects a real data directory on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-portable-data-dir-"));
  try {
    // 未创建时为 null。
    assert.equal(resolvePortableDataDir(root), null);
    // 创建目录后命中约定。
    mkdirSync(join(root, "data"), { recursive: true });
    assert.equal(resolvePortableDataDir(root), join(root, "data"));
    // 同名文件不算目录（场景 J）。
    rmSync(join(root, "data"), { recursive: true });
    writeFileSync(join(root, "data"), "not a dir");
    assert.equal(resolvePortableDataDir(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan priority: installed builds keep the legacy home-anchored behavior", () => {
  const untouched = planWith({});
  assert.equal(untouched.settingsHome, "C:\\Users\\tester");
  assert.equal(untouched.dataBaseDir, null);
  assert.equal(untouched.propagateSettingsHomeEnv, false);

  const configured = planWith({
    readConfiguredDataBaseDir: (settingsHome) => {
      assert.equal(settingsHome, "C:\\Users\\tester");
      return "D:\\MyData";
    },
  });
  assert.equal(configured.dataBaseDir, "D:\\MyData");
  assert.equal(configured.propagateSettingsHomeEnv, false);
});

test("portableAwareSettingsFile nests under the settings home anchor", () => {
  assert.equal(
    portableAwareSettingsFile("E:\\ZCodePortable"),
    join("E:\\ZCodePortable", ".zcode", "v2", "setting.json"),
  );
});

test("ensurePortableHomeWritable accepts a writable dir and rejects a blocked path", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-portable-writable-"));
  try {
    assert.equal(ensurePortableHomeWritable(root), true);

    // 鐢ㄤ竴涓櫘閫氭枃浠跺厖褰撶埗璺緞锛宮kdir 蹇呯劧澶辫触锛屾ā鎷熷彧璇讳粙璐ㄣ€?
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a dir");
    assert.equal(ensurePortableHomeWritable(blocker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensurePortableHomeWritable works when .zcode already exists", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-portable-existing-"));
  try {
    mkdirSync(join(root, ".zcode"), { recursive: true });
    assert.equal(ensurePortableHomeWritable(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
