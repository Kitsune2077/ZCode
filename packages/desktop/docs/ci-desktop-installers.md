# CI：构建并发布桌面安装包

`.github/workflows/build-desktop.yml`

## 动机

本地打一个平台的包要 20 分钟，而且 Windows / macOS / Linux 各有原生工具链
（NSIS / hdiutil+codesign / rpm+pacman），一台机器做不了全矩阵。交给 CI 之后：

- **可追溯**：产物、版本、commit、内置飞书 CLI 的来源与摘要都进 Release 说明；
- **更快**：pnpm store 与 Electron / electron-builder 二进制缓存跨运行复用；
- **多平台**：矩阵并行，单平台失败不拖垮其它平台。

## 触发

| 方式                                   | 行为                                                     |
| -------------------------------------- | -------------------------------------------------------- |
| 推送 `v*` tag                          | 构建全矩阵，并为该 tag 创建/更新 Release                 |
| `workflow_dispatch` + `release_tag`    | 同上，发布到指定 tag（tag 不存在则基于当前 commit 创建） |
| `workflow_dispatch` 不带 `release_tag` | 只产出 workflow artifacts，不建 Release                  |

手动输入：

| 输入                    | 默认  | 作用                                         |
| ----------------------- | ----- | -------------------------------------------- |
| `release_tag`           | 空    | 发布目标 tag；留空则只产出 artifacts         |
| `lark_cli_version`      | 空    | 钉死内置飞书 CLI 版本；留空跟随 npm latest   |
| `include_remote_assets` | false | 是否一并构建远端工作区预编译资源（mock-cdn） |

## 矩阵与产物目标

| runner              | 目标        | 产物                                                                   |
| ------------------- | ----------- | ---------------------------------------------------------------------- |
| `windows-latest`    | win / x64   | NSIS 安装包 `.exe` + **便携 ZIP**（解压即用，内容等同 `win-unpacked`） |
| `macos-14`（arm64） | mac / arm64 | `.dmg` + `.zip`                                                        |
| `ubuntu-22.04`      | linux / x64 | `.AppImage`（便携）+ `.deb` + `.rpm` + `.pkg.tar.zst`（pacman）        |

产物目标由 `packages/desktop/electron-builder.config.js` 决定，矩阵只选择平台与架构。
Intel macOS 需要 `macos-13`，workflow 里保留了注释掉的条目。

### 便携 ZIP

Windows 的 `zip` target 与 `nsis` 并列输出，zip 内就是 `win-unpacked` 那棵目录树
（`ZCode.exe` + `resources/`）：解压到任意位置双击 `ZCode.exe` 即可运行，不需要管理员权限、
不写注册表；应用数据仍保存在用户目录的 `.zcode` 下，因此与安装版共享同一份配置。
体积与安装包接近（都约 150 MB 量级），Release 说明里用「形态」列区分两者。

加入第二个产物不影响既有打包流程：`bundle.mjs` 的 `findBuiltArtifact` 只认
`artifactExtensionsByOs`（win 为 `[".exe"]`），体积审计仍固定审计 NSIS 安装包。

`scripts/ci/desktop-release-info.mjs` 把 win 的 `.zip` 也视为主产物，并按扩展名标注「形态」，
因此 Release 说明会同时列出安装包与便携包。

## 构建期环境

| 变量                       | 值           | 说明                                                                                                       |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `ZCODE_ENV`                | `production` | 决定产物版本身份与内置 Provider 配置环境；不设时仓库按 `test` 处理                                         |
| `ELECTRON_MIRROR`          | npmmirror    | 与 `mise.toml` 的 env 段一致，避免直连 GitHub 拉 Electron                                                  |
| `ZCODE_SKIP_REMOTE_ASSETS` | 平台相关     | Windows 默认 `1`（runner 缺 xz，`.tar.xz` 解包会失败）；mac/linux 默认 `0`；`include_remote_assets` 可覆盖 |
| `ZCODE_LARK_CLI_VERSION`   | 来自输入     | 透传给 `prepare-bundled-lark-cli.mjs`                                                                      |
| `HUSKY`                    | `0`          | 跳过 git hook 安装                                                                                         |

表达式用了 `"1"` / `"0"` 两个非空字符串而不是空串：GitHub 表达式里空串为假值，
`a && '' || b` 会落到 `b`，是常见陷阱。

## 缓存

- pnpm store：`actions/setup-node` 的 `cache: pnpm`；
- Electron runtime 与 electron-builder 辅助二进制（NSIS / winCodeSign / appimage 工具）：
  `actions/cache`，key 按 `runner.os` + `pnpm-lock.yaml` 哈希，跨提交可复用；
- 未缓存 `prepare:runtime-assets` 的中间产物（`bundled-agents` / `bundled-tools`）：
  它们是构建产物，缓存会带来陈旧风险；`prepare:lark-cli` 自身有版本+摘要幂等，命中即跳过下载。

## 可追溯性

每个矩阵 job 跑 `scripts/ci/desktop-release-info.mjs collect`，产出一份
`build-info-<os>-<arch>.json`，内含：版本、commit、平台/架构、
每个产物的 sha256 与大小、内置飞书 CLI 的版本与来源 URL 与归档摘要、是否包含远端资源。

Release job 用 `render` 汇总成说明正文（平台/架构/产物/大小/SHA256 表格 + 说明段落），
并把安装包与 `.blockmap` 一起挂到 Release（blockmap 供 electron-updater 增量更新）。

跨平台逻辑刻意放在 Node 脚本里而不是 workflow 的 shell 步骤：三种 runner 跑同一份代码，
且**能在本地用真实 dist 目录验证**——workflow 本身在仓库里无法执行验证。

## 验证状况

- 已本地实测：`collect`（识别主产物与 blockmap、计算 sha256、读取飞书 CLI 来源）、
  `render`（表格与说明生成）、workflow YAML 可被 `yaml` 解析且矩阵/env/步骤结构正确。
- **未实测**：workflow 本身没有在 GitHub Actions 上跑过。最可能的失败点，按概率排序：
  1. Linux 的 `rpm` / `pacman` 目标：已安装 `rpm`、`fakeroot`、`libarchive-tools`，但上游工具链要求可能更多；
     若仍失败，可考虑把这两个目标改为按需构建（需要改 electron-builder 配置，属产品决策）。
  2. `pnpm install --frozen-lockfile`：本地通过，若 lockfile 与 manifest 漂移会失败。
  3. macOS 未签名产物的首次打开提示（预期行为，不是失败）。
  4. Windows job：`prepare:native-search` 依赖随仓库分发的归档，缺失会失败（本地已验证存在）。
- 首次跑之前建议先手动 `workflow_dispatch` 且**不填** `release_tag`，确认三个平台都出产物后再发布。

## 后续可扩展

- Intel macOS（`macos-13`）与 Windows arm64 / Linux arm64 加入矩阵；
- 追加一个 `verify` job 跑 `pnpm typecheck` / `pnpm lint` / `architecture:check`，把构建与门禁分开；
- CLI 发行包（`pnpm build:zcode`，需要 `ZCODE_DIST_BASE_URL`）另建 workflow；
- macOS 签名与公证（`ZCODE_ENABLE_MAC_SIGN=1` + 证书 secrets），以及 Windows 代码签名。
