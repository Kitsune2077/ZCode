# NewAPI 浏览器登录（会话接管）

## 背景

NewAPI 支持 OAuth 登录（例如用 TinyAuth 作为 OIDC 提供方）。但要注意角色：

- **TinyAuth 是 NewAPI 的登录方式**，不是 ZCode 的。NewAPI 在 TinyAuth 里注册为 OIDC 客户端，
  可信 redirect URI 指向 **NewAPI 自己的域**（形如 `https://<newapi-host>/oauth/<provider>`）。
- 因此 ZCode **不能**、也不需要自己直连 TinyAuth 做 OIDC 握手：那样只能拿到 TinyAuth 的
  token，NewAPI 不认，拿不到模型密钥。

结论：**让用户在 ZCode 内的登录窗口里完成 NewAPI 登录，然后接管会话**。这样 TinyAuth / GitHub /
密码 / LDAP 等任何 NewAPI 支持的登录方式都自动可用——这才是"通用"。

## 已核实的契约（源码 + 线上实测）

| 事实                                                                                                   | 依据                                          |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `GET /api/oauth/:provider` 是浏览器会话流程，回调在 NewAPI 域上，不向第三方客户端发 token              | `router/api-router.go`、`controller/oauth.go` |
| `middleware.UserAuth()` / `TryUserAuth()` **同时接受** `Authorization: Bearer <PAT>` 与 dashboard 会话 | `middleware/auth.go`                          |
| 会话凭据是 cookie `new_api_refresh`（另有可被脚本读取的 `new_api_has_session`）                        | `service/auth_session.go`                     |
| `POST /api/user/auth/refresh` 用该 cookie 兑换令牌，返回 JSON 并**轮换** cookie                        | `controller/auth_session.go`                  |
| 会话 cookie 的 **Path 是 `/api/user/auth`**，不是 `/`                                                  | `service/auth_session.go: WriteRefreshCookie` |
| 线上实测：伪造 cookie 请求该端点返回 `{"code":"AUTH_UNAUTHORIZED"}` / 401（端点存在）                  | 对自建实例探测                                |

### 踩过的坑：按根 URL 查不到这个 cookie

Electron 的 `session.cookies.get({ url })` **同时按路径匹配**。NewAPI 的会话 cookie 被限制在
`Path=/api/user/auth`，用根 URL（`https://<host>`）查询会永远返回空——症状是"登录成功、窗口停留、
却一直读不到 cookie"，第一次真机验证就是这样失败的。

查询必须用 `${origin}/api/user/auth`。这个 URL 既能命中受限 Path 的 cookie，也能命中 `Path=/` 的
同名 cookie，所以 NewAPI 将来把 Path 改回根路径时无需再改代码。
见 `resolveNewApiSessionCookieLookupUrl()`（`@zcode/shared`）。

因为 dashboard 接口同时接受会话与 PAT，现有的 NewAPI 适配链路
（`/api/user/self`、`/api/token/`、对话模型过滤导入、左下角身份、用量页）**可以整体复用**，
本功能只改变"凭据从哪来"。

## 两个必须规避的坑

1. **不要用 `POST /api/user/token` 自动化**：它是**重新生成** access token
   （`UpdateUserAccessToken` 覆盖旧值，会让用户其它客户端立即失效），且需要额外 security proof。
   本功能一律走会话刷新。
2. **会话带环境绑定**：`RefreshLoginSession` 会把**客户端 IP 与 User-Agent** 纳入校验，
   且该端点带 `SessionCookieOriginGuard`。同一台机器上浏览器与 ZCode 出口 IP 一致时可行；
   若浏览器走代理而 ZCode 不走（或反之），刷新可能被拒——错误提示必须说清这一点，
   而不是笼统报"登录失败"。

## 状态所有权

| 关注点                                               | 所有者                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| 登录窗口生命周期、分区、cookie 读取                  | Desktop main（`packages/desktop/src/main`）                             |
| 浏览器登录能力的跨端契约                             | `IPlatformService`（`packages/shared/src/platform.ts`）                 |
| 会话 → access token 的兑换与刷新                     | `packages/services/src/model-provider`（与现有 NewAPI HTTP 层同一出口） |
| 凭据持久化（refresh cookie、access token、连接指针） | `ICredentialService`，key 前缀沿用 `newapi:`                            |
| 登录表单与流程编排                                   | `packages/ui/src/login/LoginNewApiForm.tsx`                             |

## 连接与重连语义：一次只保留一个 NewAPI 连接

NewAPI 连接按「账号接入」理解：应用同时只保留一个由本流程创建的 Provider。

- `newapi:last_provider` 记录**上一次成功登录**落下的 Provider id，**跨「断开连接」保留**；
  `newapi:active_provider` 是活动连接指针，断开时删除（断开后左下角、用量页与「使用 NewAPI」
  入口回到未连接状态）。登录时的替换目标取「活动指针 ?? last 指针」。
- 「断开连接」只清凭据（access token / refresh cookie / base URL / 活动指针），**不删除 Provider**：
  Provider 配置仍由用户拥有，已导入的模型在重新登录前继续可用。
