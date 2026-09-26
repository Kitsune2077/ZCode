import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensurePortableHomeWritable,
  planEarlyDataBaseDir,
  portableAwareSettingsFile,
  resolvePortableAppHomeDir,
  type EarlyDataBaseDirPlanInput,
} from "../src/main/desktopPortableHome.js";

function planWith(overrides: Partial<EarlyDataBaseDirPlanInput> = {}) {
  return planEarlyDataBaseDir({
    env: {},
    homeDir: "C:\\Users\\tester",
    portableHomeDir: null,
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
  const result = resolvePortableAppHomeDir({
    platform: "win32",
    isPackaged: true,
    executablePath: "E:\\ZCodePortable\\ZCode.exe",
    listDirEntries: () => ["ZCode.exe", "resources", "electron.exe"],
  });
  assert.equal(result, "E:\\ZCodePortable");
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

    // 用一个普通文件充当父路径，mkdir 必然失败，模拟只读介质。
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
