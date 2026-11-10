# Windows 自定义卸载器规范

## 背景与目标

受管终端（奇安信天擎、TSafe Doc 透明加密等）会拦截 NSIS 卸载器的临时自复制：`Uninstall ZCode.exe` 启动时把自身复制到 `%TEMP%\~nsu.tmp\Au_.exe` 再执行，拦截后表现为 `Error launching installer`；提权后即使能打开，文件删除仍可能被文件保护/加密驱动拒绝，而普通卸载分支 `RMDir /r $INSTDIR` 不会检查单个文件失败，造成“进度走完但没有卸载”。

本规范引入独立的自定义卸载器 `ZCodeUninstall.exe`，替换用户可见的卸载入口：

- 稳定路径（`$INSTDIR\ZCodeUninstall.exe`），不把自身复制到临时目录再执行；
- 与 `ZCode.exe` 使用同一代码签名证书；
- 删除失败必须可见：记录具体路径、Win32 错误码和失败分类，返回非零退出码；
- 自动更新仍使用官方 NSIS 卸载器清理旧文件，避免重写已经验证过的 manifest 清理契约；
- 不绕过、不关闭天擎/TSafe。策略层拒绝删除时，自定义卸载器只负责准确报告并给 IT 可操作的信息。

## 非目标

- 不实现内核/驱动级绕过，不关闭或停用终端安全/加密软件。
- 不替代自动更新链路中的官方 NSIS 卸载器；`--updated` 只做参数转发和退出码透传。
- 默认不删除用户数据；删除 `~/.zcode` 必须由用户显式勾选/传参并二次确认。
- 不承诺清理任务栏固定项、跳转列表等 Shell 状态的全部变体；只做与安装目录匹配的 best effort。

## 状态所有者与入口

| 关注点 | 所有者 |
| --- | --- |
| 用户可见卸载入口 | `packages/desktop/build/installer.nsh` 的 `customInstall`，仅在 `$INSTDIR\ZCodeUninstall.exe` 存在时覆盖 `UninstallString` / `QuietUninstallString` |
| 自定义卸载器构建 | `packages/desktop/scripts/build-windows-uninstaller.mjs` + `packages/desktop/native/windows-uninstaller/` |
| 自定义卸载器清理状态 | `ZCodeUninstall.exe`（唯一写入者；安装器只负责安装入口和覆盖注册表值） |
| 自动更新旧文件清理 | 官方 `Uninstall ZCode.exe`（自定义卸载器 `--updated` 只转发） |
| 便携判定 | `packages/desktop/src/main/desktopPortableHome.ts`（`Uninstall*.exe` 存在性，保持不变） |
| 打包与签名 | `packages/desktop/electron-builder.config.js` 的 `extraFiles`、`afterPack`、`afterSign` |

`ZCodeUninstall.exe` 必须命名为不匹配 `^Uninstall.+\.exe$` 的名字；否则 zip 便携包解压后会被判定为安装版。官方 `Uninstall ZCode.exe` 永远保留在安装目录，直到 `ZCode.exe` 已成功删除。

## 模式与行为

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| 交互 | 设置 → 应用、开始菜单/桌面入口、直接运行 | WinForms UI；确认后关闭进程、删除程序文件、快捷方式、安装/卸载键；默认保留数据；显示失败摘要和日志路径 |
| 静默 | `/S` 或 `--silent` | 无 UI，执行同一清理；以退出码表达结果 |
| 更新委托 | `--updated`（由新安装器传入） | 无 UI；定位 `$INSTDIR\Uninstall*.exe`，原样转发旧卸载器参数并返回其退出码；不删除数据、不改入口 |
| 便携保护 | 同目录无官方 `Uninstall*.exe` 且无匹配安装/卸载键 | 拒绝执行，除非 `--force`；避免误删 zip 便携包 |
| 预演 | `--dry-run` | 只枚举和记录计划，不修改文件/注册表/快捷方式 |

### 更新委托参数契约

新安装器调用旧卸载器的形式（`node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh:224`）：

```text
"<old-uninstaller>" /S /KEEP_APP_DATA <mode> [--keep-shortcuts] (--updated|--delete-app-data) _?=<installDir>
```

