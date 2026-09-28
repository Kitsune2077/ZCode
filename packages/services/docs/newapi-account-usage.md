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
- **已解析连接快照**由 `useNewApiConnection` 独占：`null | { providerId, baseUrl, accessToken }`。
  它是"当前生效凭据"的唯一内存副本，其它消费者（footer / 用量页 / 菜单）只读不写。

## 连接快照的引用稳定性与读取收敛（必须保持）

`useNewApiAccount` 的账号读取 effect 以 `connection` 对象作为依赖。历史上这里有**两条**
会让 effect 无限重跑的反馈边，必须同时切断：

**反馈边 1：对象引用不稳定。** `loadNewApiConnection` 每次读凭据都会**新建对象**，
即使三个字段完全没变。规则：`useNewApiConnection` 写入 state 前必须用
`resolveStableNewApiConnection` 收敛引用——三个字段都未变时返回**上一次的同一对象引用**，
让 React 走同值 bailout。凭据真正变化（续期换到新令牌、换域名、重新登录、断开）时
必须给出新对象，否则消费者读不到新值。

**反馈边 2：读取成功后无条件重读连接 + `connectionLoading` 作为 effect 依赖。**
即使引用已收敛，`refreshConnection()` 仍会重跑 connection effect 并翻转
`connectionLoading`（true → 加载中，false → 加载完成）。账号读取 effect 一旦把
`connectionLoading` 列为依赖，每次「false → true → false」翻转都会把一次成功的读取
重新拉起：读取成功 → `refreshConnection()` → loading 翻转 → effect 重跑 →
`setState(loading)`（左下角闪回中性「NewAPI」）→ 读取又成功 → 再 `refreshConnection()` ……
每轮向 NewAPI 发出 3 个请求，直到某次读取失败落入 error 态才停在
「NewAPI」+ 用量页读取失败——这正是「用户名在真实用户名与 NewAPI 之间来回切换、
最后固定为 NewAPI」的完整机制。loading 翻转不是凭据变化，规则：

- 账号读取 effect **不得**把 `connectionLoading` 列为依赖；`connection` 为 `null`
  本身就覆盖了「连接尚未加载完」的早退分支。
- 读取成功后**只在确实发生了令牌续期**（`fetchNewApiAccountWithAutoRefresh` 返回
  `credentialsRenewed: true`，即新令牌已落库、内存快照还持有旧令牌）时才 `refreshConnection()`；
  凭据未变的成功读取是终态，不产生任何重读。

对应的时序（单次登录后稳态为 1 次账号读取，0 次额外连接重读）：

```
markApiKeyLoginSuccess -> connection effect 读凭据 -> connection(第 1 个对象)
   -> 账号读取 -> ready(credentialsRenewed=false) -> 无重读 ✔
```

令牌过期续期后的收敛时序（恰好 1 次重读、共 3 次账号请求）：

```
账号读取(stale token) 失败 -> cookie 兑换新令牌并落库 -> 重读成功(credentialsRenewed=true)
   -> refreshConnection() -> connection(第 2 个对象, 新令牌)
   -> 账号读取(新令牌) -> ready(credentialsRenewed=false) -> 无重读 ✔
```

## 不变量

- 已登录 ZCode 账号时，左下角不因 NewAPI 连接改变显示。
- 读取失败（令牌过期 / 网络不可达）只降级展示，不写入半成品状态、不清除凭据。
- 未连接 NewAPI 的用户看不到 NewAPI 标签页，也不产生任何请求。
- 凭据字段未变化时，重复读取连接**不得**改变 `connection` 的对象引用，也不得触发账号重读。
- 账号读取 effect 不得以 `connectionLoading`（或任何「加载中」标志）作为依赖；
  唯一合法的读取触发是 `connection` 身份变化、手动重试或登录成功事件。
- 凭据未变化时的一次成功读取是终态：不得触发连接重读，也不得再次进入 loading。

## 验收场景

- A：NewAPI 登录成功 → 凭据写入三个 key；左下角显示 NewAPI 账号名。
- B：已登录 ZCode 账号 → 左下角仍显示 ZCode 账号，不显示 NewAPI。
- C：打开 设置→用量 的 NewAPI 标签 → 展示账号名(ID)/角色/余额/已用余额/请求次数 + 近 7 天趋势。
- D：`/api/data/self` 404 → 仍展示账号与总额度，趋势为空。
- E：访问令牌失效 → 展示可读错误与重试入口，凭据保留。
- F：连接成功后（IPv4 / 内网 / 域名地址均适用）→ 左下角稳定显示 NewAPI 用户名，
  用量页 NewAPI 标签稳定展示账号与额度，**不出现用户名与「NewAPI」交替闪烁**，
  且凭据未变化时不产生重复的账号读取请求（hook 级回归测试锁定：读取一直成功时
  `fetchAccount` 恰好调用 1 次）。
- G：令牌续期换到新令牌 → `connection` 取到新对象，用量页与头像菜单读到新凭据；
  断开连接 → `connection` 变回 `null`，左下角回到「未登录」。
- H：令牌过期触发自动续期 → 续期成功后恰好重读一次连接、账号请求序列收敛为
  `stale 失败 → fresh 重试成功 → fresh 稳态成功`，随后不再有任何请求。
