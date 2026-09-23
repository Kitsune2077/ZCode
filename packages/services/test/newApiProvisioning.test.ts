import assert from "node:assert/strict";
import test from "node:test";
import {
  NewApiProvisioningError,
  normalizeNewApiApiRoot,
  provisionNewApiProvider,
  resolveNewApiConnection,
} from "../src/model-provider/newApiProvisioning.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly method: string;
  readonly url: string;
}

function createFetchMock(handlers: {
  readonly tokens?: () => Response;
  readonly create?: () => Response;
  readonly key?: () => Response;
  readonly models?: () => Response;
  readonly pricing?: () => Response;
}): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get("authorization") ?? undefined,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method: init?.method ?? "GET",
      url,
    });
    if (url.includes("/api/token/") && url.includes("/key")) {
      return (handlers.key ?? (() => jsonResponse({ data: { key: "raw-key" } })))();
    }
    if (url.includes("/api/token/")) {
      if (init?.method === "POST") {
        return (handlers.create ?? (() => jsonResponse({ success: true })))();
      }
      return (handlers.tokens ?? (() => jsonResponse({ data: { items: [{ id: 1 }] } })))();
    }
    // /api/pricing 默认 404：端点类型是可选元数据，缺失时必须仍能按名字过滤。
    if (url.includes("/api/pricing")) {
      return (handlers.pricing ?? (() => jsonResponse({ success: false }, 404)))();
    }
    if (url.includes("/v1/models")) {
      return (handlers.models ?? (() => jsonResponse({ data: [{ id: "gpt-4o" }] })))();
    }
    return jsonResponse({}, 404);
  };
  return { fetch: fetchImpl, requests };
}

test("normalizeNewApiApiRoot strips trailing slash and /v1", () => {
  assert.equal(normalizeNewApiApiRoot("https://newapi.example.com"), "https://newapi.example.com");
  assert.equal(normalizeNewApiApiRoot("https://newapi.example.com/"), "https://newapi.example.com");
  assert.equal(
    normalizeNewApiApiRoot("https://newapi.example.com/v1"),
    "https://newapi.example.com",
  );
  assert.equal(
    normalizeNewApiApiRoot("https://newapi.example.com/v1/"),
    "https://newapi.example.com",
  );
  assert.throws(
    () => normalizeNewApiApiRoot("not-a-url"),
    (error) => error instanceof NewApiProvisioningError && error.code === "invalid-base-url",
  );
});

test("resolveNewApiConnection reuses an existing token and fetches models", async () => {
  const { fetch, requests } = createFetchMock({
    key: () => jsonResponse({ data: { key: "sk-existing" } }),
    models: () => jsonResponse({ data: [{ id: "gpt-4o" }, { id: "glm-4.6" }, { id: "gpt-4o" }] }),
    tokens: () => jsonResponse({ data: { items: [{ id: 7 }] } }),
  });

  const result = await resolveNewApiConnection(
    { fetch },
    { accessToken: "access-token", baseUrl: "https://newapi.example.com/v1" },
  );

  assert.equal(result.apiRoot, "https://newapi.example.com");
  assert.equal(result.apiKey, "sk-existing");
  assert.deepEqual(result.modelIds, ["gpt-4o", "glm-4.6"]);
  assert.ok(requests.every((request) => !request.url.includes("/v1/v1")));
  assert.equal(
    requests.find((request) => request.url.includes("/v1/models"))?.authorization,
    "Bearer sk-existing",
  );
});

test("resolveNewApiConnection creates a token when none exists", async () => {
  let tokenListCalls = 0;
  const { fetch, requests } = createFetchMock({
    create: () => jsonResponse({ success: true }),
    key: () => jsonResponse({ data: { key: "no-prefix" } }),
    tokens: () => {
      tokenListCalls += 1;
      return tokenListCalls === 1
        ? jsonResponse({ data: { items: [] } })
        : jsonResponse({ data: { items: [{ id: 9 }] } });
    },
  });

  const result = await resolveNewApiConnection(
    { fetch },
    { accessToken: "access-token", baseUrl: "https://newapi.example.com" },
  );

  assert.equal(result.apiKey, "sk-no-prefix");
  const createRequest = requests.find(
    (request) => request.method === "POST" && request.url.endsWith("/api/token/"),
  );
  assert.deepEqual(createRequest?.body, {
    expired_time: -1,
    name: "zcode-api-key",
    remain_quota: 0,
    unlimited_quota: true,
  });
});

