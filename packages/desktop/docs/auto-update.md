# 桌面端更新链路与关闭开关

## 背景

桌面端有两条**互相独立**的"更新"链路，都指向同一个官方端点。自建 / 私有构建既不需要
官方更新提示，也不希望由官方配置决定自己能否启动，因此提供一个显式关闭开关。

两条链路共用的端点来源（`packages/shared/src/zcodeEndpoint.ts:142`）：

```
resolveRuntimeZCodeEndpointOrigin(process.env)
  = ZCODE_BASE_URL ?? ZCODE_ENDPOINT_ORIGIN ?? https://zcode.z.ai
```

## 链路一：自动更新（可选提示）

- 实现：`manifestUpdateProvider.ts` 的自定义 `ManifestUpdateProvider`，
  由 `autoUpdater.ts` 的 `applyManifestUpdateProvider()` 通过 `setFeedURL` 装载。
- 请求：`GET {endpointOrigin}/api/v1/releases/electron/manifest?platform=&channel=&device_mid=`
- 通道：`channel=stable`；设置项 `receivePreviewUpdates === true` 时为 `preview`。
- 启动条件（`index.ts` 中 `initAutoUpdater` 调用处）：`ZCODE_PRODUCT_FLAVOR === "production"`
  且未被运行时禁用（显式开关或 Windows 便携版，见下）。Preview / test 身份**从不**启动该链路。
- `autoDownload = false`；win32 下 `autoInstallOnAppQuit = false`，下载与安装都需用户操作。

### 更新清单契约（自建渠道时需实现）

```json
{
  "version": "3.15.0",
  "files": [{ "url": "ZCode-3.15.0-win-x64.exe", "sha512": "<base64>", "size": 149000000 }],
  "path": "ZCode-3.15.0-win-x64.exe",
  "releaseDate": "2026-09-23T00:00:00.000Z"
}
```

- 文件 URL 按 `new URL(file.url, manifestUrl 的 origin)` 解析，可写相对路径。
- 每个文件必须带 `sha512`（或旧字段 `sha2`），否则抛 `Manifest file is missing checksum`。
- Windows 增量更新还需要同目录的 `.blockmap`；配置已关闭 `useMultipleRangeRequest`。

## 链路二：启动前强制升级 gate

- 实现：`forceUpdateGuard.ts` 的 `maybeBlockStartupForForceUpdate()`。
- 请求：`GET {endpointOrigin}/api/v1/client/configs?app_version=&platform=`
- 判定：`data.configs` 中的 `minimalVersion` 高于当前版本时弹窗并**阻止创建主窗口**，
  非自动升级路径处理完弹窗后 `app.quit()`。
- 启动条件（`index.ts` 中 `maybeBlockStartupForForceUpdate` 调用处）：
  `ZCODE_PRODUCT_FLAVOR === "production"` 且 `app.isPackaged`，且未被显式开关 /
  Windows 便携版跳过。
- 失败容忍：读取远端配置失败时只 `warn` 并跳过（fail-open），不拦启动。

该 gate 是有意的安全边界：它拦的是"打包发布客户端跑在最低版本以下"。因此默认不因
任何环境变量而放宽；只有下面的显式开关会跳过它。

## 自定义更新源（GitHub / Gitea Release）

设置 → 常规 → "自定义更新源"（`AppSettings.customUpdateSource`，桌面端可见）：
**默认为空 = 官方更新源**；填写 GitHub 或 Gitea 仓库地址后，自动更新改为消费该仓库的
Release。发布到自定义源的 Release 需要附带 electron-builder 通用格式的更新清单
（stable 通道 `latest.yml`，preview 通道 `beta.yml`，缺 `beta.yml` 时回退 `latest.yml`）
与对应安装包（Windows 增量更新还需同目录 `.blockmap`）。

- 输入格式：`owner/repo`（视为 GitHub）、`github.com/owner/repo`、
  `https://github.com/owner/repo`（GitHub API `api.github.com`）；
  任何其它 http(s) 主机的 `host/owner/repo` 按 Gitea 处理（API `{origin}/api/v1`）。
  尾部 `/releases` 后缀允许（仓库首页粘贴容错）。
- Release 选择：取 releases 列表（新→旧）第一个非 draft；stable 还要求非 prerelease，
  preview 允许 prerelease。GitHub/Gitea 的 releases API 响应结构按兼容字段消费
  （`tag_name` / `draft` / `prerelease` / `body` / `assets[].browser_download_url`）。
- 清单下载自所选 Release 的附件；`files[].url` 按 `new URL(url, 附件所在目录)` 解析
  （GitHub/Gitea 的附件 URL 同为 `.../releases/download/{tag}/{file}` 形态）；
  每个文件必须带 `sha512`（或旧字段 `sha2`），校验语义与官方 manifest 一致；
  Release 正文（`body`）在清单缺 `releaseNotes` 时作为更新说明回退。
- 更新说明回退链（前一级存在即不再往下）：① 清单内 `releaseNotes`/`releaseNotesByLocale`
  → ② Release 正文（`body`）→ ③ **官方 manifest 同版本说明**：按官方
  `{endpoint}/api/v1/releases/electron/manifest?platform=<platform-arch>&channel=<1|3>`
  逐通道探测（先当前通道、后另一通道，覆盖官方灰度只发 preview 的形态），仅当返回
  manifest 的 `version` 与本次更新版本**完全一致**时，才采用其 `releaseNotes` 与
  `releaseNotesByLocale`（中英双语）；版本不一致、网络失败、响应非法一律静默跳过
  （更新说明是尽力而为，绝不影响更新检查结果），结果按 `version` 进程内记忆避免
  重复请求。fork 构建版本号与上游对齐时该回退可自动带出官方更新日志。
