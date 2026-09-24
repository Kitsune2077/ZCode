# 随包内置的运行时工具（runtime tools）

## 背景

插件 `lark-cli`（飞书 CLI）的 `skills/setup` 第一步是 `command -v lark-cli`，缺失时才引导
`npm install -g @larksuite/cli`。这条路径要求用户机器上先有 Node.js/npm。

而上游 `@larksuite/cli` 的 npm 包只是转发壳（`scripts/run.js` → `bin/lark-cli[.exe]`），
真正实现由 GitHub Release 以**原生单文件**分发（`lark-cli.exe`，约 47 MB，MIT）。
把这份原生二进制随包内置后，`command -v lark-cli` 直接命中内置副本，`setup` 自动跳过 npm 安装，
用户**无需预装 Node.js**。

## 机制（谁负责什么）

| 环节 | 所有者 | 说明 |
| --- | --- | --- |
| 取得二进制 | `scripts/prepare-bundled-lark-cli.mjs`（`prepare:lark-cli`） | 解析 npm latest → 取该版本 npm 包内 `checksums.txt` → 下载并校验 → 落到 `packages/desktop/bundled-tools/<platform-key>/lark-cli/lark-cli[.exe]` |
| 打进安装包 | `packages/desktop/electron-builder.config.js` extraResources | `bundled-tools/<key>/lark-cli` → `resources/tools/lark-cli` |
| 运行时解析 | `packages/services/src/runtime-tools/runtimeToolResolver.ts` | 通用解析器：先看 `env[binaryEnvVar]`，再按 `resources/tools/<dir>/<entry>` 查找；命中后写入环境变量并把目录**追加进 PATH** |
| 工具注册 | `packages/shared/src/runtime-tool-runtime.ts` | `RuntimeToolId` 新增 `"lark-cli"`；`binaryEnvVar: "ZCODE_LARK_CLI_BINARY"`（与 desktop 既有注入同名） |
| 注入 Agent 环境 | `packages/services/src/runtime-tools/runtimeCommandEnv.ts` | `buildRuntimeToolEnvPatch(["bfs","lark-cli","ripgrep","ugrep"], …)` |
| 桌面侧预解析 | `packages/desktop/src/main/desktopRuntimeEnv.ts` | 早已按同一环境变量注入 bundled 路径（`:393`），本次只是补上消费方 |

```
构建期: prepare:lark-cli ──▶ bundled-tools/<key>/lark-cli/{lark-cli[.exe], LICENSE, lark-cli-bundle.json}
                                    │ electron-builder extraResources
                                    ▼
运行期: resources/tools/lark-cli/ ──▶ runtimeToolResolver ──▶ ZCODE_LARK_CLI_BINARY
                                                          └─▶ PATH 追加该目录
                                                                    ▼
                                              插件 skills/setup: `command -v lark-cli` 命中 → 跳过 npm
```

## 供应链

- **版本跟随 npm latest**（`@larksuite/cli/latest`）。可用 `ZCODE_LARK_CLI_VERSION` 钉死某个版本。
- **摘要来自官方**：期望 sha256 读自该版本 npm 包内的 `checksums.txt`（上游随包发布），
  与下载到的 release 归档逐字节比对，不一致即构建失败。校验和不自算——自算只能证明"下载完整"，
  不能证明"就是上游发布物"。
- 下载源：npmmirror binary 镜像优先（与上游 `install.js` 策略一致），GitHub Release 兜底。
- 记录：`bundled-tools/<key>/lark-cli/lark-cli-bundle.json` 保存 `version` / `archiveName` /
  `archiveSha256` / `binarySha256` / `sourceUrl`，供追溯与幂等判断。
- **许可**：MIT（Copyright (c) 2026 Lark Technologies Pte. Ltd.）。上游 `LICENSE` 随二进制复制到
  工具目录，因此安装包内 `resources/tools/lark-cli/LICENSE` 保留原始署名。
- 幂等：同版本且二进制摘要一致时跳过；摘要不符则重新准备（[repair]）。

## 开关

| 变量 | 作用 |
| --- | --- |
| `ZCODE_SKIP_LARK_CLI=1` | 跳过该步骤（离线构建）。`prepare-runtime-assets.mjs` 据此不排入该步骤；electron-builder 侧用存在性判断，缺资产时包内不带该工具，不让打包整体失败 |
| `ZCODE_LARK_CLI_VERSION=<x.y.z>` | 钉死版本，替代 latest |

## 不变量

- 只有 `prepare-bundled-lark-cli.mjs` 一处写入 `bundled-tools/*/lark-cli`。
- 进入安装包的二进制必须是**通过官方 checksums.txt 校验**的那一份；校验失败不允许继续。
- 内置工具的暴露方式沿用既有 runtime tool 机制（环境变量 + PATH 追加），不为 lark-cli 另开路径。
- 插件内容保持与官方 artifact 逐字节一致——本次不需要改插件，靠 PATH 命中即可。

## 验收场景

- A：`pnpm bundle:desktop -- --os win --arch x64` → 日志出现 `[prepare:agent-bundle]` 之外的
  `prepare:lark-cli` 计时，且 `bundled-tools/<key>/lark-cli/lark-cli.exe` 存在。
- B：安装后的应用目录存在 `resources/tools/lark-cli/lark-cli.exe` 与 `LICENSE`。
- C：Agent 环境里 `ZCODE_LARK_CLI_BINARY` 指向该文件，且 PATH 含其目录；
  在**未安装 Node.js** 的机器上 `lark-cli --version` 返回版本号。
- D：`ZCODE_SKIP_LARK_CLI=1` 打包 → 包内不含该工具，打包不失败，插件回落到 npm 引导路径。

## 已知缺口（未完成，需后续处理）

1. **第三方声明未生成**：`THIRD-PARTY-NOTICES.md` 由 `node scripts/licenses.mjs notices` 从
   `third-party/inventory.json` 生成，而该 inventory 目前只覆盖 npm 生产依赖图、仓库内复制的源码/
   素材与 native-search 工具，**不包含构建期下载的组件**。lark-cli 属于新类别，需要在生成器里
   增加一类才能进声明。当前替代措施是许可文本随二进制进包 + 构建元数据记录来源与摘要。
2. **其它发行面未包含**：`packages/zcode-server-cli/src/packaging/stage.ts` 的 CLI 发行包
   工具清单、`apps/zcode-cli/packages/cli/src/sea-runtime-tools.ts` 的 SEA 工具集都是显式列表，
   本次未加入 lark-cli（不影响桌面安装包，属独立发行面）。
3. **体积**：`lark-cli.exe` 未压缩约 47 MB，安装包从 142 MB 增至约 190 MB。
