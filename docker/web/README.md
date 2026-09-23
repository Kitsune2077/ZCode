# ZCode Web 端容器

把 Web 端打成一个镜像：**同一个 Node 进程既托管 Web 前端，也托管 Agent 后端**，
浏览器访问该端口即可得到完整工作台。

## 背景

仓库里的 Web 端由两部分组成，`pnpm dev:web` 在开发态把它们拆成两个进程：

- `@zcode/server`：HTTP + WebSocket 服务，负责 RPC、工作区与 Agent 进程管理；
- `@zcode/web`：Vite 构建出的前端静态资源。

生产态不需要两个进程：`packages/server/src/entry-http.ts` 本来就支持
「静态资源目录 + SPA fallback」，因此容器里只跑一个 `node packages/server/dist/entry-http.js`。

## 运行时契约

| 项目     | 值                                             | 说明                                                        |
| -------- | ---------------------------------------------- | ----------------------------------------------------------- |
| 命令     | `node packages/server/dist/entry-http.js`      | `WORKDIR` 必须是仓库根 `/app`，见下方「为什么保留仓库结构」 |
| 端口     | `3030`（`PORT`）                               | `EXPOSE 3030`                                               |
| 监听地址 | `ZCODE_SERVER_HOST=0.0.0.0`                    | 容器内必须绑 `0.0.0.0`，否则端口映射不通                    |
| 静态根   | `ZCODE_WEB_STATIC_ROOT=/app/packages/web/dist` | 触发 SPA fallback，前端与后端同源                           |
| 访问令牌 | `ZCODE_SERVER_AUTH_TOKEN`                      | 设置后 `authRequired = true`；**映射到宿主机时必须设置**    |
| 数据目录 | `ZCODE_DATA_BASE_DIR=/data`                    | 实际数据落在 `/data/.zcode/v2`（配置、凭据、会话）          |
| 工作区   | `ZCODE_SERVER_WORKSPACE=/workspace`            | 默认工作区路径；也可在 Web 界面里另选                       |
| 服务名   | `ZCODE_SERVER_NAME`                            | 可选，展示用                                                |
| 接口地址 | `ZCODE_ENDPOINT_ORIGIN` / `ZCODE_BASE_URL`     | 可选；运行期优先，用于自建后端或反代（详见下文）            |
| 用户     | `node`（uid 1000）                             | 非 root                                                     |

卷：`/data`（必须持久化）、`/workspace`（要打开的项目）。

```
浏览器 ──HTTP/WS──▶ 容器 :3030
                      │
                      ├─ /             → packages/web/dist（SPA fallback）
                      ├─ /api/*、/rpc  → @zcode/server
                      └─ 拉起 Agent    → apps/zcode-cli/packages/cli/dist/zcode.cjs app-server --stdio
                                          cwd = 当前工作区
```

## 构建与运行

```bash
# 方式一：compose（推荐）
export ZCODE_SERVER_AUTH_TOKEN=$(openssl rand -hex 32)
export ZCODE_WORKSPACE=/path/to/your/project
docker compose -f docker/web/docker-compose.yml up --build
# 打开 http://127.0.0.1:3030/?token=<上面的令牌>

# 方式二：直接 build + run，注意构建上下文是仓库根目录
docker build -f docker/web/Dockerfile -t zcode-web .
docker run --rm -p 3030:3030 \
  -e ZCODE_SERVER_AUTH_TOKEN=$(openssl rand -hex 32) \
  -v zcode-data:/data \
  -v /path/to/your/project:/workspace \
  zcode-web
```

构建参数：

