# NewAPI Provider Provisioning

## 背景

ZCode 的首次登录入口（`WelcomeScreen` / CLI `/login`）目前只提供 Z.AI / BigModel 的
OAuth 与「粘贴 Coding Plan API Key」。用户若自建 NewAPI（OpenAI 兼容网关），
既没有对应入口，也会被登录门禁（无可用 Provider 时强制弹欢迎页）挡住。

本功能新增一条入口：用户粘贴 **NewAPI 访问令牌（access token）**，ZCode 自动
换取 / 创建 NewAPI 的 `sk-` API Key、拉取模型列表，并落成一个个人 Provider。

## 产品规则

- 输入：NewAPI 服务地址（如 `https://newapi.example.com` 或带 `/v1`）、访问令牌、API 格式（默认 `openai-chat-completions`）。
- 行为：
  1. `GET {apiRoot}/api/token/?p=0&size=100`（`Authorization: Bearer <accessToken>`）列出现有 Token。
  2. 若无 Token：`POST {apiRoot}/api/token/`，body `{name, remain_quota:0, unlimited_quota:true, expired_time:-1}` 创建后再列出。
  3. `POST {apiRoot}/api/token/{id}/key` 取完整 Key，缺失时补 `sk-` 前缀。
  4. `GET {apiRoot}/v1/models`（`Authorization: Bearer <sk-key>`）拉取模型 id。
  5. `GET {apiRoot}/api/pricing`（公开，best-effort）取每个模型的 `supported_endpoint_types`。
  6. **只保留可对话模型**（见下节「模型分类」），非对话模型不导入。
  7. 以 `createPersonalProvider` 落成一个 `standard-personal` Provider：
     `access={type:"api-key",apiKey}`、`api={type:apiFormat,baseUrl:"{apiRoot}/v1"}`、
     `personalModelIds`/`modelOrder` 为过滤后的对话模型。
- `apiRoot` = 去掉末尾 `/v1` 与尾部斜杠后的地址。访问令牌只用于换取 Key，不持久化。
- 落库只保存 `sk-` Key，复用现有个人 Provider 持久化（`provider_config.json`）。

## 模型分类（只导入对话模型）

NewAPI 的 `/v1/models` 只有 id，没有类型；`/api/pricing` 的 `supported_endpoint_types`
是更权威的信号，但大量部署只标注 `openai`（embedding / rerank / ASR / TTS / 图像 / 视频
与对话模型同样上报 `["openai"]`）。因此判定按两级叠加：

1. **端点类型**：出现任何明确的非对话类型即排除
   （`embedding`/`rerank`/`image-generation`/`image`/`audio`/`tts`/`speech`/`video`/`moderation`…）。
2. **模型名**：命中已知非对话家族即排除
   （`bge`、`embedding`、`rerank`、`asr`/`gsr`/`tts`、`cosyvoice`/`sensevoice`、`ocr`、
   `i2v`/`t2v`、`wan2`、`kolors`、`image`）。

判定**默认保留**：端点类型读不到、名字不认识时一律保留。漏掉一个非对话模型只是多一个
选项，误删一个对话模型会直接少能力，两者代价不对称。

过滤后没有任何对话模型时，抛 `no-chat-models`，不创建空 Provider。

## 状态所有权

- Provider 配置的唯一所有者仍是 `ProviderConfigService`；本功能不新增写入路径。
- 网络调用唯一出口是 Host 的 `hostApiNetworkTransport.fetch`（遵守代理 / CA），
  由 `IProviderSettingsService.provisionNewApiProvider` 在 Host 侧执行；
  Renderer 只提交意图并展示结果。

## 接口

```ts
provisionNewApiProvider(input: {
  baseUrl: string;
  accessToken: string;
  apiFormat: "openai-chat-completions" | "anthropic-messages";
  providerName?: string;
  /** 上一次 NewAPI 登录落下的 Provider id；存在且仍然有效时先删后建。 */
  replaceProviderId?: string;
}): Promise<{ providerId: string; modelIds: string[]; baseUrl: string }>;
```

失败以 `NewApiProvisioningError`（带稳定 `code`）抛出，文案经 i18n 呈现。

## 重复登录的替换语义

每次连接都新建会堆出 `NewAPI` / `NewAPI2` / `NewAPI3`。因此重新登录时**先删除遗留
Provider 再创建**。删除命中两类目标：

1. 凭据里记录的上一次 Provider id（`replaceProviderId`）；
2. endpoint 与本服务相同的个人 Provider —— 只按记录 id 删除会漏掉历史遗留的
   `NewAPI` / `NewAPI2`，下一次登录又变成 `NewAPI3`，所以必须按 endpoint 收敛。

endpoint 只归一化尾部斜杠后精确比对，因此另一台自建 NewAPI 不受影响；凭据指针只由
本流程写入，用户手工删除后自动跳过；Host 未提供删除能力时退回只创建。

- **先删后建**是为了复用同一个 `providerId`：基础 id（`new-provider`）被删除后重新空闲，
  下一次创建会再次拿到它，因此用户已保存的默认模型选择不会因 id 变化而失效。
- 代价：删除与创建之间存在一个没有该 Provider 的窗口。创建是本地配置写入，
  失败可通过重新登录恢复。
- 模型成员只能由领域操作更新（`withModelMembershipFrom` 明确不拥有成员变更），
  所以替换成员必须走"重建 Provider"，不能靠字段保存。

## 登录入口与家族域

`providerFamilyDomain` 只接受 `zai` / `bigmodel`。非智谱家族的用户（自建 NewAPI /
自定义 Provider）迁移完成后该字段仍然是空，而登录入口守卫原先把"空"等同于"还没决定"，
于是每次启动都强制弹回连接账号页。

守卫改为只有在"迁移尚未给出结论"时才因该字段强制登录入口：

```ts
const familyDomainPending = !providerFamilyDomain && !providerFamilyDomainMigrationComplete;
const shouldOpenLoginEntry = familyDomainPending || (!user && !hasUsableProvider);
```

迁移已完成 + 有可用 Provider 的用户不再被拦；没有任何可用 Provider 时行为不变。

## 不变量

- 不持久化访问令牌；仅持久化换取的 `sk-` Key。
- 未命中 NewAPI 时不影响既有 OAuth / Coding Plan 流程。
- 同一账号反复登录始终只保留一个 NewAPI Provider。

## 验收场景

- A：已有 Token → 直接取 Key + 模型，创建 Provider 成功。
- B：无 Token → 自动创建后再取 Key。
- C：地址含 `/v1` 或不含 → 归一化后 token API 与 relay base 都正确。
- D：访问令牌无效 / 网络失败 → 结构化错误，UI 可读，不写入半成品 Provider。
- E：`/api/pricing` 不可用 → 仍按模型名过滤，导入成功。
- F：目录里混合对话与非对话模型 → 只导入对话模型，`filteredModelIds` 记录被排除项。
- G：目录里没有任何对话模型 → 抛 `no-chat-models`，不创建空 Provider。
- H：第二次登录（`replaceProviderId` 命中现存 Provider）→ 先删除再创建，`providerId` 不变。
- I：`replaceProviderId` 指向已不存在的 Provider → 跳过删除，只创建。
- J：非智谱家族用户（迁移完成、`providerFamilyDomain` 为空）且有可用 Provider → 启动不再被弹回连接账号页。
