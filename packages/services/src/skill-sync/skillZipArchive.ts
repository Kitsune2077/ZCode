import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as yauzl from "yauzl";
import {
  normalizeSkillSyncRelativePath,
  resolveSkillSyncPathWithin,
} from "./skillSyncPath.js";
import { createSkillSyncSizeLimitError } from "./skillSyncErrors.js";

const DEFAULT_MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_ENTRY_PATH_LENGTH = 240;
const UNIX_FILE_TYPE_MASK = 0o170000;

export interface SkillZipArchiveExtractOptions {
  maxExtractedBytes?: number;
  maxEntries?: number;
}

// 用户提供的 ZIP 不可信：路径穿越、符号链接条目、压缩炸弹和 Windows 保留名
// 都必须在解压阶段拒绝，安全面与 cloud-content 的 contentBundleCache 保持一致。
export async function extractSkillZipArchive(
  archive: Uint8Array,
  targetDir: string,
  options: SkillZipArchiveExtractOptions = {},
): Promise<void> {
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });
  const maxExtractedBytes = options.maxExtractedBytes;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;
  const zip = await openZip(archive);
  let extractedBytes = 0;
  let entryCount = 0;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      zip.on("error", rejectPromise);
      zip.on("end", resolvePromise);
      zip.on("entry", (entry: yauzl.Entry) => {
        void (async () => {
          entryCount += 1;
          if (entryCount > maxEntries) {
            throw new Error(`skill zip archive has too many entries: ${maxEntries}`);
          }
          if ((entry.generalPurposeBitFlag & 1) !== 0) {
            throw new Error("encrypted skill zip archive entries are not supported");
          }
          const isDirectory = entry.fileName.endsWith("/");
          const archivePath = normalizeSkillZipEntryPath(entry.fileName);
          assertSafeZipEntrySegments(archivePath);
          const targetPath = resolveWithin(targetRoot, archivePath);
          assertZipUnixFileType(entry, isDirectory);

          // 与 tar 解压一致：先按声明大小做预算检查，再流式读取实际字节兜底，
          // 避免 yauzl 在后台继续解压超大条目。
          const nextExtractedBytes = extractedBytes + entry.uncompressedSize;
          if (
            !Number.isSafeInteger(nextExtractedBytes) ||
            (maxExtractedBytes !== undefined && nextExtractedBytes > maxExtractedBytes)
          ) {
            throw createSkillSyncSizeLimitError({
              actualBytes: nextExtractedBytes,
              maxBytes: maxExtractedBytes ?? Number.MAX_SAFE_INTEGER,
              phase: "extracted-content",
            });
          }

          if (isDirectory) {
            await mkdir(targetPath, { recursive: true });
          } else {
            const stream = await openZipEntryStream(zip, entry);
            const chunks: Buffer[] = [];
            let actualBytes = extractedBytes;
            try {
              for await (const chunk of stream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                actualBytes += buffer.length;
                if (
                  maxExtractedBytes !== undefined &&
                  actualBytes > maxExtractedBytes
                ) {
                  throw createSkillSyncSizeLimitError({
                    actualBytes,
                    maxBytes: maxExtractedBytes,
                    phase: "extracted-content",
                  });
                }
                chunks.push(buffer);
              }
            } finally {
              stream.destroy();
            }
            // 部分压缩工具不写目录条目，只靠 "dir/" 前缀的文件条目表达层级。
            await mkdir(dirname(targetPath), { recursive: true });
            await writeFile(targetPath, Buffer.concat(chunks), { flag: "wx" });
          }
          extractedBytes = nextExtractedBytes;
          zip.readEntry();
        })().catch(rejectPromise);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function openZip(archive: Uint8Array): Promise<yauzl.ZipFile> {
  return new Promise<yauzl.ZipFile>((resolvePromise, rejectPromise) => {
    yauzl.fromBuffer(
      Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength),
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, value) => (error ? rejectPromise(error) : resolvePromise(value)),
    );
  });
}

function openZipEntryStream(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<import("node:stream").Readable> {
  return new Promise<import("node:stream").Readable>((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) =>
      error ? rejectPromise(error) : resolvePromise(stream),
    );
  });
}

function normalizeSkillZipEntryPath(fileName: string): string {
  if (fileName.length > MAX_ZIP_ENTRY_PATH_LENGTH) {
    throw new Error(`skill zip archive path is too long: ${fileName}`);
  }
  return normalizeSkillSyncRelativePath(fileName, {
    unsafePathLabel: "unsafe skill zip archive path",
  });
}

// Windows 文件系统层会吞掉尾随点/空格，且保留设备名无法落盘；
// 与 contentBundleCache 相同的段级校验，避免解压出与归档不一致的目录内容。
function assertSafeZipEntrySegments(archivePath: string): void {
  for (const segment of archivePath.split("/")) {
    if (
      /[. ]$/u.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
    ) {
      throw new Error(`unsafe skill zip archive path: ${archivePath}`);
    }
  }
}

// unix 高 16 位携带类型时，符号链接等特殊条目直接拒绝；
// 类型位缺失（常见于 Windows 压缩工具）时按文件名形态处理，不视为攻击面。
function assertZipUnixFileType(entry: yauzl.Entry, isDirectory: boolean): void {
  const fileType = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
  if (fileType !== 0 && fileType !== (isDirectory ? 0o040000 : 0o100000)) {
    throw new Error(
      `unsupported skill zip archive entry type: ${fileType.toString(8)} (${entry.fileName})`,
    );
  }
}

function resolveWithin(targetRoot: string, archivePath: string): string {
  return resolveSkillSyncPathWithin(targetRoot, archivePath, {
    unsafePathLabel: "unsafe skill zip archive path",
  });
}
