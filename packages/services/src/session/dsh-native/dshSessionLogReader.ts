import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("dsh-native-import");

/** zstd frame magic（小端）：28 B5 2F FD。 */
const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

type MutableRecord = Record<string, unknown>;

function isObjectRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** DSH 会话文件是"每段追加一个 zstd frame"的拼接流；Node 单帧 API 不自动续帧，按 magic 切分。 */
export function findZstdFrameStarts(buffer: Buffer): number[] {
  const starts: number[] = [];
  let index = buffer.indexOf(ZSTD_FRAME_MAGIC);
  while (index >= 0) {
    starts.push(index);
    index = buffer.indexOf(ZSTD_FRAME_MAGIC, index + 1);
  }
  return starts;
}

export interface DshSessionLogReadResult {
  records: MutableRecord[];
  /** 因解压失败或行损坏被跳过的 frame 数；magic 误报或半写 frame 时出现，不阻断读取。 */
  skippedFrames: number;
}

/**
 * 解压 DSH 会话日志并解析全部 JSONL 记录。
 * 每帧可能包含多行；按顺序返回（文件本身就是按 seq 追加的有序事件流）。
 */
export function parseDshSessionLogBuffer(
  buffer: Buffer,
  params?: { maxFrames?: number; maxRecords?: number },
): DshSessionLogReadResult {
  const starts = findZstdFrameStarts(buffer);
  const frameLimit = params?.maxFrames ?? Number.POSITIVE_INFINITY;
  const recordLimit = params?.maxRecords ?? Number.POSITIVE_INFINITY;
  const records: MutableRecord[] = [];
  let skippedFrames = 0;

  for (let i = 0; i < starts.length; i += 1) {
    if (records.length >= recordLimit || i >= frameLimit) {
      break;
    }
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length;
    let text: string;
    try {
      text = zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    } catch {
      // 压缩数据内部理论上可能出现 magic 字节序列导致切错帧；半写 frame 也会解压失败。
      // 跳过该帧并计数，其余帧继续。
      skippedFrames += 1;
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (isObjectRecord(parsed)) {
          records.push(parsed);
          if (records.length >= recordLimit) {
            break;
          }
        }
      } catch {
        skippedFrames += 1;
      }
    }
  }

  if (skippedFrames > 0) {
    logger.warn(undefined, `DSH 会话日志存在跳过的 frame/行 count=${skippedFrames}`);
  }
  return { records, skippedFrames };
}

/** 全量读取会话日志（导入路径）。 */
export async function readDshSessionLog(filePath: string): Promise<MutableRecord[]> {
  const result = parseDshSessionLogBuffer(await readFile(filePath));
  return result.records;
}

/**
 * 只解压头部若干帧（扫描路径的轻量读取）：拿 session 头（cwd/createdAt）
 * 以及尽量早出现的 session/title 与首条 user/message 预览。
 */
export async function readDshSessionLogHead(
  filePath: string,
  maxFrames = 64,
): Promise<MutableRecord[]> {
  const result = parseDshSessionLogBuffer(await readFile(filePath), { maxFrames });
  return result.records;
}
