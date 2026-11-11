# Composer 用量状态条（Usage Status Bar）

## 范围

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| A | 输入框下方常驻状态条：速率（最近完成请求，`首 token → 完成` 口径）、输出 token、TTFT、生成时长 | 已实现 |
| A2 | 回复末尾统计行（仅最新轮，同源复用 `usageDetail`） | 已实现 |
| A' | 当前轮次/会话/今日/工具/子代理等累计用量 | 数据层已实现（协议 `v4/conversation/usageDetail`），**状态条不展示**（见下） |
| B1 | 子代理用量聚合（按 `session.parent_id` 关联子会话，与主会话合计分开统计） | 数据层已实现 |
| B2 | 设置面板（条目开关、上下文窗口手动覆盖） | 未实现 |
| C1 | 模型侧用量查询能力（MCP `token_usage(scope)` 的等价物） | 未实现 |
| C2 | `/usage` 聊天命令 | 未实现 |
| C3 | 独立 CLI 查询入口（`zusage` 等价物） | 未实现 |

> **展示口径决策**：状态条只承担"模型此刻多快 + 这次生成了多少"——速率、输出 token、
> TTFT、生成时长四项，均为左侧用量圆环与设置页没有的指标。会话/今日/项目等累计仍由
> 左侧圆环（ChatContextUsage）与设置 → 用量页承担，避免同一事实出现第二处展示；
> 用量数据层与协议完整保留，供 C1/C2/C3 等查询类入口复用。
>
> **与社区插件的关系**：对齐 `zcode-token-usage-statusbar` 的指标口径与药丸形态
> （输入框下方常驻、速率三档配色、悬停看明细），但不采用其 asar 补丁、DOM 注入与
> CDP 调试口方案——本仓库的展示全部走组件与既有服务协议。

> **C1 的实现路径已在本仓库探明，与原方案不同**：外挂工具通过外部 MCP server 暴露
> `token_usage(scope)`；本仓库已有原生 tool 基建（`list_models` 即是先例），因此 C1 应实现为
> **原生 tool**（`contracts` 声明 name/输入输出 schema + `core/src/tool/handlers` 实现 +
> `context` 端口提供查询能力 + bootstrap 装配），模型侧能力等价而无需外部 MCP 注册。
> C1/C2/C3 共用同一查询层（`queryTaskUsage` / `queryTaskUsageDetail` / `queryAppUsage`），
> scope（current/today/week/days:N/sessions:N/models:days/session:<id>/workspace:<dir>）在
> 查询层实现一次即可三处复用。

状态条在**输入框正下方**常驻，药丸形态（与会话输入卡同宽居中，宽度随内容收缩但受窄窗约束）：

| 指标 | 数据源 | 语义 |
| --- | --- | --- |
| 速率 | `model_usage` 最近一条**已完成**请求：`output_tokens ÷ (completed_at − first_token_at)` | 最近完成请求的生成速度（tok/s），三档配色 ≥70 / ≥40 / <40 |
| 输出 token | 同一条请求的 `output_tokens` | 本轮实际输出量（K/M 缩写，hover 显示精确值） |
| TTFT | 同一条请求的 `time_to_first_token_ms` | 首字延迟；缺失时显示 `--` |
| 时长 | 同一条请求的 `duration_ms` | 整请求耗时；hover 同时给生成耗时（`generationMs`）与模型名 |

指标顺序固定为 速率 → 输出 token → TTFT → 时长，段间用竖分隔线；窄屏按
时长 → token → TTFT 的顺序逐段收起（速率始终保留）。

回复末尾另有一行同源统计（仅**最新一轮**、终态渲染）：`速率 · 输出 token · TTFT · 时长`，
弱化文本，不带交互。历史轮不渲染，避免每轮一次 RPC。

刻意**不在**状态条展示（避免与既有 UI 冗余）：

| 数据 | 承担方 |
| --- | --- |
| 上下文窗口占用 | 左侧用量圆环（ChatContextUsage，`usage_update` 流） |
| 会话/今日/历史用量累计 | 设置 → 用量 → App 用量页（含「今日」range） |
| 轮次明细/工具分布/子代理 | 协议 `v4/conversation/usageDetail` 保留，预留给 C1/C2/C3 查询入口 |

## 状态所有权

| 关注点 | 所有者 |
| --- | --- |
| 会话/今日聚合事实 | agent SQLite（`model_usage` 等），经 ZCode Protocol 读取，桌面与远控同源 |
| `today` range 定义 | `packages/shared/src/usage-stats.ts` `APP_USAGE_RANGES` |
| `today` 聚合窗口（本地午夜起） | CLI `getUsageStats`（server-operations） |
| 状态条/回复尾行渲染与轮询 | `packages/ui/src/v4/composer/V4ComposerUsageStatusBar.tsx`（纯派生逻辑在 `usageStatusBarModel.ts`；回复尾行为 `AssistantReplyUsageLine`） |
| 刷新节奏 | 组件内部：sessionId 变化即刷 + 10s 间隔轮询（`document.visibilityState === "visible"` 时） |

## 行为细则

- 状态条常驻：无会话（草稿态）、无请求记录时显示 `--` 占位而不是隐藏；
  查询失败时保留上一次成功值并弱化，不阻塞输入区。
- 请求进行中（`generationMs` 为 null）时，状态条保留**上一轮已完成**的指标并加
  「生成中」提示；不显示 0 或实时字符估算——实时速率需要订阅 `model.request.metrics`，
  另行排期。
- 速率分母是「首 token → 完成」的生成时长，不是整请求时长（后者含排队与首 token 延迟，
  会系统性算低速度）；首 token 或完成时间缺失时该段显示 `--`。
- 指标不可点击；样式遵循 DESIGN.md 的弱化文本呈现（`text-ui-xs` + `tabular-nums` +
  `text-foreground-subtle`），与 ChatContextUsage 圆环分工而不抢焦点。

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

- A：进行中的会话完成一轮后，输入框下方状态条出现速率（tok/s，三档配色）、输出 token、
  TTFT、时长，10s 内更新；回复末尾同时出现一行同源统计；
- B：新任务草稿态 / 无请求记录 → 状态条显示 `--` 占位（常驻），回复尾行不渲染；
- C：请求进行中 → 状态条保留上一轮已完成指标并标注「生成中」，不闪退成 0/空；
- D：设置 → 用量 → App 用量时间范围出现「今日」（设置页职责，与状态条无耦合）；
- E：便携版运行后 usage 库出现在 `<exe 目录>/.zcode/cli/db/db.sqlite`，安装版仍为 `~` 下；
- F：agent 不可用/查询失败时保留上一轮值并弱化，输入区不受影响；
- G：手机 Web 窄视口下状态条仍位于输入框下方，依次收起时长/token/TTFT，速率保留。

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
