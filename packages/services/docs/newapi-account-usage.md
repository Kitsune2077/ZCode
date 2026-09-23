# NewAPI 账号信息与用量展示

## 背景

`newapi-provider-provisioning.md` 只解决了「用 NewAPI 访问令牌自动落一个 Provider」。
登录后左下角仍显示 ZCode 账号状态（NewAPI 用户显示为「未登录」），设置→用量信息页也没有
NewAPI 的任何账号信息。本功能补齐这两处展示。

## 产品规则

- 登录 NewAPI 成功后，除 `sk-` Key 外，把 **API 根地址 + 访问令牌** 存入凭据服务：
  - `newapi:active_provider` → providerId（当前 NewAPI 连接指针）
  - `newapi:<providerId>:base_url` → 去掉 `/v1` 的 API 根
  - `newapi:<providerId>:access_token` → NewAPI 访问令牌
- 左下角用户信息：**仅当未登录 ZCode 账号（`user === null`）且存在 NewAPI 连接时**，
  显示 NewAPI 账号名；否则维持现有语义（ZCode 账号 / 未登录）。
- 设置→用量信息新增「NewAPI」标签页，展示：
  - 账号名（账号 ID）、角色、分组、状态
  - 余额、已用余额（按 `/api/status` 的 `quota_per_unit` 换算金额，并同时给出原始 quota）
  - 请求次数
  - 近 7 天消耗与请求次数趋势
- 标签页仅在存在 NewAPI 连接（凭据指针存在）时出现。
- 头像菜单：存在 NewAPI 连接且未登录 ZCode 账号时，底部给的是**退出登录**（断开 NewAPI），
  而不是「连接使用」；退出后菜单回到「连接使用」，可以用「使用 NewAPI」重新连接。

## 退出 NewAPI 登录（断开连接）

`clearNewApiConnection` 只删除三个凭据 key（访问令牌、API 根、连接指针）：

- **不删除 Provider**，与 ZCode 账号退出登录保持一致：Provider 配置仍属于用户，
  已导入模型继续可用（模型请求用的是 Provider 里的 `sk-` Key）。
- 断开后：左下角回到「未登录」、用量页的 NewAPI 标签页消失、菜单恢复「连接使用」。
- 删除失败不伪装成功：重读连接，凭据仍在时 UI 回到已连接状态。

## 数据来源（NewAPI 控制台 API）

| 接口                 | 用途                                                                                                       | 必需              |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- |
| `GET /api/user/self` | `id`/`username`/`display_name`/`role`/`status`/`group`/`quota`/`used_quota`/`request_count`                | 是                |
| `GET /api/status`    | `quota_per_unit`（默认 500000=1 货币单位）、`display_in_currency`、`custom_currency_symbol`、`system_name` | 否（best-effort） |
| `GET /api/data/self` | 按天聚合的 `quota`/`count`/`token_used`                                                                    | 否（best-effort） |

- 角色：`1` 普通 / `10` 管理员 / `100` 超级管理员。
- 鉴权：`Authorization: Bearer <access_token>`（与 `/api/token/` 同一套 UserAuth）。
  部分部署的 System Access Token 还需 `New-Api-User` 头；本实现支持通过
  `extraHeaders` 传入，但依赖登录令牌时不发。
- best-effort 接口失败只记录 warn，不影响账号与额度展示。

## 状态所有权

- 凭据（API 根 + 访问令牌）由凭据服务独占；不写入 provider 配置。
- 账号信息是**派生只读投影**，不进入任何 store 作为事实；由 UI hook 按需拉取。
- 网络调用唯一出口仍是 Host 的 `hostApiNetworkTransport.fetch`，经
  `IProviderSettingsService.getNewApiAccountInfo` 暴露。
- 左下角与用量页各自持有自己的拉取状态，不引入第二份被接受的队列或缓存。

## 不变量

- 已登录 ZCode 账号时，左下角不因 NewAPI 连接改变显示。
- 读取失败（令牌过期 / 网络不可达）只降级展示，不写入半成品状态、不清除凭据。
- 未连接 NewAPI 的用户看不到 NewAPI 标签页，也不产生任何请求。

## 验收场景

- A：NewAPI 登录成功 → 凭据写入三个 key；左下角显示 NewAPI 账号名。
- B：已登录 ZCode 账号 → 左下角仍显示 ZCode 账号，不显示 NewAPI。
- C：打开 设置→用量 的 NewAPI 标签 → 展示账号名(ID)/角色/余额/已用余额/请求次数 + 近 7 天趋势。
- D：`/api/data/self` 404 → 仍展示账号与总额度，趋势为空。
- E：访问令牌失效 → 展示可读错误与重试入口，凭据保留。
