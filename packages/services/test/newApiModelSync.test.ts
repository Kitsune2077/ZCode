import assert from "node:assert/strict";
import test from "node:test";
import {
  diffNewApiModelIds,
  syncNewApiProviderModels,
  type NewApiModelSyncHost,
} from "../src/model-provider/newApiModelSync.js";
import { NewApiProvisioningError } from "../src/model-provider/newApiHttp.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

interface RecordedRequest {
  readonly url: string;
}

function createFetchMock(handlers: {
  readonly models?: () => Response;
  readonly pricing?: () => Response;
}): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, _init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url });
    if (url.includes("/api/pricing")) {
      return (handlers.pricing ?? (() => jsonResponse({ data: [] })))();
    }
    if (url.includes("/v1/models")) {
      return (handlers.models ?? (() => jsonResponse({ data: [] })))();
    }
    return jsonResponse({}, 404);
  };
  return { fetch: fetchImpl, requests };
}

interface HostLog {
  readonly added: string[];
  readonly deleted: string[];
}

function createHost(
  provider: { baseUrl: string; apiKey: string; personalModelIds: string[] } | undefined,
): { host: NewApiModelSyncHost; log: HostLog } {
  const log: HostLog = { added: [], deleted: [] };
  return {
    log,
    host: {
      readPersonalProvider: () => provider,
      addPersonalModel: async (_providerId, modelId) => {
        log.added.push(modelId);
      },
      deletePersonalModel: async (_providerId, modelId) => {
        log.deleted.push(modelId);
      },
    },
  };
}

const PROVIDER = {
  apiKey: "sk-key",
  baseUrl: "https://newapi.example.com/v1",
  personalModelIds: ["glm-4.6", "gpt-4o"],
};

test("diffNewApiModelIds keeps server order for additions and local order for removals", () => {
  const diff = diffNewApiModelIds(["a", "b", "c"], ["b", "d", "a", "e"]);
  assert.deepEqual(diff.addedModelIds, ["d", "e"]);
  assert.deepEqual(diff.removedModelIds, ["c"]);
});

test("no difference leaves the provider untouched and reports no change", async () => {
  const { fetch, requests } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "gpt-4o" }, { id: "glm-4.6" }] }),
  });
  const { host, log } = createHost(PROVIDER);

  const result = await syncNewApiProviderModels(host, { fetch }, { providerId: "new-provider" });

  assert.equal(result.changed, false);
  assert.deepEqual(result.modelIds, ["glm-4.6", "gpt-4o"]);
  assert.deepEqual(log.added, []);
  assert.deepEqual(log.deleted, []);
  assert.equal(requests.filter((request) => request.url.includes("/v1/models")).length, 1);
});

test("added and removed models are applied via domain operations in order", async () => {
  const { fetch } = createFetchMock({
    // glm-4.6 下线；新增 glm-5 与 deepseek-v4；bge-embedding 属非对话模型不导入。
    models: () =>
      jsonResponse({
        data: [{ id: "gpt-4o" }, { id: "deepseek-v4" }, { id: "bge-embedding" }, { id: "glm-5" }],
      }),
  });
  const { host, log } = createHost(PROVIDER);

  const result = await syncNewApiProviderModels(host, { fetch }, { providerId: "new-provider" });

  assert.equal(result.changed, true);
  assert.deepEqual(result.addedModelIds, ["deepseek-v4", "glm-5"]);
  assert.deepEqual(result.removedModelIds, ["glm-4.6"]);
  // 先删后加；新增按服务端顺序追加，保留用户已有顺序。
  assert.deepEqual(log.deleted, ["glm-4.6"]);
  assert.deepEqual(log.added, ["deepseek-v4", "glm-5"]);
  assert.deepEqual(result.modelIds, ["gpt-4o", "deepseek-v4", "glm-5"]);
});

test("an empty chat-model catalog throws no-chat-models instead of wiping local models", async () => {
  const { fetch } = createFetchMock({
    models: () => jsonResponse({ data: [{ id: "bge-embedding" }] }),
  });
  const { host, log } = createHost(PROVIDER);

  await assert.rejects(
    syncNewApiProviderModels(host, { fetch }, { providerId: "new-provider" }),
    (error) => error instanceof NewApiProvisioningError && error.code === "no-chat-models",
  );
  assert.deepEqual(log.added, []);
  assert.deepEqual(log.deleted, []);
});

test("a missing provider is a silent no-op with zero requests", async () => {
  const { fetch, requests } = createFetchMock({});
  const { host, log } = createHost(undefined);

  const result = await syncNewApiProviderModels(host, { fetch }, { providerId: "new-provider" });

  assert.equal(result.changed, false);
  assert.deepEqual(log, { added: [], deleted: [] });
  assert.equal(requests.length, 0);
});

test("network failures propagate without partial mutations", async () => {
  const { fetch } = createFetchMock({
    models: () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const { host, log } = createHost(PROVIDER);

  await assert.rejects(
    syncNewApiProviderModels(host, { fetch }, { providerId: "new-provider" }),
    (error) => error instanceof NewApiProvisioningError && error.code === "network-error",
  );
  assert.deepEqual(log.added, []);
  assert.deepEqual(log.deleted, []);
});
