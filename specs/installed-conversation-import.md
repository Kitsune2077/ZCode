# 便携版导入安装版对话记录（installed-conversation-import）

## 1. 背景与产品规则

Windows 便携版（zip 解包直跑）的数据根在 `<exe>/.zcode` 或 `<exe>/data/.zcode`（见
`packages/desktop/docs/portable-data-dir.md`），与安装版数据根（`~/.zcode`，或安装版
`~/.zcode/v2/setting.json` 里显式配置的 `dataBaseDir`）天然隔离，互不读取。便携用户从
安装版迁移过来时，需要把**对话记录**（真实 ZCode 会话 + 任务列表 + legacy 快照）带过来。

本功能在设置 → 迁移页新增第四个来源 provider `zcodeDesktop`（UI 标签"ZCode（本机安装版）"）：

- 扫描：只读打开安装版 CLI 会话库，列出可导入的根会话（标题/时间/workspace 预览）；
- 导入：按勾选把会话**原生合并**进当前（便携）数据根——taskId 保持不变、消息/分片/待办
  原样拷贝、可续聊；同时把任务索引行与 legacy 快照并入当前数据根；
- 仅当"当前数据根 ≠ 安装版数据根"时可用；安装版数据不存在时扫描返回空列表；
- 幂等：已存在的会话/任务行/快照按**目标状态优先**跳过，可重复执行。

不做的事（v1 边界）：

- 不迁移凭据、设置、技能、hooks、自动化（cron/闲时）与模型用量统计（避免用量面板重复计数）；
- 不迁移 workflow/dwf 运行记录、输入队列、会话目标等运行态数据；
- 不做整目录覆盖式迁移（`copyDataDirectory` 已覆盖"数据存储路径"切换场景）；
- 不校验 workspace 目录是否存在（读历史仍有意义），但源目录缺失时续聊无法进行属预期。

## 2. 源端解析

```
installedDataBaseDir = read({home}/.zcode/v2/setting.json).dataBaseDir ?? home
sourceDataRoot       = {installedDataBaseDir}/.zcode
sourceSessionDbPath  = {sourceDataRoot}/cli/db/db.sqlite
```

- `home` 取 `os.homedir()`（安装版 settings 锚点恒在真实 HOME，与便携锚点无关）；
- 与当前数据根（`getDataBaseDir()`）同根（win32 大小写/分隔符归一比较）→ 判为"非便携或
  同一安装"，provider 不可用（扫描返回空）；
- 全新便携数据根没有 CLI 会话库时，导入直接以源库副本为初始库，schema 版本差异由
  agent CLI 启动迁移收敛（运行期它本就要支持旧版本库）；
- 源端 schema 漂移通过**列交集**吸收：以两侧 `pragma table_info` 的交集列读写，
  源库缺少的新列取目标默认值，源库多出的列丢弃。

## 3. 状态所有者与写入边界

| 存储 | 路径 | 所有者 | 本功能的写法 |
| --- | --- | --- | --- |
| CLI 会话库 | `{dataRoot}/.zcode/cli/db/db.sqlite` | agent CLI（运行期唯一写者） | host 侧以短事务合并（`busy_timeout` 5s；BUSY 时该会话计入 `failed`，可重试）。源端先把 `db.sqlite`（连同 `-wal`/`-shm`）整文件拷贝到临时目录、打开副本合并，**永不写源**；副本打开时允许 WAL 恢复。安装版正在运行时副本理论上可能撕裂，失败按会话暴露、关闭安装版后重试 |
| 任务索引 | `{dataRoot}/.zcode/v2/tasks-index.sqlite` | host（TaskIndexRepo） | `applyCliFacts` 逐行并入（已存在行保留目标 pinned/archived/deleted 状态） |
| legacy 快照 | `{dataRoot}/.zcode/v2/sessions/{hash}/{taskId}.json` | host | 源快照存在且目标不存在时复制；hash 按目标侧约定（workspacePath，无 identity）重算 |

事件顺序（单会话）：

```
BEGIN IMMEDIATE(target cli db)
  → merge session 行（列交集，INSERT OR IGNORE，主键 id 不变）
  → merge message / part / session_entry / todo（WHERE session_id = ?，INSERT OR IGNORE）
COMMIT
→ copy legacy snapshot（可选）
→ taskIndexRepo.applyCliFacts({ meta })（合成自 session 行 + 目标侧约定）
→ onTaskImported(meta)（复用既有 task_meta_changed 广播，侧边栏出现任务）
```

