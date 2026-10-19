# session-import

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

意图：把外部 Agent（OpenCode、DeepSeek Harness）与 ZCode 安装版（真实用户主目录 `~/.zcode`）的原生会话库转成可续聊的 ZCode 会话，面向 Windows 便携版实例接收安装版数据。每个来源一个 `*-native` 子目录，形状遵循 `contract.ts` 的 scan/import 两意图；zcode-installed 来源的位置是确定性的（`os.homedir()` 下的安装版数据，repo 拒绝指向当前运行实例自身），并提供独立的配置导入（provider/凭据/CLI 配置，只补缺失不覆盖）。

不变量：

- 扫描只读来源库，不写任何状态；导入的每条会话独立成败并聚合为 imported/skipped/failed。
- 会话事实只有一条写入路径：`createImportedSession`（由 zcode-agent 适配器创建真实 ZCode session 并落 task index 行），本模块只在其返回的行上补 `migrationSource` presentation 与 searchableText，不凭空建行。
- legacy snapshot（`~/.zcode/v2/sessions/...`）只是迁移备份，不是第二个事实源；来源端运行态（mode/model/provider）在写入前被清洗。
- 重新导入同一来源永远产生新 task（新 sessionTraceId），不覆盖已删除或已继续对话的记录。

交集：task index 事实经 `session` 模块公开入口（`taskIndexRepo.ts`）；快照写入与标题归一复用 `session` 的 `legacyTaskSessionFile.ts` / `sessionTitle.ts`；协议命令在 `shared` 的 zcode-protocol 登记，UI 只经 `useClaudeSessionMigration` 的 provider 参数触达。
