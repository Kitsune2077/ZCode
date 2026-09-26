# Composer 用量状态栏（Usage Status Bar）

## 范围

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| A | 生成速率（最近完成请求）+ 当前轮次（五维明细/缓存命中/请求数/时长/TTFT）+ 工具调用（次数与错误、按工具分布） | 已实现 |
| A | 会话累计 + 今日累计 + 上下文占比（既有 ChatContextUsage 承担） | 已实现 |
| B1 | 子代理用量（按 `session.parent_id` 关联子会话聚合，与主会话合计分开统计；hover 给明细） | 已实现 |
| B2 | 设置面板（条目开关、上下文窗口手动覆盖） | 未实现 |
| C1 | 模型侧用量查询能力（MCP `token_usage(scope)` 的等价物） | 未实现 |
| C2 | `/usage` 聊天命令 | 未实现 |
| C3 | 独立 CLI 查询入口（`zusage` 等价物） | 未实现 |

> **C1 的实现路径已在本仓库探明，与原方案不同**：外挂工具通过外部 MCP server 暴露
> `token_usage(scope)`；本仓库已有原生 tool 基建（`list_models` 即是先例），因此 C1 应实现为
> **原生 tool**（`contracts` 声明 name/输入输出 schema + `core/src/tool/handlers` 实现 +
> `context` 端口提供查询能力 + bootstrap 装配），模型侧能力等价而无需外部 MCP 注册。
> C1/C2/C3 共用同一查询层（`queryTaskUsage` / `queryTaskUsageDetail` / `queryAppUsage`），
> scope（current/today/week/days:N/sessions:N/models:days/session:<id>/workspace:<dir>）在
> 查询层实现一次即可三处复用。

一期（批次 A）在**对话输入工具条**常驻以下紧凑指标：

| 指标 | 数据源 | 语义 |
| --- | --- | --- |
| 上下文 | 既有 `usage_update` 流（`usage.contextWindow`，ChatContextUsage 已渲染） | 本会话上下文窗口占用，不重复实现 |
| 速率 | `model_usage` 最近一条请求：`output_tokens ÷ (completed_at − first_token_at)` | 最近完成请求的生成速度（tokens/s），三档配色 ≥70 / ≥40 / <40 |
| 本轮 | `turn_usage` 最近一行（该表已聚合模型与工具维度） | 当前轮次 total tokens + 缓存命中率；hover 给输入/输出/缓存读/缓存写/思考、请求数、时长、首 token |
| 会话 | `model_usage` 聚合（`queryTaskUsage`，含压缩增量基线口径） | 当前会话累计 total tokens |
| 今日 | `model_usage` 按本地时区自然日聚合 | 今日全部会话累计 total tokens |
| 工具 | `tool_usage` 会话级聚合 | 工具调用次数与错误数（错误以红色 `!n` 提示）；hover 给按工具分布 |
| 子代理 | `session.parent_id` 关联子会话后按会话聚合 `model_usage` / `tool_usage` | 后台子代理累计 tokens 与子代理数；**与「会话」合计口径独立，UI 不得相加** |

二期（B/C）保留在下方"未决/后续"。

## 状态所有权

| 关注点 | 所有者 |
| --- | --- |
| 会话/今日聚合事实 | agent SQLite（`model_usage` 等），经 ZCode Protocol 读取，桌面与远控同源 |
| `today` range 定义 | `packages/shared/src/usage-stats.ts` `APP_USAGE_RANGES` |
| `today` 聚合窗口（本地午夜起） | CLI `getUsageStats`（server-operations） |
| 状态栏渲染与轮询 | `packages/ui/src/v4/composer/V4ComposerUsageStats.tsx`（纯派生逻辑在 `usageStatusBarModel.ts`） |
| 刷新节奏 | 组件内部：sessionId 变化即刷 + 10s 间隔轮询（`document.visibilityState === "visible"` 时） |

## 行为细则

- 无会话（草稿态）只显示「今日」；有会话显示「速率 + 本轮 + 会话 + 今日 + 工具」，任一项
  取不到即隐藏该项。
