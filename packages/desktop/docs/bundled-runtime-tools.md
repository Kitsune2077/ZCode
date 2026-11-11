# 随包内置的运行时工具（runtime tools）

## 背景

插件 `lark-cli`（飞书 CLI）的 `skills/setup` 第一步是 `command -v lark-cli`，缺失时才引导
`npm install -g @larksuite/cli`。这条路径要求用户机器上先有 Node.js/npm。

而上游 `@larksuite/cli` 的 npm 包只是转发壳（`scripts/run.js` → `bin/lark-cli[.exe]`），
真正实现由 GitHub Release 以**原生单文件**分发（`lark-cli.exe`，约 47 MB，MIT）。
把这份原生二进制随包内置后，`command -v lark-cli` 直接命中内置副本，`setup` 自动跳过 npm 安装，
用户**无需预装 Node.js**。

后续随包工具按同一机制扩展（见下方各工具小节）：`dsoffice`（Office 转换引擎）的动机不同——
它解决的是公司内网无外网时四个文档插件的转换/渲染/公式重算完全不可用的问题。

## 机制（谁负责什么）

| 环节 | 所有者 | 说明 |
| --- | --- | --- |
| 取得二进制 | `scripts/prepare-bundled-lark-cli.mjs`（`prepare:lark-cli`） | 解析 npm latest → 取该版本 npm 包内 `checksums.txt` → 下载并校验 → 落到 `packages/desktop/bundled-tools/<platform-key>/lark-cli/lark-cli[.exe]` |
| 打进安装包 | `packages/desktop/electron-builder.config.js` extraResources | `bundled-tools/<key>/lark-cli` → `resources/tools/lark-cli` |
| 运行时解析 | `packages/services/src/runtime-tools/runtimeToolResolver.ts` | 通用解析器：先看 `env[binaryEnvVar]`，再按 `resources/tools/<dir>/<entry>` 查找；命中后写入环境变量并把目录**追加进 PATH** |
| 工具注册 | `packages/shared/src/runtime-tool-runtime.ts` | `RuntimeToolId` 新增 `"lark-cli"`；`binaryEnvVar: "ZCODE_LARK_CLI_BINARY"`（与 desktop 既有注入同名） |
| 注入 Agent 环境 | `packages/services/src/runtime-tools/runtimeCommandEnv.ts` | `buildRuntimeToolEnvPatch(["bfs","lark-cli","ripgrep","ugrep"], …)` |
| 桌面侧预解析 | `packages/desktop/src/main/desktopRuntimeEnv.ts` | 早已按同一环境变量注入 bundled 路径（`:393`），本次只是补上消费方 |

```
构建期: prepare:lark-cli ──▶ bundled-tools/<key>/lark-cli/{lark-cli[.exe], LICENSE, lark-cli-bundle.json}
                                    │ electron-builder extraResources
                                    ▼
运行期: resources/tools/lark-cli/ ──▶ runtimeToolResolver ──▶ ZCODE_LARK_CLI_BINARY
                                                          └─▶ PATH 追加该目录
                                                                    ▼
                                              插件 skills/setup: `command -v lark-cli` 命中 → 跳过 npm
```

## 供应链

- **版本跟随 npm latest**（`@larksuite/cli/latest`）。可用 `ZCODE_LARK_CLI_VERSION` 钉死某个版本。
- **摘要来自官方**：期望 sha256 读自该版本 npm 包内的 `checksums.txt`（上游随包发布），
  与下载到的 release 归档逐字节比对，不一致即构建失败。校验和不自算——自算只能证明"下载完整"，
  不能证明"就是上游发布物"。
- 下载源：npmmirror binary 镜像优先（与上游 `install.js` 策略一致），GitHub Release 兜底。
- 记录：`bundled-tools/<key>/lark-cli/lark-cli-bundle.json` 保存 `version` / `archiveName` /
  `archiveSha256` / `binarySha256` / `sourceUrl`，供追溯与幂等判断。
- **许可**：MIT（Copyright (c) 2026 Lark Technologies Pte. Ltd.）。上游 `LICENSE` 随二进制复制到
  工具目录，因此安装包内 `resources/tools/lark-cli/LICENSE` 保留原始署名。
- 幂等：同版本且二进制摘要一致时跳过；摘要不符则重新准备（[repair]）。

## 开关

| 变量 | 作用 |
| --- | --- |
| `ZCODE_SKIP_LARK_CLI=1` | 跳过该步骤（离线构建）。`prepare-runtime-assets.mjs` 据此不排入该步骤；electron-builder 侧用存在性判断，缺资产时包内不带该工具，不让打包整体失败 |
| `ZCODE_LARK_CLI_VERSION=<x.y.z>` | 钉死版本，替代 latest |

