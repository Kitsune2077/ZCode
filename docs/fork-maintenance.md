# Fork 维护手册（上游同步与本地定制）

本文档面向维护本 fork 的人（含 AI agent）：说明上游 ZCode 的更新如何合入、本地定制散落在哪些
地方、以及新增定制时应当遵守什么纪律。

- 上游：`zai-org/ZCode`（remote `origin`），约每周推一次 squash 快照（`chore: sync ZCode source`）。
- 本 fork：`Kitsune2077/ZCode`（remote `fork`），私有 Gitea 为镜像推送目标（remote `gitea`）。

## 为什么用 merge 而不是补丁

曾考虑把本地改动做成 `.patch` 打补丁，结论是**不改**，原因：

- 补丁用「上下文行原样匹配」判定能否应用，没有三方基线；上游只要改动了相邻行就整体 reject，
  而 `git merge` 能自动判断「上游改了我没改 → 取上游」。
- 上游快照里存在文件搬迁（`WorkspaceSidebarFooter` 系列 → `project-sidebar/`）与删除
  （`scripts/prepare-prebuilds.mjs`）。这类变更下补丁只会直接失败，merge 能自动处理。
- 本 fork 的差异以**新增文件为主**（见下方统计），这部分补丁没有任何收益，只会增加维护面。

补丁只适合一次性、版本钉死、单文件的小改动，不作为主定制机制。

## 当前定制规模（随上游推进而变化，用命令重新统计）

```bash
git fetch origin && git diff --name-status origin/main main   # 完整定制差异
```

最近一次统计：**228 个文件有差异，其中 151 个是纯新增（删 0 行，永不冲突），77 个就地改写上游文件，
就地改写总删除量约 560 行，删除 ≥20 行的「重度改写」仅 9 个。**

历史上三次上游合并的冲突数：**14 → 13 → 1**。收敛原因是定制形态趋于「新增优先」，以及同步频率提高。

## 上游同步的四条机制

### 0. Gitea 侧同步（`.gitea/workflows/upstream-sync.yml`）

Gitea 与 GitHub 是两个远端，**不能让两边各自合并上游**——那会产生两个内容相同但提交不同的
`main`，之后互相推送必然非快进。因此 Gitea 侧默认是「只检测」模式：

- 每周一 06:00 检查 `zai-org/ZCode`，维护 `upstream-mirror`，在临时分支上演练合并；
- 无新提交 → 跳过；可干净合并 → 只报告（不改 `main`）；有冲突 → 开/追加 issue 并让运行变红。

需要一次性配置：仓库 Secrets 增加 `GITEA_TOKEN`（scope：`write:repository` + `write:issue`）。

**自主合并开关**：设置仓库变量 `UPSTREAM_SYNC_AUTOMERGE=1` 并添加 `GITHUB_PUSH_TOKEN`
（GitHub PAT，repo 写权限；合并若改动 `.github/workflows/` 还需 workflow scope）后，干净合并会：

1. 在 Gitea 上生成一个合并提交；
2. 把**同一个 SHA** 同时推到 Gitea 与 GitHub 的 `main`（两端历史完全一致，不会分叉）；
3. 在 issue 里记录合并提交与上游提交清单，GitHub 侧 CI 随推送自动运行。

冲突场景在两种模式下都仍然只开 issue，不会动 `main`。

与 GitHub 侧 workflow 互不依赖且幂等：任一侧合并完成后，另一侧下一轮会检测到「已包含上游」直接跳过。

### 1. 定时同步 workflow（`.github/workflows/upstream-sync.yml`）

每周一 06:00 UTC 自动运行，也可手动触发（Actions → Upstream sync → Run workflow）：

- 把 `upstream-mirror` 分支同步到上游 HEAD；
- 试合并 `upstream/main` 进 `main`：
  - **干净合并** → 推 `upstream/sync` 分支并创建/更新 PR（带上游提交清单）；
  - **有冲突** → 不开 PR：把冲突文件与手工命令写进**运行摘要**，让这次运行**变红**，并创建或追加
    issue「上游同步需要手工解决冲突」（Issues 已开启，issue 是主要通知渠道；摘要与红运行是兜底）。