自定义卸载器在 `--updated` 下必须：

- 不显示任何 UI，不等待用户输入；
- 从 `_?=` 或注册表 `InstallLocation` 解析安装目录；
- 选择 `$INSTDIR\Uninstall*.exe`（排除自身），转发 `/S`、`/KEEP_APP_DATA`、`/allusers|/currentuser`、`--keep-shortcuts`、`--delete-app-data`、`--updated`；`_?=` 放在命令行最后；
- 返回官方卸载器退出码；官方缺失时返回 2；
- 不转发 `--delete-user-data`、`--dry-run`、`--force`、测试专用参数。

## 清理范围

| 范围 | 默认 | `--delete-app-data` | `--delete-user-data` |
| --- | --- | --- | --- |
| `$INSTDIR` 程序文件（除自身） | 删除 | 删除 | 删除 |
| `ZCode.exe` | 删除；失败则保留官方卸载器并返回 2 | 同左 | 同左 |
| 官方 `Uninstall*.exe` | 在 `ZCode.exe` 删除成功后删除 | 同左 | 同左 |
| `ZCodeUninstall.exe` 自身 | 退出后通过 RunOnce 删除；目录可能保留到下次登录 | 同左 | 同左 |
| 开始菜单/桌面快捷方式（目标在本安装目录） | 删除 | 删除 | 删除 |
| 任务栏固定项（目标在本安装目录） | 删除（best effort） | 删除 | 删除 |
| `HKCU/HKLM ...\Uninstall\<key>`、`Software\<GUID>` | 删除 | 删除 | 删除 |
| `HKCU\Software\Classes\zcode` | 仅当 `shell\open\command` 指向本安装目录 | 同左 | 同左 |
| `Directory/Drive\shell\ZCode.OpenInZCode` | 仅当 `command`/`Icon` 指向本安装目录 | 同左 | 同左 |
| `%APPDATA%\<productName>` | 保留 | 删除 | 删除 |
| `%USERPROFILE%\.zcode` | 保留 | 保留 | 删除（强警告） |
| 自定义 `dataBaseDir`、CLI `storage.dir` | 保留 | 保留 | 保留（不猜测路径） |
| `%LOCALAPPDATA%\zcode-updater` | 保留 | 保留 | 保留 |

安装目录内检测到 `.zcode` 或 `data\.zcode` 时：

- 交互：提示路径并默认取消；用户确认继续才删除；
- 静默：返回 2，除非显式 `--force`；
- 更新委托模式不参与该检查（官方 NSIS 按既有 manifest 契约处理）。

文件遍历不跟随 junction/reparse point，避免安装目录里的链接把删除动作带到外部目录；扫描被拒绝时记录 `scan-failed` 并按部分失败返回。

## 失败分类与退出码

日志：`%TEMP%\ZCode-uninstaller.log`，UTF-8，追加写入，每条带 `[pid=<十进制>]`。若 `%TEMP%` 不可写，回退 `%LOCALAPPDATA%\ZCode\uninstaller.log`，再失败则只在 UI 显示路径。

| 退出码 | 含义 |
| --- | --- |
| 0 | 程序文件、安装/卸载键、匹配的快捷方式已清理；自身/空目录可能待下次登录清理 |
| 1 | 参数/环境拒绝：便携保护、用户取消、无权限且未提权 |
| 2 | 部分失败：文件被占用/拒绝、注册表删除失败、官方卸载器缺失、数据删除失败 |
| 其他 | `--updated` 模式原样返回官方卸载器退出码 |

失败分类：

- `file-in-use`：共享冲突/锁定；可重试，仍失败则安排 RunOnce 清理；
- `access-denied-security-software`：`ERROR_ACCESS_DENIED`；不安排静默删除，提示联系 IT 放行“ZCodeUninstall.exe + ZCode.exe（签名：北京智谱华章）”；
- `registry-access-denied`：注册表删除被拒绝；
- `official-uninstaller-missing`：更新委托找不到官方卸载器；
- `embedded-data-present`：安装目录内有 `.zcode`/`data\.zcode` 且未 `--force`。

