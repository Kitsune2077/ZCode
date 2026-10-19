# Windows 设置新增 PowerShell 7 集成终端 Shell 选项

## 背景与现状

设置页的"集成终端 Shell"控制 Windows 下 Bash 工具用哪个 shell 执行命令。当前支持 CMD 与 Git Bash，选项由 host 侧运行时探测生成（非硬编码 UI），已选中值经 settings → 协议 → CLI 执行层生效。加 PowerShell 7 需要：探测层 + shared 类型/schema + 执行层 provider（否则选了不生效）。

关键决策（已与用户确认）：执行命令用 `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>`，不加载 `$PROFILE`（与 CMD 跳过 AutoRun 对齐，环境干净可预测）。

## 改动方案

### 1. 设计文档先行（AGENTS.md spec 要求）
- 新增 `apps/zcode-cli/docs/bash-windows-powershell-shell-provider-plan.md`：记录 pwsh provider 语义（参数、cwd wrapper、guarded 退化策略、无 shell-init snapshot / 无 embedded prelude、auto 探测不变）。
- 修订 `bash-windows-git-bash-shell-provider-plan.md:211`、`bash-cwd-persistence-plan.md:62,769` 中"PowerShell 为后续范围"的表述，指向新文档。

### 2. shared 类型与 schema（packages/shared）
- `src/protocol.ts:88`：`IntegratedTerminalShellDialect` 增加 `"powershell"`（命名与 `"cmd"` 风格一致，取 shell 家族名而非二进制名）。
- `src/validationAppSettings.ts:56`：zod dialect 枚举加 `"powershell"`。
- 向后兼容（launch.md 未知值降级策略）：`appSettingsObjectSchema:471`、patch schema:553、协议 `zcode-protocol/index.ts:2076` 三处引用点统一为 `integratedTerminalShellSelectionSchema.optional().catch(undefined)`（仓库已有此模式，如 `dynamicWorkflowModeSettingSchema`），旧版本读到 powershell 值时降级为"自动"，不会让整份 settings 或协议消息解析失败。

### 3. 探测层（packages/services）
`src/system/integratedTerminalShells.ts`：
- 新增 `resolveWindowsPowerShell()`：候选路径由 `%ProgramFiles%` / `%ProgramFiles(x86)%` 推导 `PowerShell\7\pwsh.exe`（命中记 `source: "system"`），未命中再走 PATH 扫描 `pwsh.exe`（复用现成 `windowsExecutableCandidates`，可覆盖 Microsoft Store 安装；记 `source: "path"`）。
- `listIntegratedTerminalShellOptions()` 在 Git Bash 之后追加 `{ dialect: "powershell", id: "powershell:<path>", label: "PowerShell 7", ... }`。选项顺序：CMD、Git Bash、PowerShell 7。

### 4. 执行层（apps/zcode-cli）
- `packages/contracts/src/interfaces/execution.port.ts:30`：`ExecutionShellDialect` 加 `"powershell"`。
- `packages/adapters/src/exec/bash-shell-provider.ts`：
  - 新增 `createPowerShellProvider()`（`file: pwshPath, shell: false`）。
  - `createShellProviderFromSelection()` 与 `resolveEffectiveWindowsBashShellSelection()` 增加 powershell 分支：user-config 时校验 `override.path` 可执行，无效则回落 auto（auto 优先级保持 Git Bash → legacy 不变，pwsh 仅显式选择生效）。
- `packages/adapters/src/exec/execution-command.ts`：
  - `createShellProviderCommand()` powershell 分支：`args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]`。login-mode 切换只识别 `args[0] === "-c"`，天然不受影响。
  - `applyResolvedShellCommand()` powershell 分支：替换 args 末位（-Command 载荷），必须加，否则会落入 fallback 直接把命令当可执行文件 spawn。
- `packages/adapters/src/exec/cwd-capture.ts`：powershell wrapper（对齐 bash/cmd wrapper 语义）：
  ```powershell
  <command>
  $__zcode_status = if ($?) { 0 } else { 1 }
  if ($__zcode_status -eq 0) { [IO.File]::WriteAllText('<cwdFile>', $PWD.ProviderPath) }
  exit $__zcode_status
  ```
  路径单引号转义（`''` doubling）；输出 UTF-8 无 BOM，`readCapturedCwd` 直接可读。
- `packages/core/src/runtime/methods/bash-shell-snapshot.ts:208`：`isExecutionShellDialect` 加 `"powershell"`（会话快照持久化/恢复兼容）。
- `packages/core/src/tool/handlers/guarded/command.ts:55`：`dialect === "powershell"` 时返回 `unsupported`（同 legacy-shell 待遇）——避免用 bash 文法误判 pwsh 命令，guarded 模式退回保守审批（安全方向）。
- `bootstrap/src/zcode-protocol/server-operations.ts:3217`：display name 映射加 powershell → `"PowerShell 7"`。
- 无需改动（已确认自动兼容）：embedded search 白名单（只认 posix/git-bash，pwsh 自动排除）、shell-init snapshot（只认 posix/git-bash）、telemetry `commandShellKind`（display.name 含 "powershell" 已命中）、模型侧 Shell 提示（`display.name` 经 envInfo 下发，模型会自适应 pwsh 语法）、输出编码（现有 chcp 自动探测对 pwsh 同样适用）。

### 5. UI（packages/ui）
零改动——选项列表动态加载（`SettingsPage.tsx:875-892`），选中值回显与容错（`settingsPageHelpers.tsx:200-248`）均已就绪，label 来自探测结果。

### 6. 测试
- `packages/services/test/systemService.test.ts`：pwsh 静态路径命中 / PATH 命中 / 未安装不出现 / 顺序。
- `packages/shared/test/appSettings.test.ts`：powershell selection 读写 roundtrip；未知 dialect 降级 undefined。
- `apps/zcode-cli/packages/adapters/tests/exec.test.ts`：user-config powershell 解析、路径失效回落 auto、spawn args、`applyResolvedShellCommand`、cwd capture wrapper。
- `packages/core/tests/embedded-search-shell.test.ts`：powershell → false。
- `packages/core/tests/guarded-command.test.ts`：powershell → unsupported。
- shell snapshot 持久化测试补 powershell roundtrip。

### 7. 验证
- `node scripts/check-workspace-freshness.mjs`
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
- 运行上述新增/修改的 vitest 用例
- 本机为 Windows，可实测探测结果；完整 UI 端到端（设置页选 pwsh → Bash 工具实际走 pwsh）不在自动化范围，将如实说明验证边界。

### 风险说明
- `pwsh -Command` 经 Node spawn 的参数转义在极端特殊字符下有边缘情况（与 git-bash `-c` 同级风险，非本次引入）。
- guarded 模式下 pwsh 命令无专用文法分析，非只读命令会走保守审批（提示可能变多，方向安全）。