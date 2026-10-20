import assert from "node:assert/strict";
import { test } from "vitest";
import {
  fetchProviderModelsFromEndpoint,
  type ProviderModelFetchHost,
} from "../src/model-provider/providerModelFetch.js";
import { NewApiProvisioningError } from "../src/model-provider/newApiHttp.js";

/**
 * 「自动获取模型」契约（specs/personal-provider-model-fetch.md）：
 * 只增不删、已存在跳过、空列表/连接缺失按稳定 code 报错、
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
}): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = init?.headers as Record<string, string> | undefined;
    requests.push({ url, authorization: headers?.Authorization });
    if (url.includes("/v1/models")) {
      return (handlers.models ?? (() => jsonResponse({ data: [] })))();
    }
    return jsonResponse({}, 404);
  };
  return { fetch: fetchImpl, requests };
}

function createHost(
  provider: { baseUrl: string; apiKey: string; personalModelIds: string[] } | undefined,
): { host: ProviderModelFetchHost; added: string[] } {
  const added: string[] = [];
  return {
    added,
    host: {
      readPersonalProvider: () => provider,
      addPersonalModel: async (_providerId, modelId) => {
        added.push(modelId);
      },
    },
  };
}

const PROVIDER = {
  apiKey: "sk-key",
  baseUrl: "https://gw.example.com/v1",
  personalModelIds: ["glm-4.6"],
};

test("追加服务端模型（已存在跳过、保序、只增不删）", async () => {
  const { fetch, requests } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "glm-4.6" }, { id: "deepseek-v4" }, { id: "kimi-k3" }] }),
  });
  const { host, added } = createHost(PROVIDER);

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.modelIds, ["glm-4.6", "deepseek-v4", "kimi-k3"]);
  assert.deepEqual(result.addedModelIds, ["deepseek-v4", "kimi-k3"]);
  assert.deepEqual(added, ["deepseek-v4", "kimi-k3"]);
  // baseUrl 已带 /v1 时归一化后不重复拼接。
  assert.equal(requests.filter((request) => request.url.includes("/v1/models")).length, 1);
  assert.equal(requests[0]?.url, "https://gw.example.com/v1/models");
  assert.equal(requests[0]?.authorization, "Bearer sk-key");
});

test("baseUrl 不带 /v1 也能请求到 /v1/models", async () => {
  const { fetch, requests } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "glm-4.6" }] }),
  });
  const { host, added } = createHost({ ...PROVIDER, baseUrl: "https://gw.example.com" });

  await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.equal(requests[0]?.url, "https://gw.example.com/v1/models");
  assert.deepEqual(added, []);
});

test("服务端返回空列表 → no-chat-models，零写入", async () => {
  const { fetch } = createFetchMock({ models: () => jsonResponse({ data: [] }) });
  const { host, added } = createHost(PROVIDER);

  await assert.rejects(
    fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" }),
    (error: unknown) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "no-chat-models");
      return true;
    },
  );
  assert.deepEqual(added, []);
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
  assert.deepEqual(missing.added, []);
});

test("服务端 401 → model-list-failed（原始错误透传，本地列表不变）", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ message: "invalid api key" }, 401),
  });
  const { host, added } = createHost(PROVIDER);

  await assert.rejects(
    fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" }),
    (error: unknown) => {
      assert.ok(error instanceof NewApiProvisioningError);
      assert.equal(error.code, "model-list-failed");
      return true;
    },
  );
  assert.deepEqual(added, []);
});

test("响应去重：重复 id 只追加一次", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "m-a" }, { id: "m-a" }, { id: "m-b" }] }),
  });
  const { host, added } = createHost({ ...PROVIDER, personalModelIds: [] });

  const result = await fetchProviderModelsFromEndpoint(host, { fetch }, { providerId: "new-provider" });

  assert.deepEqual(result.modelIds, ["m-a", "m-b"]);
  assert.deepEqual(added, ["m-a", "m-b"]);
});