| 参数              | 默认                         | 说明                                                                                                        |
| ----------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NODE_IMAGE`      | `node:24.14.0-bookworm-slim` | 与 `mise.toml` 对齐；升级 Node 时同步改这里                                                                 |
| `PNPM_VERSION`    | `10.33.2`                    | 与 `mise.toml` 对齐                                                                                         |
| `ZCODE_ENV`       | `production`                 | 只烘进 server bundle 的 `__ZCODE_ENV__` 与内置 Provider 配置的环境标记，**不改接口地址**；不设置时按 `test` |
| `ELECTRON_MIRROR` | npmmirror                    | workspace 安装会顺带拉 Electron，给个镜像源避免直连 GitHub                                                  |

### 接口地址归运行期管

端点的唯一解析入口是 `resolveRuntimeZCodeEndpointOrigin()`：

```
ZCODE_BASE_URL ?? ZCODE_ENDPOINT_ORIGIN ?? https://zcode.z.ai
```

`readProductEndpointEnv()` 会把**构建期烘入值**与**运行期 process.env** 合并，**运行期优先**：

- 自建后端 / 反代时，运行期给一个 `ZCODE_ENDPOINT_ORIGIN`（或 `ZCODE_BASE_URL`）即可让前后端都改走
  该地址，**不需要重新构建**；
- 构建期不传 URL 变量时烘入值为空，默认就是生产地址，`ZCODE_ENV` 不会改变它。

## 为什么保留仓库结构（而不是只拷 dist）

`packages/services` 的 Agent resolver 用 `findUpward` 从**后端进程的 cwd** 向上找
`apps/zcode-cli/packages/cli/dist/zcode.cjs`：

```
process.cwd() 逐级向上 ──▶ /app/apps/zcode-cli/packages/cli/dist/zcode.cjs
```

找到就直接 `node zcode.cjs app-server --stdio`；找不到会退回「`tsx` + 源码」路径，
那就要求源码与 `tsx` 同时在位。因此镜像里 `WORKDIR=/app`、且必须构建 CLI 产物，
**不能**只把 `packages/server/dist` 拷进一个瘦镜像。

## 权限

容器以 uid 1000（`node`）运行，所以：

- `/data` 与 `/workspace` 在镜像里已 `chown` 到 `node`，用**命名卷**时无需额外处理；
- 用**宿主机目录**挂载 `/workspace` 时，该目录需要对 uid 1000 可写，
  否则 Agent 无法在工作区里创建/修改文件：

```bash
sudo chown -R 1000:1000 /path/to/your/project
# 或者改用 --user $(id -u):$(id -g) 运行，让容器与宿主机属主一致
```

## 与桌面版 / CLI 发行包的区别

|                                              | Web 端容器             | 桌面版                                          | CLI 发行包             |
| -------------------------------------------- | ---------------------- | ----------------------------------------------- | ---------------------- |
| 形态                                         | 单进程容器，浏览器访问 | Electron 安装包                                 | `zcode` 命令 + `--web` |
| TUI                                          | 不含                   | 不含                                            | 含                     |
| 桌面端资源（mock-cdn、bundled-tools/agents） | 不含                   | 含                                              | 视打包参数             |
| 自动更新                                     | 无关（无更新器）       | 有（见 `packages/desktop/docs/auto-update.md`） | 无                     |

## 不变量

- 前端与后端**同源同进程**，不引入第二个服务或反向代理。
- 接口地址只由 `resolveRuntimeZCodeEndpointOrigin()` 解析；`ZCODE_ENV` 不参与地址解析。
- 数据只写 `/data`（`ZCODE_DATA_BASE_DIR`），不写镜像内路径。
- 监听非本机地址时必须有访问令牌；compose 已把令牌设为必填。

## 验收场景

- A：默认构建 → 浏览器打开 `:3030` 能看到工作台，`/api/server-info` 返回 200。
- B：设置 `ZCODE_SERVER_AUTH_TOKEN` → 不带 `?token=` 访问被拒绝，带上后可用。
- C：`/data` 用命名卷 → 重启容器后 Provider 配置与会话仍在。
- D：宿主机目录挂到 `/workspace`（属主 uid 1000）→ Agent 能在该目录内读写并跑命令。
- E：运行期给 `ZCODE_ENDPOINT_ORIGIN=https://your-host` → 前后端都改走该地址，
  无需重新构建。

## 已知限制

- 镜像体积偏大：运行层保留了完整 `node_modules` 与仓库结构（Agent resolver 与
  server 的 external 依赖都需要），预计 2 GB 量级。
- 拉取依赖时 workspace 会一并安装桌面端依赖（含 Electron）；如需精简可改为
  `pnpm install --frozen-lockfile --filter "!@zcode/desktop"`，但未在 CI 验证。
- 本文件与 Dockerfile 未在本仓库 CI 中执行构建验证。
