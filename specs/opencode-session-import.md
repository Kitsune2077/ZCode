# Spec: OpenCode 原生会话导入（Phase 1：text-only）

状态：初版实现中（分支 `feat/opencode-session-import`）。
关联：Claude Code 原生导入（`packages/services/src/session/claude-native/`）为本方案的同构先例；
社区参考实现 [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)（DeepSeek Harness 插件）。

## 1. 目标与非目标

目标：
- 把本机 OpenCode CLI 的历史会话扫描、预览、按需导入为**真实、可续聊**的 ZCode session。
- Phase 1 保真度为 text-only：只导入用户可见的 user/assistant 文本轮次；reasoning、tool 调用、patch、附件等 part 不导入（显式跳过，不伪造）。

非目标（Phase 1 明确不做）：
- 工具调用 / reasoning / 文件附件保真导入（Phase 2，需先验证 transcript-hydration 对 `tool`/`reasoning` part 的约束）。
- 反向导出（ZCode → OpenCode）。
- 远程 / 手机 Web 场景导入（读取的是本机 `~/.local/share/opencode`，与 Claude 导入一致仅桌面端可用）。

## 2. 来源事实（OpenCode 存储格式）

取证依据：本机 Windows 实测 `~/.local/share/opencode/opencode.db`（OpenCode 全平台使用该路径，Windows 亦然）。

- 单一 SQLite 库，两代 schema 并存：
  - **V1**：`session`、`message`、`part` 三表；`message.data` / `part.data` 是 JSON blob。
  - **V2**（opencode 2.x 起）：`session_message` 表（`type` + `data` + `seq`）。实测当前版本该表只承载 `model-switched` / `agent-switched` 等事件；未来版本可能把对话消息写入此表。
- `session` 行关键字段：`id`（`ses_*`）、`directory`（workspace 路径）、`title`、`parent_id`（子代理会话，非空表示 sidechain）、`time_archived`、`time_created` / `time_updated`（epoch ms）。
- `message.data`：`role`（user/assistant）、`time.created`、assistant 侧 `parentID`/`modelID`/`providerID`/`tokens`/`finish`；user 侧 `summary` 只是预览字段，正文在 part 里。
- `part.data.type`：`text`（正文）、`reasoning`、`tool`、`step-start` / `step-finish`、`file`、`patch`、`snapshot`。
- **一轮用户输入对应多条 assistant step 消息**（step-start/reasoning/tool…/step-finish），assistant 正文是散布在其间的 `text` part；解析必须做轮次聚合。

## 3. 产品规则

1. 扫描仅读取：`readOnly: true` 打开 `opencode.db`，不写入、不复制、不移动来源数据。
2. 只导入主会话：`parent_id IS NOT NULL`（子代理）与 `time_archived IS NOT NULL`（已归档）的 session 跳过。
3. 候选列表按 `time_updated` 倒序；`workspacePath` 过滤按 `session.directory` 归一化比较（与 claude-native 相同的 win32 大小写折叠规则）；`modifiedSince` 按 `time_updated`。
4. workspace 归属：`session.directory` 即来源 workspace；不传 workspacePath 时按来源目录导入，`workspaceIdentity` 仅在“当前 workspace”过滤模式下传递（与 claude 导入同一语义）。
5. 来源 workspace 目录不存在时跳过（`workspace_path_missing`），不把会话挂到不存在的路径下。
6. 导入产物：
   - 真实 session（RPC `session/create` + `importedHistory.source = "openCode"`），可立即 resume 续聊；
   - legacy task snapshot（`~/.zcode/v2/sessions/{hash}/{taskId}.json`，text-only 迁移备份）；
   - tasks-index 行 `migration_source = "openCode"`（侧边栏识别迁移来源）。
7. Phase 1 降级透明：reasoning/tool/step/patch/file/snapshot part 一律跳过，不合成占位文本。

## 4. 状态所有者与事件顺序

单一写者不变量：**CLI agent 进程是 session store 的唯一写者**。opencode-native 模块与服务层只读来源库、只经 RPC 创建 session；任何路径都不直写 `~/.zcode/cli/db/db.sqlite`。

