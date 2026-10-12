import { describe, expect, it } from "vitest";
import { delimiter, dirname } from "node:path";

import { withPinnedNodePath } from "../../../scripts/mise-toolchain-env.mjs";

describe("mise toolchain child environment", () => {
  // 该用例断言 POSIX 风格的 PATH 键：win32 实现会把键规范化为 Path（见下一用例），
  // Windows 上 result.PATH 为 undefined。仅 macOS/Linux 执行。
  it.skipIf(process.platform === "win32")(
    "puts the launcher Node directory first without duplicating it",
    () => {
      const nodeDirectory = dirname(process.execPath);
      const originalPath = ["/opt/homebrew/bin", nodeDirectory, "/usr/bin", nodeDirectory].join(
        delimiter,
      );

      const result = withPinnedNodePath({ PATH: originalPath, KEEP_ME: "yes" }, process.execPath);

      expect(result.PATH?.split(delimiter)).toEqual([nodeDirectory, "/opt/homebrew/bin", "/usr/bin"]);
      expect(result.KEEP_ME).toBe("yes");
      expect(originalPath).toBe(
        ["/opt/homebrew/bin", nodeDirectory, "/usr/bin", nodeDirectory].join(delimiter),
      );
    },
  );

  // 官方 CI 未在 Linux 上跑过该套件：本用例模拟 Windows Path 变量（盘符含 `:`），
  // Linux 上 `result.Path` 为 undefined 直接失败。仅 Windows 执行。
  it.skipIf(process.platform !== "win32")(
    "preserves Windows Path casing so pnpm.cmd remains discoverable",
    () => {
      const nodeDirectory = dirname(process.execPath);
      const originalPath = ["C:/tools/pnpm", nodeDirectory, "C:/Windows/System32"].join(delimiter);

      const result = withPinnedNodePath({ Path: originalPath, KEEP_ME: "yes" }, process.execPath);

      // 修复原因：Windows 盘符包含 `:`，用 macOS/Linux 宿主分隔符拆分会先破坏模拟的 Windows 路径。
      expect(result.Path).toBe(
        [nodeDirectory, "C:/tools/pnpm", "C:/Windows/System32"].join(delimiter),
      );
      expect(result.PATH).toBeUndefined();
    },
  );
});
