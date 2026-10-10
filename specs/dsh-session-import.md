# Spec: DeepSeek Harness 原生会话导入（Phase 1：text-only）

状态：初版实现中（分支 `feat/opencode-session-import`，与 OpenCode 导入同批）。
关联：`specs/opencode-session-import.md`（同构先例与共享管线）；本 spec 只记录 DSH 特有的事实与差异。

## 1. 目标与非目标

目标：把本机 DeepSeek Harness（DSH）的历史会话扫描、预览、按需导入为真实、可续聊的 ZCode session（Phase 1 text-only，同 OpenCode 导入）。

非目标（Phase 1）：reasoning/tool-call 保真导入；反向导出；DSH 多版本会话文件（v3/v4）的合并——每会话只读最高版本文件；`import-*` 目录（dsh-chat-import 从其它 Agent 导入生成的会话）不特殊过滤，作为普通候选展示，由用户自行取舍（与 OpenCode 双向导入可能产生双份，已知行为）。

## 2. 来源事实（DSH 存储格式，本机实测取证）

- 会话文件：`~/.dsh/sessions/<workspace-slug>/<session-dir>/session.v{N}.jsonl.zstd`，
  `<session-dir>` 形如 `session-<uuid>` 或 `import-<外部id>`；同目录可能同时存在 v3/v4，
  **高版本文件是该版本的完整日志**（实测 v4 全量、v3 仅剩头部时只读 v4）。
- 文件体是**多个 zstd frame 拼接**的 JSONL 事件流（每段追加一个 frame，452 帧/707 条记录实测）。
  Node 单帧 API（`zlib.zstdDecompressSync`，Node ≥23.8，仓库锁定 24.14）不自动续帧，
  需按 zstd magic（`28 B5 2F FD`）切分逐帧解压；坏帧容错跳过（实测 0 失败；
  压缩数据内 magic 误报理论上可能，解压失败即跳过该帧）。
- 首条 `session` 记录：`{type:"session", version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset}`；
  `cwd` 即 workspace 归属（权威，不解析目录 slug）。
- 事件流按 `seq`/`time`（epoch ms）单调追加。Phase 1 消费的事件类型：
  - `user/message`：`data.content: [{type:"text", text}, ...]`（正文块）
  - `assistant/message`：`data.message.content` 块数组（`text`/`reasoning`/`tool-call`），Phase 1 只取 `text`；`data.usage` 含 token
  - `session/title`：`data.title`（LLM 生成标题，最新一条生效）
  - `model/selection`：`data.provider`/`data.model`（列表展示用）
  - 其余（`turn/*`、`step/*`、`tool/*`、`system/*`、`request/*`、`compaction/*`、
    `session-log-*`、`agent/inbox/*` 等）为噪音/元事件，白名单外一律跳过。

## 3. 状态所有者与事件顺序

完全复用 OpenCode 导入的管线（见 opencode spec 第 4 节）：opencode-native 换成 dsh-native，
RPC `session/create` 的 `importedHistory.source = "deepseekHarness"`，tasks-index
`migration_source = "deepseekHarness"`，taskId 前缀 `dsh-import-`。单一写者仍是 CLI agent 进程；
dsh-native 对 `~/.dsh` 只读。

```
[用户] 设置 → 迁移（provider=deepseekHarness）
  │ ① scan：枚举 ~/.dsh/sessions/*/*/session.v*.jsonl.zstd，
  │    每会话只解压头部若干帧（≤64 帧）拿 cwd/createdAt/标题预览；mtime 作 updatedAt
  ▼ ② import：全量逐帧解压 → 解析器（user/assistant text 块 + 轮次聚合）
  ▼ createSession({importedHistory:{source:"deepseekHarness"}}) → CLI 唯一写者落库
  ▼ legacy snapshot + tasks-index(migration_source) → 侧边栏 → 可续聊
```

## 4. 接口变更

- shared：`ZCodeTaskMigrationSource`/realtime zod/`ZCodeImportSessionSourceProvider`/`zcodeSessionImportHistorySchema` 增加 `deepseekHarness`。
- services：新模块 `packages/services/src/session/dsh-native/`（log 读取器、repo、parser、service、task file 构造）；
  `IZCodeTaskService` 增加 `scanImportableDshSessions`/`importDshSessions`。
- CLI：无改动（`persistImportedSessionHistory` 已按"消息型来源"泛化）。
- UI：provider 枚举/下拉/文案增加 deepseekHarness。

## 5. 不变量与失败语义

1. taskId 确定性：`dsh-import-{sha256("dsh:"+workspacePath+":"+sessionId)[:24]}`，重导幂等同 OpenCode。
2. 解析结果至少 1 条可见消息，否则该会话计入 `failed`。
3. 坏帧/坏行/白名单外事件：跳过并 warn，不中断整会话/整批。
4. `~/.dsh` 只读；会话文件正被 DSH 进程追加不影响只读解压（frame 边界自洽）。
5. 来源 cwd 目录不存在时 `workspace_path_missing` 跳过。

## 6. 验收场景

1. 扫描列出本机 DSH 会话（含标题预览/时间/workspace）；workspaceFilter 生效。
2. 导入后侧边栏出现任务（migration_source=deepseekHarness），打开可查看 user/assistant 文本轮次并可续聊。
3. 同会话重导不产生重复消息。
4. 纯工具会话（无 text 块）失败原因明确，不产生空会话。
5. v3/v4 并存目录只读 v4。
6. provider=claude/openCode 行为回归不变。

## 7. 已知边界与后续

- `node:zlib` zstd 在 Node 24 为实验性 API（只读 + 容错降级可控）。
- DSH 格式无稳定性承诺，v5 出现时需适配；解析器按类型白名单 + 容错跳过设计，向前兼容大部分变化。
- Phase 2 可选项：`import-*` 目录标注、compaction 事件映射、tool-call/reasoning 保真。