```
[用户] 设置 → 迁移（MigrationSection，provider=openCode）
  │ ① scan（零副作用，只读打开 opencode.db）
  ▼
IZCodeTaskService.scanImportableOpenCodeSessions()
   ← packages/services/src/session/opencode-native/（repo 查询 + 轻量标题预览）
  │ 用户勾选候选
  ▼ ② import
IZCodeTaskService.importOpenCodeSessions()
   → opencodeNativeSessionImportRepo.findImportableSession（重新校验目录与过滤）
   → opencodeNativeSessionImportParser（V1 优先；无 V1 消息时尝试 V2 带 role 的行）
   → zcodeAgentService.createSession({ importedHistory: { source: "openCode", messages } })
        → 协议 session/create → CLI persistImportedSessionHistory（唯一写者）
            ├─ session 行（title、workspace、时间戳）
            ├─ message + text part（确定性 id `{sessionId}_import_{n}`、时间戳单调收敛）
            └─ removePreviousImportedSessionHistory → 重导幂等
   → writeImportedLegacyTaskSnapshot + taskIndexRepo.syncTaskMeta(migration_source="openCode")
  ▼ ③ 广播
sessions-index → tasks-index → workspace_task_list_changed → 侧边栏出现 → session/resume 可续聊
```

## 5. 接口变更

- `packages/shared`：
  - `ZCodeTaskMigrationSource` 扩为 `"claudeCode" | "openCode"`；runtime zod enum 与 `zcodeTaskMigrationSourceSchema` 同步。
  - `ZCodeImportSessionSourceProvider` 扩为 `"claude" | "openCode"`。
  - `zcodeSessionImportHistorySchema` 新增 `openCode` 分支（与 claudeCode 同形：title/createdAt/updatedAt/messages）。
- `packages/services`：
  - `IZCodeTaskService` 新增 `scanImportableOpenCodeSessions` / `importOpenCodeSessions`（与 claude 版同参）。
  - 新增 `packages/services/src/session/opencode-native/`（types / repo / parser / service）。
- `apps/zcode-cli`：`persistImportedSessionHistory` 的 createdAt/updatedAt 判定从 `source === "claudeCode"` 泛化为“消息型来源（非 sharedContext）”。
- `packages/ui`：`useClaudeSessionMigration` 泛化 `provider` 参数（缺省 `claude`，向后兼容 Onboarding 用法）；`MigrationSection` 增加来源切换。

## 6. 不变量

1. 导入消息数组顺序即 transcript 顺序；`persistImportedSessionHistory` 写库前把时间戳收敛为单调递增（既有逻辑，openCode 复用）。
2. taskId 确定性：`opencode-import-{sha256("opencode:"+workspacePath+":"+sessionId)[:24]}`，同一 (workspace, sessionId) 重复导入落到同一 session id，靠 removePreviousImportedSessionHistory 幂等。
3. 解析结果至少含 1 条可见消息，否则抛错并计入 `failed`（与 claude-native 一致）。
4. 来源库只读；任何异常（库缺失、schema 不识别、JSON 损坏）降级为该 session 跳过/失败，不中断整批。

## 7. 失败语义

- 库文件不存在 / 无法打开：scan 返回空列表并记录 warn；import 单条返回 `session_not_found_or_workspace_mismatch`。
- 单 session 解析失败：计入 `failed`（reason 为错误信息），继续处理其余 session。
- V2 行 JSON 结构不符合预期：跳过该行（warn），不影响同 session 其他行。

## 8. 验收场景

1. 扫描：能列出本机 opencode.db 中未归档的主会话，含标题/时间/workspace；子代理与归档会话不出现。
2. 导入：选中会话导入后，侧边栏出现该任务（migration_source=openCode），打开可查看完整 user/assistant 文本轮次并能继续对话。
3. 幂等：同一 session 重复导入不产生重复消息（确定性 id + removePrevious 语义）。
4. 过滤：workspaceFilter=current 时只出现 directory 等于当前 workspace 的候选。
5. 降级：纯工具调用会话（无 text part 的 user 轮）导入失败原因明确（无可导入消息），不产生空会话。
6. 回归：provider=claude 的既有扫描/导入行为与文案不变。

## 9. 兼容性边界

- 协议 union 扩展对旧 CLI 是硬失败（importedHistory 不在兼容省略字段中，`buildSessionCreateParams` 有意为之）；要求桌面与 CLI 同版本发布（与 claudeCode 首发相同约束）。
- tasks-index `migration_source` 列为 TEXT，新枚举值无需迁移。
- 旧版 ZCode 读取 `"openCode"` 枚举时 zod 校验失败的位置仅在新导入链路，存量数据不受影响。

## 10. Phase 2 展望（不在本次实现）

- tool/reasoning part 保真：OpenCode `tool`（callID/state/output）与 ZCode `tool` part 语义接近，但需对齐 transcript-hydration 的 parentID 链与 completed state 约束。
- compaction 标记映射、增量追加（源增长且本地未续聊时只追加新轮次）、批量撤回（按 migration_source 删除）。
- 借鉴 dsh-chat-import 的 Interchange 中间格式，泛化 `importedHistory` 为通用外部 transcript。
