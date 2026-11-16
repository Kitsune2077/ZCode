# 第三方运行时：zusage 用量悬浮条（vendored）

> 本目录是**第三方代码**，不是本仓库自有实现。上游：
> <https://github.com/ByteRax/zcode-token-usage-statusbar>（MIT，作者 xhwxt/ByteRax）。

## 为什么 vendor 而不是运行时安装

上游提供的集成分两部分：

1. **标准插件能力**（`token_usage` MCP 工具、`/usage` 命令、技能，读本地 usage 数据库）——
   走正常插件安装即可，无需本目录。
2. **悬浮状态条**——上游要求 **修改 ZCode 程序文件 `app.asar`**：在 `out/main/index.js`
   尾部追加一行 `import("file:///.../inject-main.cjs")`，由 `inject-main.cjs`（主进程侧）
   注入 `overlay.js`（渲染层 IIFE）画出悬浮条。

第 2 部分没有"安装插件"的等价路径（ZCode 插件 UI 没有常驻悬浮条这个能力位），因此本仓库把
上游 runtime 整组 vendor 进来，在**构建期**完成 asar 注入，让产物开箱即带悬浮条、用户无需
运行上游的 `install.py`（也就不需要 Python、不需要写权限、不需要重启两次）。

## 版本与升级

- 当前版本见 `VERSION.json`（`pluginVersion` + `upstreamCommit` + 逐文件 `sha256`）。
- 升级步骤：把上游仓库对应 commit 的 runtime 文件整组替换到 `runtime/`，然后重算 `VERSION.json`
  的 `files`（`sha256` + `bytes`），跑一次桌面打包 + 启动冒烟。
- **不要只替换 `inject-main.cjs`**：它与 `overlay.js`/`plugin-*.cjs`/`*.py` 是同一版本对，
  混版会在运行时抛错或静默缺失面板。

## 刻意不启用的部分：engine patch

上游还提供 `engine-patch.cjs`（调整自动压缩上下文比例），其锚点是**按上游引擎版本硬编码的
混淆标识符**（`iTe`/`oTe`/`nTe`… 这类压缩后的局部函数名），注释也写明"到新版本时必须同步改"。
本仓库的桌面 agent bundle 含 fork 定制，与官方产物不同，锚点大概率失配。

因此本仓库**只做 asar 注入，不跑 engine patch**：悬浮条本身不依赖它，代价是"自动压缩比例
调整"这一项增强不可用。`runtime/` 里保留 `engine-patch.cjs` 只是因为它在上游 runtime 的必要
文件组里，构建期不会执行它（`inject-main.cjs` 的 `enginePatcher` 是可选分支，失败仅状态为 null）。

## 注入契约（构建期，`scripts/inject-zusage-overlay.mjs`）

- 目标：`app.asar` 内的 `out/main/index.js`（ESM 入口）。
- 注入行追加在文件末尾，**幂等**：先剥离任何既有 `inject-main.cjs` 注入行再加。
- 注入行用 `process.resourcesPath` **动态定位** loader，绝不写死构建机路径：

  ```js
  ;(()=>{const p=process.resourcesPath.replace(/\\/g,"/");const h=p.startsWith("/")?"file://"+p:"file:///"+p;return import(h+"\/zusage\/inject-main.cjs")})().then(()=>null,e=>console.error("[zusage] load failed",e));
  ```

- 运行时目录：`packages/desktop/third-party/zusage/runtime/` → 产物 `resources/zusage/`。
- **fail-open**：注入失败（入口缺失/结构变化）时构建**失败**（早暴露），但注入行自身对加载
  失败只 `console.error`，不会阻断应用启动。

## 与 fork 原生移植的关系

本仓库此前把该插件的速率/用量 UI 原生移植进 `packages/ui`（`V4ComposerUsageStatusBar`、
`AssistantReplyUsageLine`、`usageStatusBarModel`）。启用本 overlay 后两者会重复展示，
原生移植需要下线——该清理单独进行（见 `docs/fork-maintenance.md` 的定制清单）。
