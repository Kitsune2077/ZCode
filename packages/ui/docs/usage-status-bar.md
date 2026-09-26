# Composer 用量状态栏（Usage Status Bar）

## 背景与产品规则

社区工具 zcode-token-usage-statusbar 通过 patch app.asar 注入悬浮状态栏展示实时 token
用量；本仓库是源码 fork，直接以原生 UI 实现同等价值，免注入、免 Python、主题与国际化统一。

一期范围（本文件）在**对话输入工具条**常驻三个紧凑指标：

| 指标 | 数据源 | 语义 |
| --- | --- | --- |
| 上下文 | 既有 `usage_update` 流（`usage.contextWindow`，ChatContextUsage 已渲染） | 本会话上下文窗口占用，不重复实现 |
| 会话 | `zcodeTaskService.getTaskTokenUsage`（agent SQLite `model_usage` 聚合，协议直达） | 当前会话累计 total tokens（input+output 口径） |
| 今日 | `usageStatsService.getAppUsageSnapshot({ range: "today" })`（同一数据库按本地时区聚合） | 今日全部会话累计 total tokens |

二期（未决/后续，不在本次范围）：生成速率、当前轮次明细、工具调用统计、子代理用量、
MCP `token_usage` 查询、`/usage` 命令。

## 状态所有权

| 关注点 | 所有者 |
| --- | --- |
| 会话/今日聚合事实 | agent SQLite（`model_usage` 等），经 ZCode Protocol 读取，桌面与远控同源 |
| `today` range 定义 | `packages/shared/src/usage-stats.ts` `APP_USAGE_RANGES` |
| `today` 聚合窗口（本地午夜起） | CLI `getUsageStats`（server-operations） |
| 状态栏渲染与轮询 | `packages/ui/src/v4/composer/V4ComposerUsageStats.tsx`（纯派生逻辑在 `usageStatusBarModel.ts`） |
| 刷新节奏 | 组件内部：sessionId 变化即刷 + 10s 间隔轮询（`document.visibilityState === "visible"` 时） |

## 行为细则

- 无会话（草稿态）只显示「今日」；有会话显示「会话 + 今日」。
- 任一查询失败静默降级为隐藏对应指标（warn 日志），不阻塞输入区。
- 数字用 `Intl.NumberFormat` compact 计法（如 12.3k），tooltip 提供完整值与请求数。
- 「今日」按设备本地时区的自然日计算（协议入参 `timeZone`，agent 侧对齐本地午夜）。
- 指标不可点击（一期不做详情面板）；样式遵循 DESIGN.md 的 ghost/text 弱化呈现，不与
  ChatContextUsage 抢焦点。

## `today` range 协议扩展

- `APP_USAGE_RANGES = ["all", "7d", "30d", "today"]`；zod schema 引用同一常量自动放宽。
- CLI `getUsageStats`：`today` 的 `since` = 本地时区当日午夜对应的 UTC 毫秒
  （dayIndex 语义与 heatmap 一致：`Math.floor((until + tzOffsetMs) / DAY) * DAY - tzOffsetMs`）。
- 设置页 App 用量的时间范围选择器同步出现「今日」选项。

## 附带修复：便携版 usage 库路径

`getDefaultSessionDbPath()` 原来用裸 `homedir()`，无视 `ZCODE_DATA_BASE_DIR`——便携版下
其余数据随程序走，usage 库却仍写真实 home。修复：

- `apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts`：
  `getDefaultSessionDbPath` 以 `ZCODE_DATA_BASE_DIR`（设置时）为基目录；
- `apps/zcode-cli/packages/bootstrap/src/app/session-store.ts` `getSessionDbPath`：
  配置值为默认字面量 `~/.zcode/cli/db/db.sqlite` 时同样以该基目录解析（用户显式配置
  其它路径不受影响；SSH 远端 CLI 不继承该 env，行为不变）。

## 验收场景

- A：进行中的会话，工具条出现「会话 N · 今日 M」，随轮次结束后 10s 内更新；
- B：新任务草稿态只显示「今日」；
- C：切换会话后「会话」指标切换为对应会话的累计值；
- D：设置 → 用量 → App 用量时间范围出现「今日」且与状态栏「今日」一致；
- E：便携版运行后 usage 库出现在 `<exe 目录>/.zcode/cli/db/db.sqlite`，安装版仍为 `~` 下；
- F：agent 不可用/查询失败时指标静默隐藏，输入区不受影响。
