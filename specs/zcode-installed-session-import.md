# Spec: ZCode 安装版数据导入（面向 Windows 便携版实例，Phase 1：text-only）

状态：初版实现。
关联：OpenCode 原生导入（`specs/opencode-session-import.md`）与 DSH 导入（`specs/dsh-session-import.md`）为同构先例；
安装版数据位置依据 `packages/desktop/src/main/desktopPortableHome.ts`（便携版不改写 USERPROFILE/HOME，
因此便携实例内 `os.homedir()` 仍指向安装版真实主目录）与 CLI session store schema
（`apps/zcode-cli/packages/adapters/src/storage/session-store/schema.baseline.sql`）。

## 1. 目标与非目标

目标：
- 在 **Windows 便携版实例**中，把**安装版 ZCode**（NSIS 安装、数据在真实用户主目录 `~/.zcode`）的
  配置与对话记录导入当前实例：
  - 对话记录 → 真实、可续聊的 ZCode session；
  - 配置（provider 配置、登录凭据、CLI 用户配置）→ 只补缺失、不覆盖。
- Phase 1 保真度为 text-only：只导入 user/assistant 文本轮次；reasoning、tool、patch 等 part 显式跳过，不伪造。

非目标（明确不做）：
- 反向（便携版 → 安装版）或任意目录互导；安装版数据位置是确定性的（真实主目录），不提供目录选择。
- 工具调用 / reasoning / 附件保真导入（与其它来源一致留待 Phase 2）。
- 配置合并/冲突解决：目标侧已有同名配置文件时保持现状（skip），不做字段级合并。
- 运行态/缓存/日志（`.zcode/v2/cache`、`logs` 等）迁移。

## 2. 来源事实（安装版存储布局）

- 安装版数据根 = `{os.homedir()}/.zcode`（安装版不重定向数据目录；便携版的重定向只设置
  ZCODE 专属环境变量，不影响 `os.homedir()`）。
- 会话真身：`~/.zcode/cli/db/db.sqlite`（CLI session store，唯一写者是安装版自己的 CLI 进程）。
- 可迁移配置：`.zcode/v2/provider_config.json`（provider 配置）、`.zcode/v2/credentials.json`（凭据）、
  `.zcode/cli/config.json`（CLI 用户配置）。
- 表结构（与 OpenCode V1 同源）：`session` / `message` / `part`，`message.data`、`part.data` 为 JSON blob。
- `session` 行关键字段：`id`、`directory`（workspace 路径）、`title`、`parent_id`、`time_archived`、
  `time_deleted`（软删除）、`task_type`（`interactive` 为主会话）、`time_created` / `time_updated`（epoch ms）。
- `session_task_link.child_session_id` 命中的 session 是 workflow 子任务，不属于用户主列表。
- CLI 规范排序：message `order by sequence is null, sequence, time_created, rowid`；
  part `order by sequence is null, sequence, time_created, id`。

## 3. 产品规则

1. 入口只在 **Windows 桌面端**展示（设置 → 迁移 → 导入来源新增 "ZCode 安装版"）。
   渲染层无法可靠区分便携/安装实例，平台判定交给服务层：当前实例的数据根即用户主目录
   （安装版/默认形态）时，扫描与配置导入都直接报错拒绝。
2. 扫描仅读取：`readOnly: true` 打开安装版 `db.sqlite`，不写入、不复制、不移动；查询失败降级为空列表 + warn 日志。
3. 只导入主会话：`parent_id` 非空（fork/sidechain）、`time_archived` 非空、`time_deleted` 非空、
   `task_type != 'interactive'`、出现在 `session_task_link.child_session_id` 的 session 一律跳过。
4. 候选列表按 `time_updated` 倒序；`workspacePath` 过滤按 `session.directory` 归一化比较
   （win32 大小写折叠，与 claude/opencode-native 相同规则）；`modifiedSince` 按 `time_updated`。
5. workspace 归属：`session.directory` 即来源 workspace；不传 workspacePath 时按来源目录导入，
   `workspaceIdentity` 仅在“当前 workspace”过滤模式下传递（与其它来源同一语义）。
6. 来源 workspace 目录不存在时跳过（`workspace_path_missing`）。
7. **自我导入防护**：解析出的来源 `db.sqlite` 与当前运行实例自己的
   `{dataBaseDir}/.zcode/cli/db/db.sqlite` 同一路径时，扫描/导入/配置导入直接报错
   （当前实例就是安装版/默认形态，没有“另一份”数据可导入）。
8. 对话导入产物（与其它来源同构）：
   - 真实 session（`zcodeAgentService.createSession` + `importedHistory.source = "zcodeInstalled"`），可立即续聊；
   - legacy task snapshot（`~/.zcode/v2/sessions/{hash}/{taskId}.json`，text-only 迁移备份）；
   - task index：`createImportedSession` 建 CLI 事实行后补 `migrationSource = "zcodeInstalled"` presentation
     与 searchableText，并把 `archived` 显式复位为 false；快照写入不凭空建行。
