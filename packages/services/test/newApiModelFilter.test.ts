import assert from "node:assert/strict";
import test from "node:test";
import {
  filterNewApiChatModels,
  isNewApiNonChatModel,
} from "../src/model-provider/newApiModelFilter.js";

test("endpoint types mark non-chat routes even when the name looks neutral", () => {
  for (const type of ["embedding", "rerank", "image-generation", "audio", "tts", "video"]) {
    assert.equal(
      isNewApiNonChatModel({ id: "some-model", endpointTypes: [type] }),
      true,
      `expected ${type} to be non-chat`,
    );
  }
  assert.equal(isNewApiNonChatModel({ id: "some-model", endpointTypes: ["openai"] }), false);
  assert.equal(
    isNewApiNonChatModel({ id: "some-model", endpointTypes: ["anthropic", "openai"] }),
    false,
  );
});

// 这份清单来自真实的 NewAPI 目录：这些模型在上报 supported_endpoint_types 时同样是 ["openai"]，
// 端点类型无法区分，只能靠名字识别，所以必须逐个锁住。
test("known non-chat model families are filtered by name", () => {
  const nonChatIds = [
    "BAAI/bge-m3",
    "BAAI/bge-large-en-v1.5",
    "BAAI/bge-reranker-v2-m3",
    "Pro/BAAI/bge-reranker-v2-m3",
    "Qwen/Qwen3-Embedding-0.6B",
    "Qwen/Qwen3-Embedding-8B",
    "Qwen/Qwen3-VL-Embedding-8B",
    "Qwen/Qwen3-Reranker-4B",
    "Qwen/Qwen3-VL-Reranker-8B",
    "Qwen/Qwen3-ASR-1.7B",
    "XingChenAGI/XingChenASR-V3.2",
    "XingChenAGI/XingChenGSR-V1.0",
    "FunAudioLLM/CosyVoice2-0.5B",
    "FunAudioLLM/SenseVoiceSmall",
    "fnlp/MOSS-TTSD-v0.5",
    "PaddlePaddle/PaddleOCR-VL-1.5",
    "Wan-AI/Wan2.2-I2V-A14B",
    "Wan-AI/Wan2.2-T2V-A14B",
    "Kwai-Kolors/Kolors",
    "Qwen/Qwen-Image",
    "Qwen/Qwen-Image-Edit-2509",
    "Tongyi-MAI/Z-Image-Turbo",
  ];
  for (const id of nonChatIds) {
    assert.equal(isNewApiNonChatModel({ id }), true, `expected ${id} to be filtered`);
  }
});

test("real chat models are kept, including VL / Omni / coder and LoRA aliases", () => {
  const chatIds = [
    "glm-5.3",
    "glm-5.3-flash",
    "deepseek-flash",
    "deepseek-v4-pro",
    "moonshotai/Kimi-K2.7-Code",
    "Pro/moonshotai/Kimi-K2.6",
    "meituan-longcat/LongCat-2.0",
    "tencent/Hunyuan-MT-7B",
    "tencent/Hy4-preview",
    "ByteDance-Seed/Seed-OSS-36B-Instruct",
    "inclusionAI/Ling-flash-2.0",
    "stepfun-ai/Step-3.5-Flash",
    "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    "Qwen/Qwen3-VL-8B-Instruct",
    "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    "LoRA/Qwen/Qwen2.5-7B-Instruct",
    "Pro/Qwen/Qwen2.5-7B-Instruct",
  ];
  for (const id of chatIds) {
    assert.equal(isNewApiNonChatModel({ id }), false, `expected ${id} to be kept`);
  }
});

test("filterNewApiChatModels splits the list, preserves order and de-duplicates", () => {
  const endpointTypes = new Map<string, readonly string[]>([
    ["Qwen/Qwen-Image", ["image-generation", "openai"]],
  ]);
  const result = filterNewApiChatModels(
    [" glm-5.3 ", "BAAI/bge-m3", "glm-5.3", "Qwen/Qwen-Image", "deepseek-flash", ""],
    endpointTypes,
  );

  assert.deepEqual(result.chatModelIds, ["glm-5.3", "deepseek-flash"]);
  assert.deepEqual(result.filteredModelIds, ["BAAI/bge-m3", "Qwen/Qwen-Image"]);
});

test("an unknown model without metadata is kept by default", () => {
  const result = filterNewApiChatModels(["brand-new-model-v9"]);
  assert.deepEqual(result.chatModelIds, ["brand-new-model-v9"]);
  assert.deepEqual(result.filteredModelIds, []);
});

test("an all-non-chat catalogue yields no chat models", () => {
  const result = filterNewApiChatModels(["BAAI/bge-m3", "Qwen/Qwen3-Embedding-8B"]);
  assert.deepEqual(result.chatModelIds, []);
  assert.equal(result.filteredModelIds.length, 2);
});
