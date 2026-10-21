import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fetchProviderModelsFromEndpoint,
  type ProviderModelFetchHost,
} from "../src/model-provider/providerModelFetch.js";
import { NewApiProvisioningError } from "../src/model-provider/newApiHttp.js";

/**
 * 「自动获取模型」契约（specs/personal-provider-model-fetch.md）：
 * 只导入会话模型（embedding/rerank/图像/音频/视频按名字或 /api/pricing 端点类型过滤）、
 * 单事务收敛（保留既有顺序、新增按服务端顺序追加、失效模型移除）、
 * 零差异零写入、无会话模型/连接缺失按稳定 code 报错、
 * baseUrl 兼容带/不带尾部 /v1 的写法。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

interface RecordedRequest {
  readonly url: string;
  readonly authorization?: string;
}

function createFetchMock(handlers: {
  readonly models?: () => Response;
  readonly pricing?: () => Response;
}): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = init?.headers as Record<string, string> | undefined;
    requests.push({ url, authorization: headers?.Authorization });
    if (url.includes("/v1/models")) {
      return (handlers.models ?? (() => jsonResponse({ data: [] })))();
    }
    if (url.includes("/api/pricing")) {
      // 非 NewAPI 部署没有 /api/pricing：默认 404，readModelEndpointTypes 应容忍并退回按名字判定。
      return handlers.pricing ? handlers.pricing() : jsonResponse({}, 404);
    }
    return jsonResponse({}, 404);
  };
  return { fetch: fetchImpl, requests };
}

function createHost(provider: { baseUrl: string; apiKey: string; personalModelIds: string[] } | undefined): {
  host: ProviderModelFetchHost;
  replaced: string[][];
} {
  const replaced: string[][] = [];
  return {
    replaced,
    host: {
      readPersonalProvider: () => provider,
      replacePersonalModelIds: async (_providerId, modelIds) => {
        replaced.push([...modelIds]);
      },
    },
  };
}

const PROVIDER = {
  apiKey: "sk-key",
  baseUrl: "https://gw.example.com/v1",
  personalModelIds: ["glm-4.6"],
};

test("一次性收敛：保留既有顺序、新增按服务端顺序追加、失效移除", async () => {
  const { fetch, requests } = createFetchMock({
    models: () =>
      jsonResponse({
        data: [{ id: "kimi-k3" }, { id: "glm-4.6" }, { id: "deepseek-v4" }],
      }),
  });
  const { host, replaced } = createHost({
    ...PROVIDER,
    personalModelIds: ["glm-4.6", "stale-model", "glm-4.5"],
  });

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.modelIds, ["kimi-k3", "glm-4.6", "deepseek-v4"]);
  assert.deepEqual(result.addedModelIds, ["kimi-k3", "deepseek-v4"]);
  assert.deepEqual(result.removedModelIds, ["stale-model", "glm-4.5"]);
  // 单次批量写入，且保留成员维持本地顺序、新增追加。
  assert.deepEqual(replaced, [["glm-4.6", "kimi-k3", "deepseek-v4"]]);
  // baseUrl 已带 /v1 时归一化后不重复拼接；端点类型与模型列表并发请求，按 URL 断言。
  assert.equal(requests.filter((request) => request.url.includes("/v1/models")).length, 1);
  assert.equal(
    requests.find((request) => request.url.includes("/v1/models"))?.url,
    "https://gw.example.com/v1/models",
  );
  assert.equal(
    requests.find((request) => request.url.includes("/v1/models"))?.authorization,
    "Bearer sk-key",
  );
});

test("只导入会话模型：非对话家族按模型名过滤（pricing 缺失时兜底）", async () => {
  const { fetch, requests } = createFetchMock({
    models: () =>
      jsonResponse({
        data: [
          { id: "text-embedding-3-small" },
          { id: "glm-4.6" },
          { id: "bge-reranker-v2-m3" },
          { id: "wan2-t2v" },
        ],
      }),
  });
  const { host, replaced } = createHost({
    ...PROVIDER,
    personalModelIds: ["glm-4.6", "text-embedding-3-small"],
  });

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.modelIds, ["glm-4.6"]);
  assert.deepEqual(result.addedModelIds, []);
  assert.deepEqual(result.removedModelIds, ["text-embedding-3-small"]);
  assert.deepEqual(result.filteredModelIds, ["text-embedding-3-small", "bge-reranker-v2-m3", "wan2-t2v"]);
  // 收敛基准只含会话模型：被过滤的 embedding 不再保留。
  assert.deepEqual(replaced, [["glm-4.6"]]);
  // 非 NewAPI 部署的 /api/pricing 404 被容忍，模型列表请求仍只发一次。
  assert.equal(requests.filter((request) => request.url.includes("/v1/models")).length, 1);
});

test("只导入会话模型：/api/pricing 端点类型为权威信号，名字不命中也过滤", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "private-model-x" }, { id: "glm-4.6" }] }),
    pricing: () =>
      // NewAPI 的 /api/* 返回 { success, data } 信封，requestNewApiJson 解包 data。
      jsonResponse({
        data: [
          { model_name: "private-model-x", supported_endpoint_types: ["embedding"] },
          { model_name: "glm-4.6", supported_endpoint_types: ["openai"] },
        ],
      }),
  });
  const { host, replaced } = createHost({ ...PROVIDER, personalModelIds: ["private-model-x"] });

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.modelIds, ["glm-4.6"]);
  assert.deepEqual(result.addedModelIds, ["glm-4.6"]);
  assert.deepEqual(result.removedModelIds, ["private-model-x"]);
  assert.deepEqual(result.filteredModelIds, ["private-model-x"]);
  assert.deepEqual(replaced, [["glm-4.6"]]);
});

test("服务端全部是非会话模型 → no-chat-models，零写入", async () => {
  const { fetch } = createFetchMock({
    models: () =>
      jsonResponse({ data: [{ id: "text-embedding-3-small" }, { id: "bge-reranker-v2-m3" }] }),
  });
  const { host, replaced } = createHost(PROVIDER);

  await assert.rejects(
    fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" }),
    (error: unknown) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "no-chat-models");
      return true;
    },
  );
  assert.deepEqual(replaced, []);
});

test("零差异不写入", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "glm-4.6" }] }),
  });
  const { host, replaced } = createHost(PROVIDER);

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.addedModelIds, []);
  assert.deepEqual(result.removedModelIds, []);
  assert.deepEqual(replaced, []);
});

test("baseUrl 不带 /v1 也能请求到 /v1/models", async () => {
  const { fetch, requests } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "glm-4.6" }] }),
  });
  const { host, replaced } = createHost({ ...PROVIDER, baseUrl: "https://gw.example.com" });

  await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.equal(
    requests.find((request) => request.url.includes("/v1/models"))?.url,
    "https://gw.example.com/v1/models",
  );
  assert.deepEqual(replaced, []);
});

test("服务端返回空列表 → no-chat-models，零写入", async () => {
  const { fetch } = createFetchMock({ models: () => jsonResponse({ data: [] }) });
  const { host, replaced } = createHost(PROVIDER);

  await assert.rejects(
    fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" }),
    (error: unknown) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "no-chat-models");
      return true;
    },
  );
  assert.deepEqual(replaced, []);
});

test("连接未保存（缺 baseUrl/API Key 或 Provider 不存在）→ provider-connection-missing", async () => {
  const { fetch } = createFetchMock({});
  const missing = createHost(undefined);

  await assert.rejects(
    fetchProviderModelsFromEndpoint(missing.host, { fetch }, { providerId: "new-provider" }),
    (error: unknown) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "provider-connection-missing");
      return true;
    },
  );
  assert.deepEqual(missing.replaced, []);
});

test("服务端 401 → model-list-failed（原始错误透传，本地列表不变）", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ message: "invalid api key" }, 401),
  });
  const { host, replaced } = createHost(PROVIDER);

  await assert.rejects(
    fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" }),
    (error: unknown) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "model-list-failed");
      return true;
    },
  );
  assert.deepEqual(replaced, []);
});

test("响应去重：重复 id 只收敛一次", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "m-a" }, { id: "m-a" }, { id: "m-b" }] }),
  });
  const { host, replaced } = createHost({ ...PROVIDER, personalModelIds: [] });

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.modelIds, ["m-a", "m-b"]);
  assert.deepEqual(result.addedModelIds, ["m-a", "m-b"]);
  assert.deepEqual(replaced, [["m-a", "m-b"]]);
});
