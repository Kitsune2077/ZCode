# 本地 ZIP 技能包导入设计

## 背景

设置页 Skills 区当前有两类导入来源：

1. `SettingsSyncService` 的"从外部 Agent 导入"：扫描本机其他 Agent（Claude Code、Codex、OpenCode 等）的 skills 目录后复制。
2. `ISkillSyncService` 的远端同步：本机用户级 skills 打成 tar.gz 后经 RPC 导入远端 `~/.zcode/skills`。

两者都不能消费用户从外部获得的 `.zip` 技能包（例如社区分享、手动下载的 skill 压缩包）。本设计为设置页 Skills 区新增"从 ZIP 导入"入口，把用户提供的 ZIP 压缩包导入本机用户级技能目录。

## 目标

- 用户在设置页 Skills 区选择一个本地 `.zip` 文件后，其中每个包含 `SKILL.md` 的目录都会作为技能导入本机用户级 `~/.zcode/skills`。
- ZIP 内支持单技能目录（根目录即技能）、多技能平铺目录与分组嵌套目录，判定标准与既有候选扫描一致：目录内存在 `SKILL.md` 即视为技能。
- 同名技能（目录名相同，或 skill name 在 `.zcode/skills` / 兼容目录 `.agents/skills` 已存在）跳过，不覆盖，结果中标注 skipped。
- 导入完成后展示 synced / skipped / failed 明细，并刷新技能列表与 draft session 技能上下文。
- 复用远端同步的导入管线（临时目录解压 → `SKILL.md` 校验 → 判重 → 逐个复制），仅替换解压器为 ZIP。

## 非目标

- 首版不支持覆盖同名技能，与远端同步语义一致。
- 首版只写入本机用户级目录，不写 workspace 级 `.zcode/skills`，也不导入远端主机。
- 不支持加密 ZIP（encrypted entries 直接拒绝）。
- 不为 `IPlatformService.selectFile` 增加扩展名过滤参数；`.zip` 后缀由 UI 与服务双重校验。
- Web 端与手机远控不提供入口（`canSelectFilePath === false` 或 `userScopeAvailable === false` 时隐藏）。

## 服务边界

`ISkillSyncService` 新增方法（沿用既有 `skill-sync` RPC 通道，无需新通道）：

- `importSkillsZipArchive({ filePath })`
  - renderer 通过 `platform.selectFile()` 只能拿到本地路径且没有通用文件读取能力，因此由 host 侧读盘，避免把大文件塞进 RPC payload。
  - 服务端校验：`.zip` 后缀（大小写不敏感）、文件存在且为常规文件、文件大小 ≤ `maxArchiveBytes`（默认 20 MiB，超限抛结构化 size-limit 错误，`phase: "archive"`）。
  - 解压与导入复用 `importArchive` 的后置管线：先解到用户级技能根下 `.sync-tmp-<uuid>` 临时目录，`SKILL.md` 缺失的目录记 failed；目标目录已存在或同名 skill 已存在记 skipped；复制失败记 failed；结束后无论成败都删除临时目录。
  - ZIP 中没有任何技能目录时返回 `{ results: [] }`，由 UI 提示"未找到技能"。

ZIP 解压实现放在 `packages/services/src/skill-sync/skillZipArchive.ts`，依赖既有 `yauzl`：

- 路径安全：拒绝绝对路径、盘符、`..` 穿越与反斜杠路径（`normalizeSkillSyncRelativePath` + yauzl `strictFileNames`）；拒绝路径长度超过 240、空段、`.` 段、Windows 保留设备名（con/prn/aux/nul/com1-9/lpt1-9）以及尾随 `.` / 空格的段名。
- 只允许普通文件与目录条目：按 `externalFileAttributes` 高 16 位校验 unix 文件类型，符号链接与其他特殊类型直接拒绝；未携带类型位（部分 Windows 工具产出）的条目按文件名形态处理。
- 加密条目（general purpose bit 0）拒绝。
- 条目数上限（默认 512）；单条目与累计解压大小受 `maxExtractedBytes` 约束，超限抛结构化 size-limit 错误（`phase: "extracted-content"`），错误形状与 tar 归档一致，UI 复用既有 size-limit 文案逻辑。
- 写入使用排他 flag，避免归档内重复条目造成二次写入。