test("resolveNewApiConnection surfaces a structured error on rejected access token", async () => {
  const { fetch } = createFetchMock({
    tokens: () => jsonResponse({ message: "unauthorized" }, 401),
  });

  await assert.rejects(
    () =>
      resolveNewApiConnection(
        { fetch },
        { accessToken: "bad", baseUrl: "https://newapi.example.com" },
      ),
    (error) => error instanceof NewApiProvisioningError && error.code === "token-list-failed",
  );
});

test("provisionNewApiProvider writes an openai-compatible personal provider", async () => {
  const { fetch } = createFetchMock({});
  const created: Array<{ providerName?: string; initialConfig: unknown }> = [];

  const result = await provisionNewApiProvider(
    {
      createPersonalProvider: async (input) => {
        created.push(input);
        return { providerId: "personal:newapi-1" };
      },
    },
    { fetch },
    {
      accessToken: "access-token",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://newapi.example.com",
    },
  );

  assert.equal(result.providerId, "personal:newapi-1");
  assert.equal(result.baseUrl, "https://newapi.example.com/v1");
  assert.equal(created.length, 1);
  assert.equal(created[0]?.providerName, "NewAPI");
  assert.deepEqual(created[0]?.initialConfig, {
    access: { apiKey: "sk-raw-key", type: "api-key" },
    api: { baseUrl: "https://newapi.example.com/v1", type: "openai-chat-completions" },
    modelOrder: ["gpt-4o"],
    personalModelIds: ["gpt-4o"],
  });
});

test("provisionNewApiProvider imports only chat models", async () => {
  const { fetch } = createFetchMock({
    models: () =>
      jsonResponse({
        data: [
          { id: "glm-5.3" },
          { id: "BAAI/bge-m3" },
          { id: "Qwen/Qwen3-Embedding-8B" },
          { id: "deepseek-flash" },
          { id: "Qwen/Qwen-Image" },
        ],
      }),
    pricing: () =>
      jsonResponse({
        data: [
          {
            model_name: "Qwen/Qwen-Image",
            supported_endpoint_types: ["image-generation", "openai"],
          },
          { model_name: "glm-5.3", supported_endpoint_types: ["anthropic", "openai"] },
        ],
        success: true,
      }),
  });
  const created: Array<{ initialConfig: unknown }> = [];

  const result = await provisionNewApiProvider(
    {
      createPersonalProvider: async (input) => {
        created.push(input);
        return { providerId: "personal:newapi-2" };
      },
    },
    { fetch },
    {
      accessToken: "access-token",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://newapi.example.com",
    },
  );

  assert.deepEqual(result.modelIds, ["glm-5.3", "deepseek-flash"]);
  const importedConfig = created[0]?.initialConfig as
    | { modelOrder: string[]; personalModelIds: string[] }
    | undefined;
  assert.deepEqual(importedConfig?.personalModelIds, ["glm-5.3", "deepseek-flash"]);
  assert.deepEqual(importedConfig?.modelOrder, ["glm-5.3", "deepseek-flash"]);
});

test("endpoint types filter a model whose name carries no signal", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "brand-new-v9" }, { id: "glm-5.3" }] }),
    pricing: () =>
      jsonResponse({
        data: [{ model_name: "brand-new-v9", supported_endpoint_types: ["embeddings"] }],
        success: true,
      }),
  });

  const result = await resolveNewApiConnection(
    { fetch },
    { accessToken: "access-token", baseUrl: "https://newapi.example.com" },
  );

  assert.deepEqual(result.modelIds, ["glm-5.3"]);
  assert.deepEqual(result.filteredModelIds, ["brand-new-v9"]);
});

