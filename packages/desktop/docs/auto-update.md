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
- 启动条件（`index.ts:1945`）：`ZCODE_PRODUCT_FLAVOR === "production"`。
  Preview / test 身份**从不**启动该链路。
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
- 启动条件（`index.ts:2196`）：`ZCODE_PRODUCT_FLAVOR === "production"` 且 `app.isPackaged`。
- 失败容忍：读取远端配置失败时只 `warn` 并跳过（fail-open），不拦启动。

该 gate 是有意的安全边界：它拦的是"打包发布客户端跑在最低版本以下"。因此默认不因
任何环境变量而放宽；只有下面的显式开关会跳过它。

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

## 不变量

- 两条链路各自只有一个启动判定点，不新增旁路。
- 开关解析唯一所有者是 `isAutoUpdateDisabledByRuntimeSwitch()`，判定点只消费它，
  不各自读取 env / argv。
- 关闭的是"本机的更新行为"，不改变端点解析结果，也不影响登录 / 计费 / 遥测。

## 验收场景

- A：生产身份 + 打包态，未设开关 → 更新链路照常检查，必要时弹出更新提示。
- B：生产身份 + 打包态 + `ZCODE_DESKTOP_DISABLE_UPDATE=1` → 日志只有
  `[auto-update] disabled by ...`，无 `initializing / checking`；强制升级 gate 输出
  `[force-update] disabled by ...` 且不请求 `/api/v1/client/configs`。
- C：`--zcode-desktop-disable-update=0` → 等同未设置，两条链路都恢复。
- D：Preview / test 身份 → 两条链路本来就不启动，开关不改变任何行为。
