# 便携版数据目录（Portable Data Dir）

## 背景与产品规则

Windows 便携包是 `win-unpacked` 的 zip（`electron-builder.config.js` 中 `win.target` 的 `zip` 项），
解压后直接双击 `ZCode.exe` 运行。此前它与安装版共用同一套数据落点（用户主目录的 `~/.zcode`），
便携用户换机器时无法"拷走目录即迁移配置"。

本功能让**便携版默认把 `.zcode` 数据目录放在应用程序同级目录**：

- 便携版：`<exe 目录>/.zcode`（settings、凭据、会话、技能等全部随程序走）；
- 便携版（data 目录约定）：用户在 exe 同目录手动创建 `data` **目录**后，锚点整体切换为
  `<exe 目录>/data`，全部状态落在 `<exe 目录>/data/.zcode`，方便把数据与程序目录分开
  （例如程序目录放只读介质、data 单独映射，或备份时只拷 data）；
- 安装版：行为完全不变，仍使用 `~/.zcode`（`data` 目录约定仅在便携分支生效——安装目录
  由安装器/更新器管理，在 Program Files 下创建旁路数据目录属于误操作场景，不鼓励）。

### data 目录约定细则

- 判定条件：便携判定生效 **且** `<exe 目录>/data` 存在 **且** 是目录（同名文件视为未创建，
  维持便携默认）；目录名按平台默认大小写规则匹配（win32 文件系统大小写不敏感）；
- 生效方式：`data` 目录**替换便携默认锚点**（settings 锚点与数据根默认值一起切换），
  不是叠加的二级子目录开关；因此 setting.json 改从 `<exe 目录>/data/.zcode/v2/setting.json`
  读取，其中用户显式配置的 `dataBaseDir` 依旧按第 2 级优先级生效；
- 切换语义：创建 / 删除 `data` 目录在下一次启动生效；切换**不做数据迁移**——旧
  `<exe 目录>/.zcode` 保持原样不再读取，需要保留旧数据时由用户自行拷贝到
  `<exe 目录>/data/.zcode`。

### 便携判定（仅 Windows、仅打包态）

`app.isPackaged === true` 且 exe 同目录**不存在** `Uninstall*.exe`：

- electron-builder 的 NSIS 安装版一定带 `Uninstall <产品名>.exe`；
- zip 便携包（win-unpacked 内容）没有卸载器；
- 开发态（`process.defaultApp` 为真 / 未打包）与非 Windows 平台不参与判定。

### 优先级（高 → 低）

1. 显式环境变量 `ZCODE_DATA_BASE_DIR` / `ZCODE_DESKTOP_HOME_DIR`（开发者与 e2e 的隔离手段）——
   便携判定（含 data 目录约定）**不覆盖**任何已显式设置的环境变量；
2. 当前生效锚点的 setting.json 里用户显式配置的 `dataBaseDir`（设置页"数据目录"功能；
   data 目录存在时锚点为 `<exe 目录>/data`，否则为 exe 目录）；
3. 便携 `data` 目录约定：用户手动创建的 `<exe 目录>/data`（替换便携默认锚点）；
4. 便携默认：exe 同目录；
5. 默认主目录（现状，安装版走这里）。

"应用同目录配置优先"由此结构自然成立：便携判定生效时数据根就是 exe 目录，
即便机器上同时存在 `~/.zcode`（例如同机曾装过安装版），也不会被读取。

### 写保护兜底

便携介质只读（写保护 U 盘、无权限目录）时，启动早期做一次可写探测；失败则回退用户主目录并
打印 warn 日志，避免启动即崩。

## 状态所有权与实现锚点

