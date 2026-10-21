# 自定义供应商「自动获取模型」（personal-provider-model-fetch）

## 1. 背景与产品规则

对接 NewAPI / 自定义供应商（OpenAI 兼容网关、自建中转等）时，用户此前只能在新建设计的
供应商卡片里逐个手输模型 ID。「自动获取模型」按钮用该 Provider **已保存的 baseUrl +
API Key** 调 `GET {apiRoot}/v1/models`，把本地模型列表**一次性收敛**到服务端目录。

- 仅对**连接信息可编辑**的供应商展示：个人/自定义 Provider（`readOnlyEndpoints === false`）
  且非账号型（`access.type !== "zhipu-account"`）。Bigmodel/Z.ai Coding Plan 等账号型
  Provider 的 Base URL 与 API Key 由 ZCode 自动维护，模型来自套餐权益，不展示该按钮
  （否则点击只会得到"先保存连接"的前置条件报错）；
- **单事务收敛**：新增与移除在**一次**领域写入内完成（`replacePersonalModelIds`），
  设置页只收到一次 `onDidChange` 回流，列表不再逐条刷新；
- **收敛语义与 NewAPI 冷启动同步一致**：用户已保存的相对顺序保留，新增按服务端返回
  顺序追加；服务端目录里消失的 id **一并移除**（连同其个人模型配置）。
  （2026-10-21 用户确认改为此语义；此前"只增不删"规则废止——失效模型长期残留
  同样是用户不需要的"脏列表"，与冷启动同步的差异语义没有留存价值。）
  已存在的 id 跳过，不触碰其排序/禁用/元数据；
- 模型成员只能由领域操作更新，新成员与手动添加同语义（无自定义配置、默认启用）；
- 获取成功但零差异不算失败（提示"均已在列表中"）；服务端返回**空列表**视为异常
  （`no-chat-models`：网络劫持/部署故障信号，不得清空或误报成功）。

## 2. 接口与状态所有者

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 服务 | `IProviderSettingsService.fetchProviderModels({ providerId })` | RPC 透传（ProxyChannel 按方法代理，无需新 channel）；实现见 `packages/services/src/model-provider/providerModelFetch.ts` |
| 数据源 | Provider 的 Personal 层快照 | `personalConfig.api.baseUrl` + `personalConfig.access.apiKey`（type=api-key）；与 NewAPI 同步同源，不读凭据 |
| 写入 | `facade.replacePersonalModelIds` | 单事务收敛 Personal 成员：新成员补默认配置、消失成员删配置；View 经一次 `onDidChange` 回流设置页 |
| 网络 | Host 注入的 `hostFetch` | 复用 `newApiHttp` 请求层：30s 超时、代理/CA、NewAPI 信封与裸 OpenAI 响应兼容 |

结果契约：`{ modelIds, addedModelIds, removedModelIds }`，`added` 按服务端顺序、
`removed` 按本地顺序。

错误契约：连接未保存（缺 baseUrl 或 API Key）抛
`NewApiProvisioningError("provider-connection-missing")`（RPC passthrough 保留 `code`），
UI 提示先保存连接；其余（`model-list-failed` / `network-error` / `no-chat-models` /
`invalid-base-url`）按原文展示。

## 3. UI 行为与事件顺序

```
点击「自动获取模型」（ProviderModelsSection，添加模型按钮旁）
→ onPrepareFetchModels()（卡片先 commitPendingDraft("fetch-models")，保证新输入的
   baseUrl/API Key 先落 Personal 层——服务端读的是已保存快照）
→ providerSettingsService.fetchProviderModels({ providerId })（Host 侧网络请求）
→ replacePersonalModelIds（服务端单事务收敛）→ 一次 onDidChange 回流 → 横幅反馈：
   有差异：「已同步服务端 {total} 个模型，新增 {added} 个，移除 {removed} 个」；
   零差异：「服务端共 {total} 个模型，均已在列表中」；
   失败：code=provider-connection-missing → 前置条件提示；否则「获取失败：{error}」。
```

baseUrl 归一化复用 `normalizeNewApiApiRoot`（剥尾部 `/v1` 后拼 `/v1/models`），
用户填 `https://gw.example/v1` 与 `https://gw.example` 均可用。

## 4. 验收场景

- 自定义供应商已保存 baseUrl+Key → 点击 → 列表一次回流为服务端目录
  （新增追加、失效移除），重复点击零写入（零差异提示）；
- 仅输入未保存（未 blur）→ 点击 → 草稿先自动保存再获取，读到的是最新输入；
- 缺 baseUrl 或 Key → 提示先保存连接，不发请求；
- 服务端 401/网络失败/非 JSON → 失败横幅展示原始错误，本地列表不变；
- 服务端返回空列表 → `no-chat-models`，本地列表不清空；
- 用户手动添加但服务端也返回的 id → 保留其顺序与配置；
- 账号型（Coding Plan）供应商卡片不展示该按钮；预设供应商卡片不展示该按钮。