续聊路径不变：taskId 即 CLI session id，`session/resume` 命中合并后的会话库。

## 4. 接口变更

- `packages/shared`：
  - `ZCodeTaskMigrationSource` / `zcodeTaskMigrationSourceSchema` / realtime 枚举 /
    `ZCodeImportSessionSourceProvider` 增加 `"zcodeDesktop"`；
  - 不改 `zcodeSessionImportHistorySchema`（本功能不走 `session/create` + importedHistory）。
- `packages/services`：
  - `IZCodeTaskService` 新增 `scanImportableZcodeDesktopSessions` / `importZcodeDesktopSessions`
    （参数与其它 provider 同形；import 不需要 `createImportedSession`——会话行原生拷贝，
    taskId 即源 session id）；
  - 新增 `packages/services/src/session/zcode-native/`：
    - `zcodeNativeConversationSource.ts`：源端解析（setting.json → data root）、只读扫描、
      `backup()` 拷贝打开；
    - `zcodeNativeConversationImportService.ts`：逐会话合并编排（会话库 + 快照 + 索引）。
- `packages/ui`：迁移页 provider 下拉与 hook 分发增加 `zcodeDesktop`；i18n（zh-CN/en-US）。
- 扫描过滤：`time_deleted IS NULL`、`parent_id IS NULL`、不出现在
  `session_task_link.child_session_id`（排除子代理会话）、可选 workspace/时间过滤。

## 5. 不变量

1. 源端只读：所有源访问经 read-only 连接或临时目录里的整文件副本（含 `-wal`/`-shm`），
   任何失败不影响安装版数据。
2. 目标状态优先：主键冲突（会话 id、消息 id、快照文件、索引行）一律跳过，不覆盖便携版
   已删除/已归档/已改标题的记录；重复导入收敛为"新增 0"。
3. 会话行与消息/分片在同一事务内落地；任一表失败回滚该会话并计入 `failed`，已成功的
   会话保留（部分进度语义）。
4. taskId/sessionId 永不改写（与外部格式导入不同，本功能不做 id 映射）。
5. 排除遥测/统计表（`model_usage`/`tool_usage`/`turn_usage`），避免用量面板重复计数。
6. 快照按目标侧 hash 约定落盘；identity 维度不参与（CLI 会话行无 identity 概念），
   已知限制：identity 化 workspace 的快照读取兜底可能落空，仅影响只读兜底不影响续聊。

## 6. 失败语义

- 源库不存在 / backup 失败 / 目标库 BUSY 超时：该会话计入 `failed`（reason 为错误信息），
  不中断整批；扫描期源库不可用返回空列表。
- 目标库 schema 缺表（异常旧版本）：该会话失败并报错，不静默。
- 索引合并失败：会话库已并入时仍算 `failed`（任务列表不可见即视为未完成），重跑幂等收敛。

## 7. 验收场景

1. 检测：便携数据根下 provider 可扫描；开发态（数据根 = HOME）下该 provider 扫描返回空。
2. 扫描：列出安装版根会话（标题/时间/directory），子代理与已删除会话不出现；workspace
   过滤与时间范围过滤生效。
3. 导入：勾选会话导入后，任务列表出现同名任务（taskId 与安装版一致），打开可查看完整
   消息/工具分片，resume 后可继续对话。
4. 幂等：再次导入同一批，结果为"新增 0、跳过 N"，目标侧对已导入任务做的归档/改题不被
   回滚。
5. 漂移：源库少一列（模拟旧版本）时导入仍成功，目标新列取默认值。
6. 隔离：导入前后安装版 `db.sqlite` 文件字节不变（源只读）。

## 8. 兼容性边界

- 安装版与便携版同时运行：扫描不受影响（只读 + backup）；导入以短事务竞争写入，
  BUSY 按会话失败，建议关闭安装版后重试（UI 失败提示带原因）。
- 版本跨度：列交集吸收加列漂移；破坏性 schema 变更（改名/拆表）超出本功能保障范围，
  按会话失败暴露。
- 协议无新增 RPC（复用既有 IZCodeTaskService 通道与共享类型），旧 CLI 不受影响。