| 关注点 | 所有者 |
| --- | --- |
| 便携判定 + 启动早期优先级计划 | `packages/desktop/src/main/desktopPortableHome.ts`（纯函数，依赖注入可测） |
| 早期 bootstrap（读 setting.json、设 env、`setDataBaseDir`） | `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts`（index.ts 首个副作用 import） |
| settings 锚点（setting.json 位置） | `ZCODE_DESKTOP_HOME_DIR` 环境变量，`settingService.resolveUserHomeDir` 消费（既有机制） |
| 数据根（sessions/凭据/技能/库） | `setDataBaseDir()` / `getDataBaseDir()`（services/paths.ts，既有机制） |
| 子进程传播 | `buildHostProcessEnv` 既有逻辑：`ZCODE_DATA_BASE_DIR`（dataBaseDir ≠ homedir 时下发）+ env 继承 `ZCODE_DESKTOP_HOME_DIR`（不在 sanitize 剔除清单） |
| Electron home | `runtimeHomePath` 读取 `ZCODE_DESKTOP_HOME_DIR` 后 `app.setPath("home", ...)`（既有 e2e 多实例机制，便携复用） |

bootstrap 顺序依赖：`desktopEarlyDataBaseDirBootstrap` 必须先于
`desktopEarlyChromiumHardwareAccelerationBootstrap` 与 `desktopRuntimeEnv` 求值
（index.ts import 顺序保证），使后两者读到便携 env。

## 与"Windows 禁止安装目录作数据目录"守卫的关系

`validateDataBaseDirTarget`（services/paths.ts）禁止用户把数据目录**手动改到**应用安装目录，
理由是安装版目录由安装器/自动更新管理，升级可能覆盖数据。便携目录不属于更新器管理范围
（zip 便携包不走原地自动更新），且便携落点由启动判定而非用户选择产生，不经过该守卫；
设置页手动改目录的校验行为保持不变。

## 边界与后续

- 更新链路：便携形态默认关闭自动更新检查与启动前强更 gate（规则、原因与验收场景见
  `auto-update.md`），升级方式为整包替换新 zip；本文“便携目录不属于更新器管理范围”
  的声明由此落实。
- Electron/Chromium 的 userData（缓存、Local Storage）仍走 `appData`，不随便携迁移——
  缓存是机器本地的，迁移无意义；如需彻底免残留可另行讨论 `ZCODE_DESKTOP_USER_DATA_DIR`。
- macOS / Linux 不适用（无"安装版 vs 便携版"二分；mac zip 与 dmg 内容一致）。
- 遥测 `dataRootKind` 维持 default/custom 二值：便携会报告为 custom。

## 验收场景

- A：便携包解压到 U 盘任意目录运行 → `<exe 目录>/.zcode` 生成，home 不再产生新数据；
- B：同机存在安装版数据 `~/.zcode` → 便携版优先读 exe 目录的配置，互不影响；
- C：安装版（NSIS）→ 卸载器存在，行为与现在完全一致（`~/.zcode`）；
- D：便携 setting.json 显式配置 `dataBaseDir` → 尊重显式配置；
- E：预设 `ZCODE_DATA_BASE_DIR` / `ZCODE_DESKTOP_HOME_DIR`（e2e/开发）→ 便携判定不介入；
- F：exe 目录不可写 → 回退 `~/.zcode` 并输出 warn；
- G：便携版 host/agent 子进程 → 通过 `ZCODE_DATA_BASE_DIR` + `ZCODE_DESKTOP_HOME_DIR`
  继承同一数据根与 settings 锚点；
- H：便携包运行前手动创建 `<exe 目录>/data` → 启动后锚点为 data 目录，
  settings / 会话 / 凭据等全部生成于 `<exe 目录>/data/.zcode`，exe 目录不再新建 `.zcode`；
- I：`data` 存在且同时预设显式环境变量 → 环境变量优先，data 目录约定不介入；
- J：`<exe 目录>/data` 是同名**文件**而非目录 → 视为未创建，维持便携默认（exe 目录锚点）；
- K：data 目录存在且其 setting.json 配置了 `dataBaseDir` → 尊重该显式配置
  （读取位置为 `<exe 目录>/data/.zcode/v2/setting.json`）。
