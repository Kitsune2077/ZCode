/**
 * NewAPI 模型分类：只保留可对话模型。
 *
 * NewAPI 的 `/v1/models` 只返回 id，没有类型信息。较新的部署会在 `/api/pricing` 的
 * `supported_endpoint_types` 里标注路由类型（`embedding` / `rerank` / `image-generation`
 * / `audio` ...），这是最权威的信号；但大量部署（包括全部标 `openai` 的实例）并不区分，
 * 所以还需要按模型名兜底识别已知的非对话家族。
 *
 * 判定策略保持"默认保留"：
 *   - 端点类型里出现任何明确的非对话类型 → 过滤；
 *   - 命中已知的非对话模型名特征 → 过滤；
 *   - 其余（含无元数据、名字不认识）→ 保留。
 * 默认保留是有意选择：漏掉一个非对话模型只是多一个选项，误删一个对话模型会直接少能力。
 */

export interface NewApiModelCandidate {
  readonly id: string;
  /** `/api/pricing` 的 supported_endpoint_types；缺失表示部署未提供。 */
  readonly endpointTypes?: readonly string[];
}

/** NewAPI 明确表示"不是对话路由"的端点类型。 */
const NON_CHAT_ENDPOINT_TYPES = new Set([
  "audio",
  "embedding",
  "embeddings",
  "image",
  "image-edit",
  "image-generation",
  "moderation",
  "rerank",
  "speech",
  "transcription",
  "tts",
  "video",
  "video-generation",
]);

/**
 * 已知的非对话模型家族。这些家族在当前 NewAPI 部署里同样上报 `["openai"]`，
 * 端点类型无法区分，只能按名字识别。
 */
const NON_CHAT_NAME_PATTERNS: readonly RegExp[] = [
  /bge/i, // BAAI/bge-*：向量与重排家族
  /embedding/i, // Qwen3-Embedding-*、Qwen3-VL-Embedding-*
  /rerank/i, // Qwen3-Reranker-*、Qwen3-VL-Reranker-*
  /(?:asr|gsr|tts)/i, // 语音识别/合成（含 MOSS-TTSD、XingChenASR/GSR）
  /cosyvoice|sensevoice/i, // FunAudioLLM 语音模型
  /ocr/i, // PaddleOCR 等
  /(?:i2v|t2v)/i, // 图生视频/文生视频
  /wan2/i, // Wan2.x 视频生成
  /kolors/i, // 图像生成
  /image/i, // Qwen-Image、Z-Image、Qwen-Image-Edit
];

export function isNewApiNonChatModel(candidate: NewApiModelCandidate): boolean {
  const types = candidate.endpointTypes ?? [];
  if (types.some((type) => NON_CHAT_ENDPOINT_TYPES.has(type.toLowerCase()))) {
    return true;
  }
  return NON_CHAT_NAME_PATTERNS.some((pattern) => pattern.test(candidate.id));
}

export interface NewApiModelFilterResult {
  readonly chatModelIds: string[];
  readonly filteredModelIds: string[];
}

/**
 * 过滤出可用于对话的模型 id，保持入参顺序并去重。
 * `endpointTypesByModel` 来自 `/api/pricing`，缺失时只按名字判定。
 */
export function filterNewApiChatModels(
  modelIds: readonly string[],
  endpointTypesByModel: ReadonlyMap<string, readonly string[]> = new Map(),
): NewApiModelFilterResult {
  const chatModelIds: string[] = [];
  const filteredModelIds: string[] = [];
  const seen = new Set<string>();

  for (const rawId of modelIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const candidate: NewApiModelCandidate = {
      id,
      ...(endpointTypesByModel.has(id) ? { endpointTypes: endpointTypesByModel.get(id) } : {}),
    };
    if (isNewApiNonChatModel(candidate)) {
      filteredModelIds.push(id);
    } else {
      chatModelIds.push(id);
    }
  }

  return { chatModelIds, filteredModelIds };
}
