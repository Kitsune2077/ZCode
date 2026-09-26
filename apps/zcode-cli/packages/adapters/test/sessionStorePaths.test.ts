import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getDefaultSessionDbPath,
  resolveSessionDbBaseDir,
} from "../src/storage/session-store/paths.js";

test("resolveSessionDbBaseDir defaults to the user home without the env override", () => {
  assert.equal(resolveSessionDbBaseDir({}), homedir());
  assert.equal(resolveSessionDbBaseDir({ ZCODE_DATA_BASE_DIR: "   " }), homedir());
});

test("resolveSessionDbBaseDir honors ZCODE_DATA_BASE_DIR when set", () => {
  assert.equal(resolveSessionDbBaseDir({ ZCODE_DATA_BASE_DIR: "E:\\ZCodePortable" }), "E:\\ZCodePortable");
});

test("default session db path follows the data base dir (portable fix)", () => {
  // 便携态：usage 库随数据根走，迁移不丢用量历史。
  const saved = process.env.ZCODE_DATA_BASE_DIR;
  try {
    process.env.ZCODE_DATA_BASE_DIR = "E:\\ZCodePortable";
    assert.equal(
      getDefaultSessionDbPath(),
      join("E:\\ZCodePortable", ".zcode", "cli", "db", "db.sqlite"),
    );
  } finally {
    if (saved === undefined) {
      delete process.env.ZCODE_DATA_BASE_DIR;
    } else {
      process.env.ZCODE_DATA_BASE_DIR = saved;
    }
  }
  // 常规态（独立 CLI / 安装版桌面）：仍在用户主目录。
  assert.equal(
    getDefaultSessionDbPath(),
    join(homedir(), ".zcode", "cli", "db", "db.sqlite"),
  );
});
