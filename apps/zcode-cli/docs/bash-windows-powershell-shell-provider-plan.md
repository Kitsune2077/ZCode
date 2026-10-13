# Windows PowerShell 7 集成终端 Shell 接入计划

**目标：**在 Windows 上检测到 PowerShell 7（`pwsh.exe`）时，设置页“集成终端Shell”下拉新增 `PowerShell 7` 选项；用户显式选择后，`Bash` tool 的命令实际经 `pwsh` 执行。

**边界：**

- 不新增 provider-visible `PowerShell` tool；仍然只有 `Bash` tool，`display.name` 通过 envInfo 告知模型当前 shell 为 `PowerShell 7`，由模型自适应命令语法。
- “自动选择”语义不变：auto 仍按 Git Bash → `ComSpec`/`cmd.exe` 顺序解析，PowerShell 只在用户显式选择时生效。
- 不加载用户 `$PROFILE`（`-NoProfile`），与 CMD 跳过 AutoRun 的既有行为对齐；`$PROFILE` 里的 conda/nvm 激活、别名不生效，系统 PATH 工具不受影响。
- 不引入 shell-init snapshot：现有 snapshot 机制只覆盖 posix/git-bash 文法，PowerShell 不接入；每次执行都是干净环境。
- 不注入 embedded search prelude：`find`/`grep` shell function 是 POSIX 文法，`supportsEmbeddedSearchShellSelection` 继续只放行 posix/git-bash。
- 不改变 generic `ExecutionPort` shell mode 的默认行为；pwsh provider 只在 `shellProfile === "posix-bash"` 的内部路径生效。

## 探测（host 侧枚举）

`packages/services/src/system/integratedTerminalShells.ts`：

1. 由 `%ProgramFiles%`、`%ProgramFiles(x86)%` 推导 `PowerShell\7\pwsh.exe`（命中记 `source: "system"`）。
2. 未命中再扫 PATH 里的 `pwsh.exe`（复用 `windowsExecutableCandidates`，覆盖 Microsoft Store 安装；记 `source: "path"`）。
3. 找不到则不出现该选项，UI 与设置存储自动兼容。

选项顺序保持 CMD、Git Bash、PowerShell 7。label 固定 `PowerShell 7`（`pwsh.exe` 实际对应 PowerShell 6+，实践中均为 7.x）。

## shared 契约

- `IntegratedTerminalShellDialect` 增加 `"powershell"`（与 `"cmd"` 一致取 shell 家族名，不取二进制名）。
- `ExecutionShellDialect` 同步增加 `"powershell"`。
- settings zod schema 与协议 schema 的引用点统一加 `.catch(undefined)` 降级：旧版本读到新版本写入的 powershell 值时按 launch.md 未知值策略降级为“自动”，不得让整份 settings 或协议消息解析失败。

## 执行语义（adapter）

provider shape：`{ dialect: "powershell", file: <pwshPath>, shell: false }`。

spawn 参数：

```
pwsh.exe -NoLogo -NoProfile -NonInteractive -Command <command>
```

- `-NonInteractive` 使 `Read-Host` 等交互调用直接失败而不是挂起。
- login-mode 切换（`setResolvedShellLoginMode`）只识别 `args[0] === "-c"` 的 POSIX 形状，对 pwsh 天然无操作；`applyResolvedShellCommand` 需要显式 powershell 分支（替换 args 末位），否则会落入“file = command”的 fallback 直接把命令当可执行文件 spawn。
- user-config 选择在 resolve 时校验 `path` 可执行，失效则回落 auto（与 git-bash override 一致）；无 `cmd.exe` 那样的裸名 fallback 特例。

## cwd capture wrapper（PowerShell 文法）

对齐 bash/cmd wrapper 的语义：命令成功时把最终目录写回，退出码保持命令事实。

```powershell
<command>
$__zcode_status = if ($?) { 0 } else { 1 }
if ($__zcode_status -eq 0) { [IO.File]::WriteAllText('<cwdFile>', $PWD.ProviderPath) }
exit $__zcode_status
```

- `$PWD.ProviderPath` 避免 PSDrive 前缀（`Microsoft.PowerShell.Core\FileSystem::`）污染路径。
- `[IO.File]::WriteAllText` 输出 UTF-8 无 BOM，`readCapturedCwd` 的 utf8 读取直接兼容。
- cwd file 路径嵌入时单引号转义（`'` doubling）。
- 显式 `exit $__zcode_status`：`pwsh -Command` 的进程退出码不透传 `$LASTEXITCODE`，必须由 wrapper 决定。

## 输出编码

沿用现有 Windows legacy 解码：`resolveLegacyExecutionOutputEncoding` 经 `chcp` 探测活动代码页，decoder 按 buffer 自动识别 UTF-8/legacy。pwsh 自身 cmdlet 输出与原生命令转发遵循控制台代码页，与 cmd 路径行为一致，不新增分支。

## guarded 危险命令分析

`matchDangerousCommand` 对 `powershell` dialect 直接返回 `unsupported`（同 `legacy-shell` 待遇）：仓库没有 PowerShell 文法分析器，用 bash/cmd 文法误判比不判更危险。`unsupported` 后 guarded 退回保守姿态——非只读命令走审批，方向安全，代价是 pwsh 会话的审批提示可能偏多。

## 会话快照兼容

`bash-shell-snapshot.ts` 的 dialect 白名单加 `"powershell"`：session-start 快照落库、冷恢复校验（`path` 可执行性 accessSync）与 resume notice 均复用既有逻辑，`display.name` 为 `PowerShell 7` 时 telemetry `commandShellKind` 亦自动归入 `powershell`。
