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
}): Promise<{ providerId: string; modelIds: string[]; baseUrl: string }>;
```

失败以 `NewApiProvisioningError`（带稳定 `code`）抛出，文案经 i18n 呈现。

## 不变量

- 不持久化访问令牌；仅持久化换取的 `sk-` Key。
- 未命中 NewAPI 时不影响既有 OAuth / Coding Plan 流程。
- 同一访问令牌重复调用不产生重复 Provider（每次调用创建新 Provider 是显式行为，UI 负责引导）。

## 验收场景

- A：已有 Token → 直接取 Key + 模型，创建 Provider 成功。
- B：无 Token → 自动创建后再取 Key。
- C：地址含 `/v1` 或不含 → 归一化后 token API 与 relay base 都正确。
- D：访问令牌无效 / 网络失败 → 结构化错误，UI 可读，不写入半成品 Provider。
- E：`/api/pricing` 不可用 → 仍按模型名过滤，导入成功。
- F：目录里混合对话与非对话模型 → 只导入对话模型，`filteredModelIds` 记录被排除项。
- G：目录里没有任何对话模型 → 抛 `no-chat-models`，不创建空 Provider。
