# syntax=docker/dockerfile:1
#
# ZCode Web 端容器镜像：同一个进程同时托管 Web 前端与 Agent 后端。
#
# 构建上下文必须是仓库根目录（根 .dockerignore 已经排掉 node_modules、dist、桌面端资源等）：
#   docker build -f docker/web/Dockerfile -t zcode-web .
#
# 端口、卷与访问令牌的说明见 docker/web/README.md。

ARG NODE_IMAGE=node:24.14.0-bookworm-slim

# ---------------------------------------------------------------------------
# 构建阶段
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

# 版本对齐 mise.toml：node 24.14.0 / pnpm 10.33.2。
# 这里用 npm 装 pnpm，不用 corepack —— corepack 会把 pnpm shim 塞进 Node 安装目录，
# 与 mise 共存时会互相覆盖。
ARG PNPM_VERSION=10.33.2
# 构建期后端环境：烘进 server bundle 的 __ZCODE_ENV__，并决定随包发布的内置 Provider 配置
# 使用哪一份环境标记。它**不决定接口地址** —— 地址来自 ZCODE_ENDPOINT_ORIGIN / ZCODE_BASE_URL
# （运行期 env 优先于构建期烘入值），都没有时用仓库默认的生产地址。
# 默认 production；不设置时仓库按 test 处理（见 scripts/builtin-provider-config.mjs）。
ARG ZCODE_ENV=production
# workspace 安装阶段会拉取 Electron（本镜像不使用桌面端，但它在同一个 workspace 里）。
# 默认给仓库 mise.toml 里的镜像源，避免直连 GitHub 拉 142MB。
ARG ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

ENV HUSKY=0 \
    CI=1 \
    PNPM_HOME=/pnpm \
    ELECTRON_MIRROR=${ELECTRON_MIRROR} \
    ZCODE_ENV=${ZCODE_ENV}

# python3/make/g++ 给 node-pty、cpu-features 这类原生模块的构建脚本用；
# xz-utils 给归档解包用（Debian 的 tar 需要外部 xz 才能解 .tar.xz）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        g++ \
        make \
        python3 \
        xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@${PNPM_VERSION} \
    && pnpm config set store-dir /pnpm-store

WORKDIR /app

# .dockerignore 会过滤 node_modules / **/dist / .git 等，这里直接整棵拷进来。
# 代价是任何源码改动都会让依赖层失效；镜像构建时间主要花在 install 与下面三次 build 上。
COPY . .

RUN pnpm install --frozen-lockfile

# Agent/CLI 包：后端是以自身 cwd 向上查找 apps/zcode-cli/packages/cli/dist/zcode.cjs
# 来拉起 Agent 的（packages/services 的 zcode-agent resolver），所以这个产物必须存在，
# 否则会退化成“用 tsx 跑源码”的路径并连带要求源码与 tsx 都在位。
RUN pnpm --dir apps/zcode-cli build

# 后端需要它的 workspace 依赖（services / provider / shared / rpc ...）。
RUN pnpm --filter "@zcode/server..." build

# Web 前端（含 @zcode/ui 等依赖）。
RUN pnpm --filter "@zcode/web..." build

# 清掉只对构建有意义的中间产物，减小运行层体积。
RUN rm -rf apps/zcode-cli/.turbo \
    && find . -name '*.tsbuildinfo' -type f -delete

# ---------------------------------------------------------------------------
# 运行阶段
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini 负责 PID 1 的信号转发与僵尸进程回收（后端会拉起 Agent 子进程）；
# git / openssh-client / ripgrep 是 Agent 在工作区里干活要用的。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        openssh-client \
        ripgrep \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 整棵 /app 都带过来：Agent 的 resolver 依赖仓库目录结构，server 运行期也还需要
# node_modules 里的外部依赖（tsup 只打包业务代码，node-pty / ssh2 等保持 external）。
COPY --from=builder /app /app

ENV NODE_ENV=production \
    PORT=3030 \
    ZCODE_SERVER_HOST=0.0.0.0 \
    ZCODE_WEB_STATIC_ROOT=/app/packages/web/dist \
    ZCODE_DATA_BASE_DIR=/data \
    ZCODE_SERVER_WORKSPACE=/workspace

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace

VOLUME ["/data", "/workspace"]
EXPOSE 3030

# 以非 root 运行。挂载进来的工作区目录需要 uid 1000 可写，
# 否则 Agent 无法在工作区里创建文件（见 README 的权限说明）。
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/server-info" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/entry-http.js"]