9. 配置导入（独立一次性动作，不随会话勾选）：
   - 逐文件复制 `provider_config.json` / `credentials.json` / `cli/config.json`；
   - 来源不存在或目标已存在 → skip，绝不覆盖（便携版已有配置代表用户更新的选择）；
   - 复制后由各读取方在下一次读取或重启后生效，本功能不做热重载。
10. 重新导入同一来源 session 永远产生新 task（新 sessionTraceId），不覆盖已删除或已继续对话的记录。

## 4. 状态所有者与事件顺序

单一写者不变量：**安装版库的唯一写者是安装版自己的 CLI 进程**；本功能全程只读。
当前实例内的会话事实仍只有一条写入路径：`createImportedSession`（RPC `session/create`）。
配置文件的写者仍是对应读取方（credentialService / provider provisioning / CLI）；
配置导入只在目标文件缺失时执行一次性 `copyFile`，不与运行中写者竞争同一文件。

```text
[用户] 设置 → 迁移（provider=zcodeInstalled，仅 Windows 桌面展示）
  │ ① scan（零副作用；readOnly 打开 ~/.zcode/cli/db/db.sqlite）
  ▼
IZCodeTaskService.scanImportableZCodeInstalledSessions({ workspacePath?, modifiedSince?, limit? })
   → zcode-installed-native repo：os.homedir() 解析 → 自我导入防护 → session 过滤查询 → 候选
  │ 用户勾选候选
  ▼ ② import
IZCodeTaskService.importZCodeInstalledSessions({ workspacePath?, workspaceIdentity?, sessionIds })
   → repo.findImportableSession（重新校验过滤边界）
   → repo.readSessionTranscript（message/part 按 CLI 规范排序）
   → parser（轮次聚合：一轮 user + 聚合后的 assistant 文本）
   → zcodeAgentService.createSession({ importedHistory: { source: "zcodeInstalled", messages } })
        → 协议 session/create → CLI persistImportedSessionHistory（消息型导入通用分支，无需 CLI 改动）
   → buildImportedZCodeInstalledTaskFile → writeImportedLegacyTaskSnapshot（迁移备份）
   → taskIndexRepo.updateTaskPresentation({ migrationSource: "zcodeInstalled" }) + updateTaskState({ archived: false })
   → onTaskImported → emitWorkspaceTaskListChanged("task_meta_changed")

  │ ③ importConfigs（独立按钮，一次性）
  ▼
IZCodeTaskService.importZCodeInstalledConfigs()
   → zcodeInstalledConfigImport：自我导入防护 → 逐文件 缺失才复制 → { copied, skipped }
```

## 5. 接口与类型改动

- `ZCodeImportSessionSourceProvider` 增加 `"zcodeInstalled"`（`zcode-task-types.ts`）。
- `ZCodeTaskMigrationSource` / `zcodeTaskMigrationSourceSchema` / realtime 值表同步增加
  （task-types-core、validation、task-realtime-core）。
- `zcodeSessionImportHistorySchema` 增加 `source: "zcodeInstalled"` 变体
  （形状与 openCode 相同：title/createdAt/updatedAt/messages）。
- `IZCodeTaskService` 新增 `scanImportableZCodeInstalledSessions` / `importZCodeInstalledSessions`
  / `importZCodeInstalledConfigs`；来源位置由服务端确定性解析，不引入路径参数。
- UI：`SessionMigrationProvider` 增加 `"zcodeInstalled"`；`MigrationSection` 仅在 `isWindowsDesktop`
  时提供该选项，并渲染来源说明与“导入安装版配置”按钮。

## 6. 验收场景

1. Windows 桌面端（便携版实例）：迁移页出现 "ZCode 安装版" 来源；扫描出安装版主目录中的主会话候选
   （子代理、workflow 子任务、已归档、已软删除的 session 不出现）。
2. 选中候选导入：侧边栏出现 `migrationSource = "zcodeInstalled"` 的新任务，打开可看到 text-only 轮次并可继续对话。
3. 点击“导入安装版配置”：目标缺失的 `provider_config.json` / `credentials.json` / `cli/config.json`
   被复制；再次点击全部 skip；目标已存在自己的配置时不被覆盖。
4. 安装版实例自身（数据根即主目录）：扫描与配置导入均报错，不产生候选。
5. 本机没有安装版数据（`~/.zcode/cli/db/db.sqlite` 不存在）：扫描报错提示未找到安装版数据。
6. 非平台条件（macOS/Linux/Web）：该来源选项不出现，其余来源不受影响。
7. 来源 session 无可见文本（纯工具轮）：导入结果计入 skipped（`no_visible_messages`）。
8. 重复合选同一 session 再导入：生成新 task，旧 task 不被覆盖。
