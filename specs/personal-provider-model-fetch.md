# 自定义供应商「自动获取模型」（personal-provider-model-fetch）

## 1. 背景与产品规则

对接 NewAPI / 自定义供应商（OpenAI 兼容网关、自建中转等）时，用户此前只能在新建设计的
供应商卡片里逐个手输模型 ID。「自动获取模型」按钮用该 Provider **已保存的 baseUrl +
API Key** 调 `GET {apiRoot}/v1/models`，把服务端模型列表**追加**进本地模型列表。

- 仅对**端点可编辑**的供应商（个人/自定义 Provider，`readOnlyEndpoints === false`）展示；
  预设供应商的模型来自内置定义，不在本功能范围（仍可手动添加）；
- **只增不删**：用户已整理的排序/禁用/元数据是本地事实，服务端目录里消失的 id 不移除；
  已存在的 id 跳过，新增按服务端返回顺序追加（与 NewAPI 登录导入一致）；
- 模型成员只能由领域操作更新（`addPersonalModel`，无自定义配置、默认启用），
  与手动添加 / NewAPI 冷启动同步同语义；
- 获取成功但零新增不算失败（提示"均已在列表中"）；服务端返回**空列表**视为异常
  （`no-chat-models`：网络劫持/部署故障信号，不得清空或误报成功）。

## 2. 接口与状态所有者

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 服务 | `IProviderSettingsService.fetchProviderModels({ providerId })` | RPC 透传（ProxyChannel 按方法代理，无需新 channel）；实现见 `packages/services/src/model-provider/providerModelFetch.ts` |
| 数据源 | Provider 的 Personal 层快照 | `personalConfig.api.baseUrl` + `personalConfig.access.apiKey`（type=api-key）；与 NewAPI 同步同源，不读凭据 |
| 写入 | `facade.addPersonalModel` | 服务端逐个追加；View 经 `onDidChange` 回流设置页 |
| 网络 | Host 注入的 `hostFetch` | 复用 `newApiHttp` 请求层：30s 超时、代理/CA、NewAPI 信封与裸 OpenAI 响应兼容 |

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
→ 追加模型（服务端）→ onDidChange 回流 → 横幅反馈：
   新增>0：「已获取 {total} 个模型，新增 {added} 个」；
   新增=0：「服务端共 {total} 个模型，均已在列表中」；
   失败：code=provider-connection-missing → 前置条件提示；否则「获取失败：{error}」。
```

baseUrl 归一化复用 `normalizeNewApiApiRoot`（剥尾部 `/v1` 后拼 `/v1/models`），
用户填 `https://gw.example/v1` 与 `https://gw.example` 均可用。

## 4. 验收场景

- 自定义供应商已保存 baseUrl+Key → 点击 → 服务端模型追加进列表，重复点击无重复项；
- 仅输入未保存（未 blur）→ 点击 → 草稿先自动保存再获取，读到的是最新输入；
- 缺 baseUrl 或 Key → 提示先保存连接，不发请求；
- 服务端 401/网络失败/非 JSON → 失败横幅展示原始错误，本地列表不变；
- 预设供应商卡片不展示该按钮。