- 用 `GITHUB_TOKEN` 推送的分支/PR 不会触发其它 workflow，PR 上没有 CI 结果；合并前按下方
  验证清单本地验证，或手动 `gh workflow run "Unit tests" --ref upstream/sync`。

> 取上游时**不要**加 `--tags`：本 fork 存在与上游同名但指向不同提交的本地 tag，git 会以
> `would clobber existing tag` 拒绝并让 fetch 整体失败（workflow 首跑就踩过）。

### 2. `upstream-mirror` 分支（machine-owned）

本 fork 上的一条只读镜像分支，永远等于上游 `main`。用途：

```bash
git fetch fork && git log --oneline fork/upstream-mirror..main    # 我们比上游多做了什么
git diff --stat fork/upstream-mirror main                        # 定制差异总览
```

不要在其上提交——每次同步会被强制覆盖。

### 3. `git rerere`（复用冲突解决结果）

仓库无法提交 git 配置，**每个克隆需要执行一次**：

```bash
git config rerere.enabled true
git config --get rerere.enabled      # 应输出 true
```

它会记录冲突的解决结果，下次遇到相同冲突自动重放。对追加型清单文件（`test-ids.ts`、
`architecture-policy.yaml`、`package.json` 的脚本区、`channels.ts`/`platform.ts` 的类型导入）
特别有效——这类冲突在历次合并中反复出现且解法固定。

`git rerere status` 查看已记录状态；如果发现自动重放的内容不对，用 `git rerere forget <file>`
清掉该文件的记录。

### 4. 定制点清单（下表）

## 定制域与就地改写点

统计口径：`git diff --numstat origin/main main` 中「有删除行」的文件（真正改动了上游逻辑）。

| 定制域 | 就地改写 | 形态与风险 |
| --- | --- | --- |
| NewAPI 自建网关接入 | 少量插入点（`test-ids`、`channels`/`platform` 类型导入、`SettingsPage`、`WorkspaceSidebarFooter`、`node.ts`） | 主体 17 个新文件；插入点都是「追加一行」，冲突好解 |
| 便携数据目录 / data 目录约定 | `desktopDataBaseDirBootstrap.ts`、`desktopChromiumHardwareAccelerationBootstrap.ts`（各 <10 行删除） | 主体是新增 `desktopPortableHome.ts`（纯新增）；插入点在启动早期链路，改这里要重跑验收场景 |
| 外部会话导入 / 会话迁移 | `useClaudeSessionMigration.ts`（-81）、`skillSyncService.ts`（-70）、`persistImportedClaudeTask.ts`（-25） | **风险最高**：这三个是上游函数体就地改造；上游若重写这些流程会正面冲突 |
| 自动更新 / 更新源 | `autoUpdater.ts`（-8 +178）、`manifestUpdateProvider.ts`、`electron-builder.config.js` | 以新增 provider 文件为主，`autoUpdater.ts` 的改动集中在一个 decide 分支 |
| composer 速率指标 | `V4ComposerToolbar.tsx`、`UsageStatsSection.tsx`、`usage-stats.ts`（各 1~3 行删除） | 新增 `V4ComposerUsageStats.tsx` + `usageStatusBarModel.ts`；插入点很小 |
| PowerShell 7 集成终端 | `cwd-capture.ts`（-4）、`bash-shell-snapshot.ts`、`guarded/command.ts`、`integratedTerminalShells.ts` | 上游若重写 shell 探测链路会冲突；改完要跑 `systemService` / `exec` 相关测试 |
| 模型 Provider 定制 | `ProviderTemplatePicker.tsx`（-62）、`ProviderCardSections.tsx`（-12） | 与 NewAPI 联动，上游改 provider 卡片时需手工合 |
| 侧栏 / 设置页插入点 | `WorkspaceSidebarFooter.tsx`（-7）、`WorkspaceSidebarFooterUsageSummary.tsx`（-26）、`SettingsPage.tsx`（-1）、`WelcomeScreen.tsx`（-1）、`settingsPageConfig.ts`（-6） | 上游频繁重构这两块（如 `project-sidebar/` 搬迁）；原则：**取上游结构，再把我们的插入点加回** |
| Lark CLI 插件 | 无就地改写（纯新增目录 + 构建脚本登记） | 零冲突风险，可作为「新增优先」的样板 |
| 构建 / CI / 工程策略 | `package.json`（版本 + `verify:pre-push`）、`.husky/pre-push`、`.gitattributes`、`.oxfmtrc.json`、`scripts/dev-desktop-env.mjs`、`scripts/spawn-command.mjs`、`scripts/mise-toolchain-env.mjs` | 版本号与 `verify:pre-push` 每次都会冲突，解法固定（取上游版本号；pre-push 保留「不跑单测」） |
| 架构门禁豁免 | `architecture-policy.yaml` | 纯追加清单，两侧都保留即可（rerere 最擅长的场景） |
| 其它零星 | `localUsageEvidence.ts`、`zcodeAgentProcessManager.ts`、i18n 词条、若干测试文件 | 多为小规模适配 |

