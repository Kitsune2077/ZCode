# 内置官方插件（随包 vendor）

## 背景

桌面包只带 `resources/glm/zcode.cjs` 时，app-server 的 `__dirname` 附近没有官方插件目录，
启动时 seed 找不到 source，用户拿不到内置插件。因此需要：

1. 插件**内容随包 vendor** 进仓库；
2. 由 `OFFICIAL_PLUGIN_DEFINITIONS` 声明（含版本、必带文件、候选目录）；
3. 打包时 stage 到 `glm/packages/*-plugin`；
4. 首启时 `seedBundledOfficialPlugins()` 按 `requiredSeedPaths` 校验后落到本地缓存。

官方市场里还有大量插件是**运行时按需下载**的；只有需要"默认装好、开箱可用"的才走这条 vendor 路径。

## 三处必须同步（新增插件时）

| 位置 | 职责 |
| --- | --- |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | 插件身份：`name`/`version`/`rootCandidates`/`requiredSeedPaths`/`defaultEnabled`/`listing` |
| `packages/shared/src/plugin-marketplaces.ts` → `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS` | Settings/services 侧消费的默认启用集合（由 `commandsService` / `skillsService` / `subagentsService` 使用） |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs` → `officialPluginPackages` | 打包时 stage 到 `glm/packages/*-plugin` 的白名单 |

`official-plugin-definitions.ts` 自己也会从 `defaultEnabled` 推导出同名集合（供 CLI 侧使用），
所以两处名单必须一致；上游注释提到有单测机械对照，但**当前检出里 apps/zcode-cli 下没有任何测试文件**，
这条对照目前只能靠人工保证。

## 已 vendor 的插件：`lark-cli`（飞书 CLI）

- **内容位置**：`apps/zcode-cli/packages/lark-cli-plugin/`
- **版本**：`0.1.2`
- **来源**：官方 artifact `https://cdn-zcode.z.ai/zcode/official-plugin/plugins/lark-cli/0.1.2/plugin.zip`
  - 市场清单声明的 `sha256 = b53747950cf99c93da69ef72e481bff0090ab6f132c96db393053fbc282fe487`，
    下载后实测一致，仓库内文件即为该 artifact 原样解包内容。
- **许可**：MIT（`plugin.json` 保留 `author: Z.ai`、`homepage/repository: https://github.com/larksuite/cli`）
- **形态**：纯内容型插件——只有 `skills/cli/SKILL.md` 与 `skills/setup/SKILL.md`，
  **无 MCP server、无系统依赖、无二进制**。CLI 本体由 `skills/setup` 引导用户经
  `npm install -g @larksuite/cli` 安装，授权走 `lark-cli auth login`。
- 因此 `defaultEnabled: true`：内容型插件默认启用符合本仓库既有约定
  （约定要防的是"首启即注入整套工具集并拉起 Helper"的重负载插件）。
- **不放置 `package.json`**：目录一旦有 manifest 就会成为 pnpm workspace 包，
  要求同步 lockfile，进而影响 `--frozen-lockfile` 安装（含 Docker 镜像构建）。
  非 workspace 目录同样能被 seed 与 stage 正常读取。

`README_CN.md` 与 `.claude-plugin/` 随 artifact 一并保留（保真与可审计），
但 seed/stage 的顶层白名单不含它们，实际不会写入运行时缓存——这是有意保持与白名单一致。

## 不变量

- 内置插件内容与官方 artifact **逐字节一致**；如需本地改动，必须在此文档登记差异与原因。
- 插件目录不因 vendor 而变成 workspace 包。
- `defaultEnabled: true` 只用于纯内容型插件。
- 三处同步表列出的位置必须同时更新，否则表现为"设置里默认开着但 CLI 找不到"或"应用里根本没有此插件"。

## 验收场景

- A：`pnpm bundle:desktop -- --os win --arch x64` → `prepare:agent-bundle` 输出
  `staged packages/lark-cli-plugin`，且 `requiredSeedPaths` 校验通过。
- B：安装后首启 → 用户目录插件缓存出现 `lark-cli/<version>/skills/{cli,setup}/SKILL.md`。
- C：设置页插件列表 / 市场条目显示「飞书 CLI」，默认已启用（无需手动开启）。
- D：Agent 侧可调用 `lark-cli` 技能（`skillsService` 能看到它，因为共享默认集合包含
  `lark-cli@zcode-plugins-official`）。