- 任一查询失败静默降级为隐藏对应指标（warn 日志），不阻塞输入区。
- 数字用 `Intl.NumberFormat` compact 计法（如 12.3k），tooltip 提供完整值/五维明细/请求数。
- 「今日」按设备本地时区的自然日计算（协议入参 `timeZone`，agent 侧对齐本地午夜）。
- 速率分母是「首 token → 完成」的生成时长，不是整请求时长（后者含排队与首 token 延迟，
  会系统性算低速度）；首 token 或完成时间缺失时整项隐藏，不用 0 冒充。
- 缓存命中率分母是 total input（`inputTokens`），不能再叠加 cache 字段——历史踩过这个坑，
  叠加会把命中率压低。
- 指标不可点击（批次 B 再做详情面板）；样式遵循 DESIGN.md 的弱化文本呈现，不与
  ChatContextUsage 抢焦点。

## 协议扩展

- `APP_USAGE_RANGES = ["all", "7d", "30d", "today"]`；zod schema 引用同一常量自动放宽。
- CLI `getUsageStats`：`today` 的 `since` = 本地时区当日午夜对应的 UTC 毫秒
  （dayIndex 语义与 heatmap 一致：`Math.floor((until + tzOffsetMs) / DAY) * DAY - tzOffsetMs`）。
- 设置页 App 用量的时间范围选择器同步出现「今日」选项。
- `v4/conversation/usageDetail`（新增只读 query）：入参 `sessionId`，返回
  `latestRequest`（含 `generationMs`）/`latestTurn`（turn_usage 聚合）/`toolSummary`
  （按工具名前 20 项）。速率由消费端派生，协议只传原始量，避免两处口径漂移。
- 查询落在 `queryTaskUsageDetail`（adapters usage 仓储），与 `queryTaskUsage` 共用事实源；
  无 usage store 时返回空明细而非抛错。

## 附带修复：便携版 usage 库路径

`getDefaultSessionDbPath()` 原来用裸 `homedir()`，无视 `ZCODE_DATA_BASE_DIR`——便携版下
其余数据随程序走，usage 库却仍写真实 home。修复：

- `apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts`：
  `getDefaultSessionDbPath` 以 `ZCODE_DATA_BASE_DIR`（设置时）为基目录；
- `apps/zcode-cli/packages/bootstrap/src/app/session-store.ts` `getSessionDbPath`：
  配置值为默认字面量 `~/.zcode/cli/db/db.sqlite` 时同样以该基目录解析（用户显式配置
  其它路径不受影响；SSH 远端 CLI 不继承该 env，行为不变）。

## 验收场景

- A：进行中的会话，工具条出现「速率 · 本轮 · 会话 · 今日 · 工具」，轮次结束后 10s 内更新；
- B：新任务草稿态只显示「今日」；
- C：切换会话后「本轮/会话/工具」切换为对应会话的值；
- D：设置 → 用量 → App 用量时间范围出现「今日」且与状态栏「今日」一致；
- E：便携版运行后 usage 库出现在 `<exe 目录>/.zcode/cli/db/db.sqlite`，安装版仍为 `~` 下；
- F：agent 不可用/查询失败时指标静默隐藏，输入区不受影响；
- G：最近请求仍在进行（无完成时间）→ 速率项隐藏；工具错误 > 0 → 工具项出现红色 `!n`。

## 未决/后续（批次 B2、C）

- **B2 设置面板**：条目开关（沿用 AppSettings 字段，含 `*MigrationInitialized` 迁移位）、
  上下文窗口手动覆盖（`usage_update.size` 的显示侧覆盖，不改 agent 事实）。
- **C1 原生用量工具**：`contracts` 声明 tool name + 输入/输出 schema，`core/src/tool/handlers`
  实现（参考 `list-models.ts`），查询能力经 `context` 端口注入，bootstrap 装配到 session store。
  scope 与 C2/C3 共用查询层。
- **C2 `/usage` 聊天命令**：命令目录由 `listProtocolSlashCommands` 构建；需确认命令执行是
  「注入 prompt」还是「本地结果渲染」，再决定落点。
- **C3 CLI 查询入口**：在 agent CLI 侧新增子命令，直接复用查询层输出文本/JSON。
- 上述全部不依赖 Python：外挂工具的 installer/CLI/MCP/SSH 泵在源码 fork 里分别对应
  "不需要注入"、agent 内直接查询、仓内原生 tool（比外部 MCP 更贴合）、远端 agent 天然在远端执行。