## UI 设计

- `SkillsSection` 头部新增"从 ZIP 导入"图标按钮（与远端同步按钮同一行，位于其左侧）；空技能态的操作区追加同款文字按钮。
- 入口仅在同时满足 `capability.userScopeAvailable`（桌面端用户级技能可用）与 `platform.canSelectFilePath !== false` 时展示；已连接远端同步目标的上下文中隐藏，避免"列表显示远端技能、导入却写本机"的目标歧义。
- 新增弹窗 `SkillZipImportDialog`：
  1. pick：展示说明（导入目标为本机 `~/.zcode/skills`，同名跳过）与"选择 ZIP 文件"按钮。
  2. importing：进行中提示，期间禁止关闭弹窗、禁止重复提交。
  3. complete：复用 `RemoteSkillSyncResultList` 展示逐项结果（完成与状态文案通过可选 props 换成导入语义）；`results` 为空时提示压缩包中没有技能目录。
  - 用户取消文件选择视为无操作；选择非 `.zip` 后缀时在弹窗内提示，不发起请求。
  - 失败回到 pick 步骤并展示错误；size-limit 错误复用 `formatRemoteSkillSyncError` 的结构化文案。
- 导入成功回调顺序：先 `invalidateDeferredDraftSessionForSkillChange`（reason `settings-skill-zip-import`），再刷新设置页技能列表与共享 skill store，最后展示结果。

## 状态与事件顺序

```text
renderer                                  local host SkillSyncService（唯一写入者）
  selectFile() → 本地路径
  .zip 后缀校验 ──RPC──▶ stat + 大小校验
                          解压到 ~/.zcode/skills/.sync-tmp-<uuid>
                          collectExtractedSkillDirectories → SKILL.md 校验
                          目录名/skill name 判重 → skipped
                          逐目录 cp → synced / failed
                          删除临时目录（finally，无论成败）
             ◀──results──
  invalidate draft session → 刷新列表 → 展示结果
```

- 导入状态 owner 是弹窗本地 state；`~/.zcode/skills` 内容的唯一写入者仍是 host 侧 SkillSyncService，UI 不做第二份事实。
- 幂等性：同一 ZIP 重复导入第二次全部 skipped，不产生副作用。
- 失败边界：解压阶段失败时目标根不落任何内容；单技能 cp 失败只影响该项（failed），其余继续。

## 测试与验证

- 单元测试（`packages/services`）：
  - ZIP 解压：常规技能目录、无显式目录条目（仅 `dir/file` 路径）、拒绝 `..` 穿越、拒绝反斜杠路径、拒绝绝对路径、拒绝符号链接条目、拒绝加密条目、拒绝 Windows 保留名、条目数超限、累计解压大小超限（结构化错误）。
  - 服务导入：成功导入并二次导入全 skipped、非 `.zip` 后缀拒绝、文件不存在拒绝、文件超过 `maxArchiveBytes` 拒绝（`phase: "archive"`）、无技能目录返回空 results。
- UI 测试（`packages/ui`）：
  - `.zip` 后缀校验 helper；非 zip 文件提示且不调用服务；导入中禁止重复提交；结果列表复用与空归档提示；两语言文案齐全。
  - `SkillsSection`：本地上下文展示 ZIP 导入入口；远端同步上下文隐藏。
- 仓库必跑：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 与受影响单测。

## 风险

- 恶意 ZIP（路径穿越、炸弹、符号链接条目）由解压器的路径/类型/条目数/大小限制防护，与 `contentBundleCache` 的 ZIP 安全面一致。
- Windows 下技能目录里含保留名文件的合法 ZIP 会被拒绝导入，属于可接受的从严行为，错误信息直接指向具体路径。