## 不变量

- 只有 `prepare-bundled-lark-cli.mjs` 一处写入 `bundled-tools/*/lark-cli`。
- 进入安装包的二进制必须是**通过官方 checksums.txt 校验**的那一份；校验失败不允许继续。
- 内置工具的暴露方式沿用既有 runtime tool 机制（环境变量 + PATH 追加），不为 lark-cli 另开路径。
- 插件内容保持与官方 artifact 逐字节一致——本次不需要改插件，靠 PATH 命中即可。

## 验收场景

- A：`pnpm bundle:desktop -- --os win --arch x64` → 日志出现 `[prepare:agent-bundle]` 之外的
  `prepare:lark-cli` 计时，且 `bundled-tools/<key>/lark-cli/lark-cli.exe` 存在。
- B：安装后的应用目录存在 `resources/tools/lark-cli/lark-cli.exe` 与 `LICENSE`。
- C：Agent 环境里 `ZCODE_LARK_CLI_BINARY` 指向该文件，且 PATH 含其目录；
  在**未安装 Node.js** 的机器上 `lark-cli --version` 返回版本号。
- D：`ZCODE_SKIP_LARK_CLI=1` 打包 → 包内不含该工具，打包不失败，插件回落到 npm 引导路径。

## 已知缺口（未完成，需后续处理）

1. **第三方声明未生成**：`THIRD-PARTY-NOTICES.md` 由 `node scripts/licenses.mjs notices` 从
   `third-party/inventory.json` 生成，而该 inventory 目前只覆盖 npm 生产依赖图、仓库内复制的源码/
   素材与 native-search 工具，**不包含构建期下载的组件**。lark-cli 属于新类别，需要在生成器里
   增加一类才能进声明。当前替代措施是许可文本随二进制进包 + 构建元数据记录来源与摘要。
2. **其它发行面未包含**：`packages/zcode-server-cli/src/packaging/stage.ts` 的 CLI 发行包
   工具清单、`apps/zcode-cli/packages/cli/src/sea-runtime-tools.ts` 的 SEA 工具集都是显式列表，
   本次未加入 lark-cli（不影响桌面安装包，属独立发行面）。
3. **体积**：`lark-cli.exe` 未压缩约 47 MB，安装包从 142 MB 增至约 190 MB。

---

## dsoffice（Office 转换引擎）

### 背景