> 重新生成完整清单（含新增文件）：
> `git diff --numstat origin/main main` — 第三列即路径，第二列为 0 的是纯新增。

## 例行合并流程

1. `git fetch origin --tags` 看上游新快照；
2. 优先等定时 workflow 的 PR（无冲突），或按 issue 提示手工处理；
3. 手工合并时：

   ```bash
   git merge origin/main          # 冲突时逐个解决，遵循下表规则
   ```

4. 解决冲突的通用规则：

   | 冲突类型 | 处理方式 |
   | --- | --- |
   | 纯追加清单（`test-ids.ts`、`architecture-policy.yaml`、locale 词条） | 两侧都保留 |
   | `package.json` 版本号 | 取上游版本号 |
   | `package.json` 的 `verify:pre-push` | 保留本地「不跑单测」策略，同时吸收上游新增的静态检查 |
   | 上游重构了插入点文件（侧栏、SettingsPage、`index.ts`） | 取上游结构，再把本地插入点加回 |
   | 上游删除 / 搬迁了本地改过的文件 | 跟随上游搬迁（如 `project-sidebar/`），确认本地逻辑仍在 |
   | 上游改了 `test-ids.ts` / `index.ts` 的导出链 | 检查 `@zcode/shared` 是否仍 re-export `test-ids.js`（曾因上游重写漏掉导致 NewAPI testid 全部 TS2305） |

5. 验证（见下），提交合并，推送 `fork main`。

## 验证清单

本地（Windows 需要 8GB 堆）：

```bash
pnpm install --frozen-lockfile
$env:NODE_OPTIONS="--max-old-space-size=8192"   # PowerShell；bash 用 export
pnpm typecheck
pnpm lint
pnpm run db:schema:check
pnpm run test:architecture
pnpm architecture:check --changed
```

推送后 CI（`unit-tests.yml`）会跑全量单测；绿了才算完成。

有行为改动时按 AGENTS.md 的约定先补测试与 spec。

## 新增定制时的纪律

1. **新增优先**：新功能尽量落到新文件 + 一处注册点，不要改上游函数体。Lark CLI 是正例（零冲突），
   NewAPI 纵切是次优（17 新文件 + 少量插入）。
2. **就地改写必须加标记**：`// 本仓库定制：<原因>`，合并时按标记逐一核对。
3. **架构门禁登记**：新增到未受控目录的文件会被 `architecture:check` 判为 `unmanaged-new-file`，
   在 `architecture-policy.yaml` 的 `exceptions` 里按域追加一条（`rule` + `paths` + `reason`）。
   这是上游自己也使用的机制。
4. **先写 spec**：行为改动先在 `docs/` 或 `specs/` 落 spec（含验收场景），再写代码。
5. **不要为了少冲突而拆散状态**：上游的 `max-file-lines` 等门禁优先用豁免登记，而不是机械拆分。