- 登录成功时**先删后建**：删除替换目标指向的 Provider，以及与本次 endpoint 完全相同的个人
  Provider，再创建新 Provider。因此**换域名**（同一台 NewAPI 迁到新域名，endpoint 变了）或
  **换账号**重登都只是替换，不会堆出 `NewAPI 2` / `NewAPI 3`；基础 id 被删除后重新空闲，
  新 Provider 重新拿到 `new-provider` 与名字 `NewAPI`。
- 替换目标已被用户手工删除时跳过并只创建（幂等）；Host 未提供删除能力时退回只创建。
- 代价与边界：若确实要同时保留两台 NewAPI，请用「自定义 Provider」手工配置——
  本流程不并行保留两条 NewAPI 连接。

## 接口

```ts
// shared：renderer 请求 main 打开登录窗口
openNewApiLoginWindow(input: {
  baseUrl: string;          // NewAPI 根地址
  provider?: string;        // 可选，如 "tinyauth"；给定时直接打开 {baseUrl}/oauth/<provider>
  cookieName: string;       // 目标 cookie 名（NewAPI 为 "new_api_refresh"）
}): Promise<
  | { status: "completed"; cookieValue: string; origin: string }
  | { status: "cancelled" }
  | { status: "timeout" }
  | { status: "failed"; code: string; message: string }
>;
```

```ts
// services：用会话 cookie 换 access token（与现有 NewAPI 请求同一出口）
exchangeNewApiSessionForAccessToken(network, {
  baseUrl: string;
  refreshCookie: string;
}): Promise<{ accessToken: string; rotatedCookie?: string }>;
```

## 流程

```
用户在登录入口选「使用 NewAPI 账号登录」
   ↓ 可选填写 provider（如 tinyauth）
main 打开隔离分区的登录窗口 → {baseUrl}/login 或 {baseUrl}/oauth/<provider>
   ↓ 用户在其中完成登录（TinyAuth / GitHub / 密码…）
main 轮询该分区的 {cookieName}；命中即关闭窗口并返回 cookie
   ↓
services 用 cookie 调 POST /api/user/auth/refresh → access token
   ↓
复用既有链路：/api/user/self（左下角身份与用量页）
   · /api/token/（取或建 sk- key）· 过滤对话模型并导入 · 保存连接
   ↓
凭据仓库额外保存 refresh cookie，供后续自动换取 access token
```

## 不变量

- refresh cookie 只写入凭据仓库（加密），**不落日志、不进错误信息、不回传渲染进程以外的渠道**；
- 登录窗口使用独立 partition，不与应用内其它浏览器共享存储；
- 窗口在完成/取消/超时后必须关闭并释放分区，不留后台窗口；
- 会话刷新失败只影响 NewAPI 相关功能，不阻断应用启动；
- 仍保留"手动粘贴 access token"作为回退（老版本 NewAPI 无 `new_api_refresh`，或企业策略禁止此类登录）。

## 安全说明

登录窗口会读取目标站点的会话 cookie，这是一项敏感能力。约束：

- 只在用户显式点击登录、且目标为用户填写的 `baseUrl` 时开启；
- 只读取**约定名称**的 cookie（不遍历、不导出其它 cookie）；
- 读取到的值经 RPC 直接写入凭据仓库，不经过 UI 状态、不参与遥测；
- 窗口内不注入任何 preload 脚本，不对外开放调试端口。

## 验收场景

- A：填 `baseUrl` + provider=tinyauth → 窗口直达 TinyAuth，登录后窗口自动关闭，左下角显示 NewAPI 账号，模型已导入。
- B：不填 provider → 窗口落在 NewAPI 登录页，用户手动选登录方式，其余同上。
- C：用户在窗口内点取消/直接关窗 → 返回 `cancelled`，不写入任何凭据。
- D：超时（默认 5 分钟）→ 返回 `timeout`，窗口关闭，凭据不变。
- E：cookie 拿到但刷新被拒（如 IP/UA 不匹配）→ 明确提示"会话校验未通过，请用同一网络环境重新登录"。
- F：已有连接的 refresh cookie 过期 → 自动刷新一次；仍失败则标记连接失效并提示重新登录，不影响其它 Provider。
- G：老版本 NewAPI（无 `new_api_refresh`）→ 登录窗口仍可用（手动粘贴 access token 路径不变）。
- H：已连接账号 A（手动令牌）→ 「断开连接」→ 用 OAuth 登录账号 B 且**域名已变化** →
  账号 A 的 Provider 被替换，模型列表只剩账号 B 的模型，Provider 名回到 `NewAPI`（不再出现 `NewAPI 2`）；
  断开期间账号 A 的模型仍可用。

## 未决/后续

- 会话 cookie 的具体名称随 NewAPI 版本可能变化，实现时以运行时发现的值为准（当前版本为 `new_api_refresh`）；
- 若将来 NewAPI 提供面向原生客户端的 token 端点，可去掉"读 cookie"这一步，退化为纯 OIDC/PKCE；
- 本功能只覆盖 NewAPI；抽象到通用 OIDC 客户端（loopback + PKCE）留待后续。
