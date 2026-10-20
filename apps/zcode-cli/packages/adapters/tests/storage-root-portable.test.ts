import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorageRootDir } from "../src/storage/session-store/paths.js";

/**
 * CLI 存储根（storage.dir，插件缓存/技能/MCP/执行产物的落点）的便携分支：
 * 配置为默认字面量 "~/.zcode" 且宿主下发 ZCODE_DATA_BASE_DIR（桌面便携态由 main
 * 下发）时随数据根走；显式配置与独立 CLI（无该 env）行为不变。回归背景：各调用点
 * 此前裸 resolvePath，便携版安装的插件落在安装版主目录 ~/.zcode，违反便携数据根隔离。
 */
describe("resolveStorageRootDir", () => {
  const PORTABLE_ROOT = "D:\\ZCodePortable";

  it("默认字面量 + 便携 env → 存储根随数据根走（{dataBaseDir}/.zcode）", () => {
    expect(resolveStorageRootDir("~/.zcode", { ZCODE_DATA_BASE_DIR: PORTABLE_ROOT })).toBe(
      join(PORTABLE_ROOT, ".zcode"),
    );
  });

  it("默认字面量 + 无 env（独立 CLI / 安装版）→ 按 homedir 展开，行为不变", () => {
    expect(resolveStorageRootDir("~/.zcode", {})).toBe(join(homedir(), ".zcode"));
  });

  it("用户显式配置的绝对路径不受便携 env 影响", () => {
    expect(resolveStorageRootDir("E:\\MyZCodeData", { ZCODE_DATA_BASE_DIR: PORTABLE_ROOT })).toBe(
      "E:\\MyZCodeData",
    );
  });

  it("用户显式配置的 ~/ 路径按 homedir 展开，不重定向", () => {
    expect(resolveStorageRootDir("~/custom-root", { ZCODE_DATA_BASE_DIR: PORTABLE_ROOT })).toBe(
      join(homedir(), "custom-root"),
    );
  });

  it("空 ZCODE_DATA_BASE_DIR 视为未下发", () => {
    expect(resolveStorageRootDir("~/.zcode", { ZCODE_DATA_BASE_DIR: "  " })).toBe(
      join(homedir(), ".zcode"),
    );
  });
});