test("a catalogue with no chat models fails loudly instead of creating an empty provider", async () => {
  const { fetch } = createFetchMock({
    models: () =>
      jsonResponse({ data: [{ id: "BAAI/bge-m3" }, { id: "Qwen/Qwen3-Embedding-8B" }] }),
  });

  await assert.rejects(
    () =>
      resolveNewApiConnection(
        { fetch },
        { accessToken: "access-token", baseUrl: "https://newapi.example.com" },
      ),
    (error) => error instanceof NewApiProvisioningError && error.code === "no-chat-models",
  );
});

test("re-login replaces the previous NewAPI provider instead of adding another", async () => {
  const { fetch } = createFetchMock({});
  const calls: string[] = [];
  // 先删后建让基础 id 重新空闲，因此下一次创建再次拿到同一个 providerId。
  let createdId = "new-provider-2";

  const result = await provisionNewApiProvider(
    {
      createPersonalProvider: async () => {
        calls.push("create");
        return { providerId: createdId };
      },
      deletePersonalProvider: async (providerId) => {
        calls.push(`delete:${providerId}`);
        createdId = "new-provider";
      },
      listPersonalProviders: async () => [
        { baseUrl: "https://newapi.example.com/v1", providerId: "new-provider" },
      ],
    },
    { fetch },
    {
      accessToken: "access-token",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://newapi.example.com",
      replaceProviderId: "new-provider",
    },
  );

  assert.deepEqual(calls, ["delete:new-provider", "create"]);
  assert.equal(result.providerId, "new-provider");
});

test("a stale replaceProviderId is skipped and the provider is only created", async () => {
  const { fetch } = createFetchMock({});
  const calls: string[] = [];

  const result = await provisionNewApiProvider(
    {
      createPersonalProvider: async () => {
        calls.push("create");
        return { providerId: "new-provider" };
      },
      deletePersonalProvider: async (providerId) => {
        calls.push(`delete:${providerId}`);
      },
      listPersonalProviders: async () => [
        { baseUrl: "https://other.example.com/v1", providerId: "some-other-provider" },
      ],
    },
    { fetch },
    {
      accessToken: "access-token",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://newapi.example.com",
      replaceProviderId: "new-provider",
    },
  );

  // 记录 id 不在、endpoint 也不同：不应删掉别人的 Provider。
  assert.deepEqual(calls, ["create"]);
  assert.equal(result.providerId, "new-provider");
});

test("providers left on the same NewAPI endpoint are all collapsed", async () => {
  const { fetch } = createFetchMock({});
  const calls: string[] = [];

  await provisionNewApiProvider(
    {
      createPersonalProvider: async () => {
        calls.push("create");
        return { providerId: "new-provider" };
      },
      deletePersonalProvider: async (providerId) => {
        calls.push(`delete:${providerId}`);
      },
      // 历史遗留：同一 endpoint 上两个 Provider，尾部斜杠写法还不一致。
      listPersonalProviders: async () => [
        { baseUrl: "https://newapi.example.com/v1", providerId: "new-provider" },
        { baseUrl: "https://newapi.example.com/v1/", providerId: "new-provider-2" },
        { baseUrl: "https://another.example.com/v1", providerId: "unrelated" },
      ],
    },
    { fetch },
    {
      accessToken: "access-token",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://newapi.example.com",
      replaceProviderId: "new-provider-2",
    },
  );

  assert.deepEqual(calls, ["delete:new-provider", "delete:new-provider-2", "create"]);
});

test("a host without delete capability keeps the create-only behaviour", async () => {
  const { fetch } = createFetchMock({});
  const calls: string[] = [];

  await provisionNewApiProvider(
    {
      createPersonalProvider: async () => {
        calls.push("create");
        return { providerId: "new-provider" };
      },
    },
    { fetch },
    {
      accessToken: "access-token",
      apiFormat: "openai-chat-completions",
      baseUrl: "https://newapi.example.com",
      replaceProviderId: "new-provider",
    },
  );

  assert.deepEqual(calls, ["create"]);
});