- 生效时机：每次检查更新时读取最新设置（provider 内部分发，官方清单 provider 与
  Release feed provider 复用同一 `setFeedURL` 装载点）；保存设置后 main 立即触发
  一次重新检查，无"重启生效"要求。下载/安装中（download-progress / update-downloaded /
  quitAndInstall 锁定）不切换，检查收口后再重放。
- 边界与安全模型：允许改道是本功能的用途，完整性仍由清单内 `sha512` 校验兜底；
  自定义源的 Release 由源仓库控制方发布。`ZCODE_UPDATE_FEED_URL`（打包态被忽略的
  开发覆盖）语义不变。Windows 便携版更新整体禁用，该设置对其无效果。

## 关闭开关

```
ZCODE_DESKTOP_DISABLE_UPDATE=1
--zcode-desktop-disable-update            # 裸开关即开启，=0 可显式关闭
```

- 取值语义与仓库其它开关一致：env 取 `1` / `true` / `yes`；开关裸写为开。
- 生效范围（两条一起关）：
  1. 不启动自动更新检查；
  2. 跳过启动前的强制升级 gate。
- **打包态同样生效**。`ZCODE_UPDATE_FEED_URL` 反之：它在 `app.isPackaged` 时被显式忽略
  （`autoUpdater.ts:708`），因为那是一个"把更新请求改道到别处"的入口；本开关只是让本机
  不再检查 / 不再接受远端更新决策，请求不会发往别处，没有同样的改道风险。
- 未设置时行为完全不变。

## 便携版（Windows zip）默认禁用

Windows 便携包（`win-unpacked` 内容的 zip，判定规则见 `docs/portable-data-dir.md`）
**默认关闭上述两条链路**，与显式开关同一组判定点生效：

- 判定唯一所有者是 `resolvePortableAppHomeDir()`（`desktopPortableHome.ts`）：
  win32 + 打包态 + exe 同目录无 `Uninstall*.exe`。更新判定点只消费该结果；
  即使便携目录不可写（数据目录已回退主目录），应用二进制仍是便携形态，禁用不变。
- 原因：应用内更新在 Windows 上只会下载并运行 NSIS 安装器，会把便携用户带进
  “装出一份安装版、数据目录分家”的流程；强更 gate 同样会把用户推向这条路径。
  便携版的升级方式是整包替换新 zip。`docs/portable-data-dir.md` 中
  “便携目录不属于更新器管理范围”的声明由本规则落实。
- 除两条链路一起关之外，便携 / 开关禁用时还有三条边界：
  1. 跳过 `hydratePendingPostUpdateReleaseNotes`，不恢复旧便携构建遗留的
     “已下载待安装”状态，避免复活一个不可用的安装入口；
  2. `refreshAutoUpdaterReleaseChannel` 在更新器禁用时直接跳过：设置页切换
     stable / preview 通道不再向未配置的占位 feed 发检查请求（该闸同时覆盖
     Preview 身份与显式开关，属既有缺口的收敛）；
  3. 禁用初始化时把更新菜单状态置为 `idle / enabled:false`，Windows 自绘
     Help 菜单的“检查更新”置灰；托盘菜单条目仍可见（模板只按产品身份裁剪），
     点击后走 `checkForUpdateMenuClick` 的 fail-closed 分支回 `dev-skipped` toast。
- 安装版（NSIS，带卸载器）与非 Windows 平台不受影响。

## 不变量

- 两条链路各自只有一个启动判定点，不新增旁路。
- 开关解析唯一所有者是 `isAutoUpdateDisabledByRuntimeSwitch()`，判定点只消费它，
  不各自读取 env / argv。
- 便携判定不引入第二条判据或新的旁路入口；所有更新入口（自绘菜单、托盘、
  设置页通道切换）都收敛到上述既有判定点。
- 关闭的是“本机的更新行为”，不改变端点解析结果，也不影响登录 / 计费 / 遥测。

## 验收场景

- A：生产身份 + 打包态，未设开关 → 更新链路照常检查，必要时弹出更新提示。
- B：生产身份 + 打包态 + `ZCODE_DESKTOP_DISABLE_UPDATE=1` → 日志只有
  `[auto-update] disabled by ...`，无 `initializing / checking`；强制升级 gate 输出
  `[force-update] disabled by ...` 且不请求 `/api/v1/client/configs`。
- C：`--zcode-desktop-disable-update=0` → 等同未设置，两条链路都恢复。
- D：Preview / test 身份 → 两条链路本来就不启动，开关不改变任何行为。
- E：生产身份 + Windows 便携包（exe 同目录无 `Uninstall*.exe`）→ 日志出现便携
  禁用记录，无 `initializing / checking`，不请求 manifest；强更 gate 跳过且不请求
  `/api/v1/client/configs`；Help 菜单“检查更新”置灰；设置页切换 stable / preview
  通道不触发检查；托盘点击只弹“当前运行环境不检查更新”。
- F：生产身份 + NSIS 安装版（带卸载器）→ 行为与 A 完全一致，便携判定不介入。
- G：自定义源 Release 无正文且清单无 `releaseNotes`，官方 manifest 当前通道返回同版本
  → 更新说明取自官方 manifest（含 `releaseNotesByLocale` 双语），检查结果不受影响。
- H：官方 manifest 两通道的 `version` 均与本次更新版本不一致（例如官方灰度未发）→
  更新说明为空，检查/下载流程照常，无报错日志刷屏。
- I：官方 manifest 请求失败（离线 / 5xx / 非 YAML）→ 同 H，静默跳过且按版本记忆，
  同版本后续检查不再重复请求。