关键 markers：

```text
custom-uninstaller-started mode=interactive|silent|updated|dry-run
cleanup-started
process-scan
process-kill pid=<n> path=<...>
cleanup-failed path=<...> reason=<...> code=<n>
cleanup-completed files=<n> failed=<n>
update-delegation-started
update-delegation-completed exit-code=<n>
```

## 提权

- manifest 使用 `asInvoker`；per-user 安装不需要 UAC。
- per-machine（安装目录在 Program Files 或匹配 HKLM 安装键）且当前未提权时，自定义卸载器以 `runas` 重新启动自身并退出外层；用户取消 UAC 返回 1。
- 更新委托模式不自提权，交给官方卸载器按既有 `UAC` 逻辑处理。

## 打包、签名与构建

- `packages/desktop/electron-builder.config.js` 在 win32 目标上通过 `extraFiles` 把 `ZCodeUninstall.exe` 放到 `$INSTDIR`；`afterPack` 断言存在且为 PE，`afterSign` 在签名开启时断言签名有效且与 `ZCode.exe` 同证书。
- 构建使用 `dotnet build` 编译 `net48` 工程；Linux 交叉构建依赖 `Microsoft.NETFramework.ReferenceAssemblies` 包。Windows 原生和 Gitea Ubuntu 交叉构建都必须产出该 exe，缺失时构建失败。
- `.gitea/workflows/build-desktop-win.yml` 必须安装 .NET SDK；GitHub `windows-latest` 自带。
- 正式发布必须使用与 `ZCode.exe` 相同的证书签名。未签名构建可以打包，但受管终端可能拦截，不视为本规范的功能保证。

## 验收场景

1. per-user 交互卸载：`ZCode.exe`、`resources/**`、官方卸载器、`ZCodeUninstall.exe` 自身（下次登录）、快捷方式、HKCU 安装/卸载键被清理；`~/.zcode` 和 `%APPDATA%\ZCode` 保留；退出码 0。
2. per-machine：UAC 提权；Program Files、HKLM 键、公共桌面快捷方式清理；退出码 0。
3. 天擎/TSafe 拒绝删除：不出现“假成功”；日志含 `cleanup-failed ... reason=access-denied-security-software`；UI 给出日志和签名信息；退出码 2。
4. 便携 zip：直接运行 `ZCodeUninstall.exe` 被拒绝（退出码 1），`ZCode.exe` 仍按 `data\.zcode` 便携数据根运行。
5. 自动更新：上一版本 `UninstallString` 指向 `ZCodeUninstall.exe`，新安装器执行 `/S ... --updated`；自定义卸载器委托官方 NSIS，更新成功，旧文件按 manifest 清理，新版本重新安装 `ZCodeUninstall.exe`。
6. 静默卸载：`/S` 无 UI；退出码与日志符合上表。
7. 数据删除：默认保留；`--delete-app-data` 只删 `%APPDATA%\<productName>`；`--delete-user-data` 删除 `~/.zcode` 和 `%APPDATA%\<productName>`，且更新委托模式不转发该参数。
8. 预演：`--dry-run` 不修改任何文件/注册表/快捷方式，日志列出计划。
9. 安装目录内嵌 `.zcode`：交互默认取消；静默返回 2；`--force` 才继续。
10. 签名：正式 Windows 构建的 `ZCodeUninstall.exe` Authenticode 有效，签名者与 `ZCode.exe` 相同。

## 已知限制

- 策略层拒绝删除时，用户态无法完成卸载；只能由 IT 放行或停用加密客户端。
- 自动更新委托多一层进程；需在真实天擎/TSafe 机器验证“安装器 → 自定义 exe → 官方 NSIS”链路。若不通过，更新会明确失败，可回滚为不覆盖 `UninstallString`。
- 依赖 .NET Framework 4.8（Windows 10/11 默认自带）；被禁用时自定义卸载器不可用，官方 `Uninstall ZCode.exe` 仍可手动执行。
- 当前检出缺少 `scripts/sign-windows.ps1`；正式签名流水线必须提供，否则签名构建失败。
- AUMID 注册、任务栏固定项、跳转列表仅做 best effort。