四个文档插件（documents/presentations/spreadsheets/pdf）的转换（`.doc`→`.docx`、Office→PDF）、
渲染视觉验证与 xlsx 公式重算都依赖 LibreOffice。此前 skill 要求模型**运行时**从清华镜像/winget
现场下载几百 MB 安装，公司内网无外网时整条质量验证闭环断裂（且受管终端的安装器拦截进一步放大
失败面）。参照 DeepSeek Harness 桌面版的做法，把上游 `@deepseek-ai/libreoffice-kit`
（[dsh-libreoffice-kit](https://github.com/deepseek-ai/dsh-libreoffice-kit)，MPL-2.0）预编译
引擎随包内置，运行时零下载；skill 文案同步改写为引擎解析降级链（见 `docs/document-skills-plugin.md`
→ "依赖边界"）。

### 机制

| 环节 | 所有者 | 说明 |
| --- | --- | --- |
| 取得引擎闭包 | `scripts/prepare-bundled-libreoffice-kit.mjs`（`prepare:libreoffice-kit`） | 钉死版本 `npm install --ignore-scripts --omit=dev` 到 `bundled-tools/<key>/libreoffice-kit/runtime/node_modules/`（kit + 平台引擎 + koffi 闭包），并生成 `dsoffice`/`dsoffice.cmd` shim 与 bundle 元数据 |
| 打进安装包 | `packages/desktop/electron-builder.config.js` extraResources | `bundled-tools/<key>/libreoffice-kit` → `resources/tools/libreoffice-kit`（existsSync 条件，缺资产不让打包失败）。`runtime/node_modules` 故意嵌套一层子目录——electron-builder 会过滤 extraResources from 根目录的 node_modules（koffi/sharp staging 实证） |
| 运行时解析 | `packages/services/src/runtime-tools/runtimeToolResolver.ts` | 工具 id `"dsoffice"`：`ZCODE_DSOFFICE_BINARY` → `resources/tools/libreoffice-kit/dsoffice.cmd|dsoffice` → PATH 兜底；命中后把该目录追加进 Agent PATH，skill 的 `command -v dsoffice` 即命中 |
| 桌面侧预解析 | `packages/desktop/src/main/desktopRuntimeEnv.ts` | 注入 `ZCODE_DSOFFICE_BINARY`（shim 路径）与 `ZCODE_DSOFFICE_NODE_EXE`（app 自身 Electron 二进制，shim 用 `ELECTRON_RUN_AS_NODE` 复用它跑 kit 的 `lib/cli.js`，与 Host 执行 zcode.cjs 同一模式；Electron 44 = Node 24.21，满足 kit 的 `>=22.19.0`） |

```
构建期: prepare:libreoffice-kit ─▶ bundled-tools/<key>/libreoffice-kit/{dsoffice[.cmd], runtime/node_modules/…}
                                       │ electron-builder extraResources
                                       ▼
运行期: resources/tools/libreoffice-kit/ ─▶ runtimeToolResolver ─▶ ZCODE_DSOFFICE_BINARY / ZCODE_DSOFFICE_NODE_EXE
                                                              └─▶ PATH 追加该目录
                                                                        ▼
                            文档插件 skills / xlsx.py / pdf.py: `command -v dsoffice` 命中
                            dsoffice convert|render|recalculate（本地 soffice 兜底，见 skill 降级链）
```

### 供应链

- **版本钉死** `@deepseek-ai/libreoffice-kit@0.2.3`（`ZCODE_LIBREOFFICE_KIT_VERSION` 可覆盖）。
  引擎是 199MB 级二进制，逐版本人工冒烟（convert/recalculate/render 各一例）后再升版。
- **完整性**：npm 安装即按 registry `dist.integrity` sha512 校验每个 tarball；`--ignore-scripts`
  下不执行任何包脚本——原生引擎路径只 spawn 引擎包自带的 helper exe，koffi 的预编译 `.node`
  来自 registry 托管的 `@koromix/koffi-<platform>` 平台包（koffi 3.x loader 优先从兄弟包解析），
  不依赖 install 脚本联网下载。
- **registry 顺序**：`npm_config_registry` → npmjs.org → npmmirror.com（内网/国内构建可配镜像）。
- **许可**：MPL-2.0。引擎包自带 `sources/` 与 `licenses/`（上游按 MPL 要求随包发布），**未裁剪**；
  bundle 元数据 `libreoffice-kit-bundle.json` 记录 kit/engine/koffi 版本、registry 与上游仓库。
- **平台**：win32-x64、darwin-x64、darwin-arm64 有原生引擎；Linux 上游走 wasm 包（152MB），
  本仓库暂不 staging——脚本明确跳过并留日志，skill 走降级链。

### 开关

| 变量 | 作用 |
| --- | --- |
| `ZCODE_SKIP_LIBREOFFICE_KIT=1` | 跳过该步骤（离线构建）。缺资产时包内不带引擎，四个文档插件走 skill 降级链 |
| `ZCODE_LIBREOFFICE_KIT_VERSION=<x.y.z>` | 钉死版本，替代内置默认值 |

### 验收场景

- A：`node scripts/prepare-bundled-libreoffice-kit.mjs` → `bundled-tools/<key>/libreoffice-kit/`
  出现 shim 与 `runtime/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/prebuilds.json`。
- B：shim 冒烟——`dsoffice convert --input report.docx --output report.pdf` 返回 JSON
  `{"backend":"native",...}` 且 PDF 以 `%PDF-` 开头；`dsoffice recalculate` 与
  `dsoffice render --pages 1`（分页 PNG + manifest）同通过。
- C：安装后的应用目录存在 `resources/tools/libreoffice-kit/dsoffice.cmd`；Agent 环境里
  `ZCODE_DSOFFICE_BINARY` 指向它且 PATH 含其目录；`command -v dsoffice` 命中内置副本。
- D：`ZCODE_SKIP_LIBREOFFICE_KIT=1` 打包 → 包内不含引擎、打包不失败，skill 降级链生效。
- E：幂等——同版本二次执行直接 `[skip]`；删除部分产物后执行走 `[repair]` 重装。

### 体积

引擎解包约 192 MB（win32-x64，含 MPL sources/licenses），安装包压缩后预计 +60~90 MB。
升级 lark-cli 时安装包从 142→190 MB；dsoffice 后预计 250~280 MB 量级，DMG 预算（3200m）足够。

---

## python（Office 创作环境）

### 背景

四个文档插件的创作脚本依赖 `python3` 与一批 pip 包（python-docx / python-pptx / openpyxl 等）。
此前只靠系统 Python：公司内网无外网时 pip 装不了包，创建/编辑/校验链路直接断。参照
DeepSeek Harness 的"锁定运行时 + 锁定库 + 校验 + 可离线预置"思路，把 CPython 与库随包分发，
运行时零下载。与 dsoffice 的分工：**dsoffice 负责转换/渲染/公式重算，python 负责创作与解析**。

### 机制

| 环节 | 所有者 | 说明 |
| --- | --- | --- |
| 取得运行时 | `scripts/prepare-bundled-python.mjs`（`prepare:python`） | 按 `scripts/python-runtime-lock.json` 下载 python-build-standalone 的 `install_only` 归档（校验 sha256）→ 解到 `bundled-tools/<key>/python/runtime`；再用内置 pip 从 PyPI 下载锁定 wheel（`--require-hashes`）、逐字节复核后 `--no-deps` 安装到 site-packages |
| shim | 同上 | 工具根产出 `python3`（sh，0755）与 `python3.cmd`：清 `PYTHONHOME`/`PYTHONPATH`、`PYTHONNOUSERSITE=1`，不覆盖 ZCode 注入的 `PYTHONUTF8`；Windows 的 CPython 没有 `python3.exe`，Git Bash 又不解析 `.cmd`，因此两个入口必须成对 |
| 打进安装包 | `electron-builder.config.js` extraResources | `bundled-tools/<key>/python` → `resources/tools/python`（existsSync 条件） |
| 运行时解析 | `packages/services/src/runtime-tools/runtimeToolResolver.ts` | 工具 id `"python"`：`ZCODE_PYTHON_BINARY` → `resources/tools/python/python3[.cmd]` → PATH 兜底；命中后把工具根追加进 Agent PATH |
| 桌面侧注入 | `packages/desktop/src/main/desktopRuntimeEnv.ts` | 提前解析并注入 `ZCODE_PYTHON_BINARY`（Preview/生产不必猜路径） |
| 消费方 | 四个插件的 `env_check.sh` / `setup.sh` | 裸 `command -v python3` 与 `python3 -c "import openpyxl"` 命中内置副本；PATH 为**追加**语义，用户自带 python3 优先 |

### 供应链

- **CPython**：python-build-standalone（PSF-2.0），release / 资产名 / sha256 钉死在
  `scripts/python-runtime-lock.json`；当前 `3.12.16`（release `20261110`）。
- **wheel**：包名 + 版本 + 每平台 sha256 全部锁定（含传递依赖，约 20~22 个/平台）；
  `pip download --require-hashes` 下载后逐字节复核，`pip install --no-deps` 安装锁定文件，
  不做运行时版本解析。
- **排除 PyMuPDF（AGPL-3.0）**：PDF 页面渲染由 `dsoffice render` 承担；pdf skill 的
  `fitz` 检查为 optional。
- **许可**：CPython 与各 wheel 的许可原文随包放在 `resources/tools/python/licenses/`；
  仓库级声明登记在 `third-party/runtime/sources.json`（生成器逐字节校验并写入 notices）。

### 开关

| 变量 | 作用 |
| --- | --- |
| `ZCODE_SKIP_PYTHON=1` | 跳过该步骤（离线构建）。缺环境时 skill 回落系统 `python3` |
| `ZCODE_PYTHON_VERSION`（预留） | 版本由 lock 文件决定；升级需同时更新 lock 与 sha256 |

### 验收场景

- A：`node scripts/prepare-bundled-python.mjs` → `bundled-tools/<key>/python/` 出现
  `python3`/`python3.cmd`、`runtime/`、`licenses/`、`python-runtime-bundle.json`。
- B：Git Bash 中 `command -v python3` 命中工具根 shim；cmd/PowerShell 命中 `.cmd`；
  `python3 -c "import sys; print(sys.prefix)"` 指向 `resources/tools/python/runtime`。
- C：仅内置解释器在 PATH 时，docx/xlsx/pdf 三个 `env_check.sh` 退出码为 0。
- D：`ZCODE_SKIP_PYTHON=1` 打包 → 包内不含 python、打包不失败，skill 回落系统 Python。
- E：幂等——同版本二次执行 `[skip]`；删元数据后 `[repair]`。

### 体积

win32-x64 解包约 135 MB（CPython 裁剪 test/idlelib/tkinter/tcl/include/libs 后 + 20 个 wheel），
压缩后预计 +40~55 MB。安装包在 dsoffice 的约 280 MB 基础上预计到 320~340 MB 量级，
`audit-bundle-size` 单产物 500 MB 上限仍有余量（以 CI 实测为准）。
