import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_SYNC_SIZE_LIMIT_ERROR_CODE } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { extractSkillZipArchive } from "../src/skill-sync/skillZipArchive.js";

async function tempDir(prefix: string) {
  return await mkdtemp(join(tmpdir(), prefix));
}

interface ZipTestEntry {
  name: string;
  content: Buffer;
  flags?: number;
  externalAttrs?: number;
  /** 覆盖声明压缩大小；加密 stored 条目需为 content 长度 + 12 字节加密头才能通过 yauzl 的入口校验。 */
  declaredCompressedSize?: number;
}

// 测试专用最小 ZIP（stored）构造器：yazl 会拒绝非法路径，
// 穿越路径、符号链接条目、加密标志等恶意样本必须手工拼字节才能构造。
function buildStoredZip(entries: readonly ZipTestEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const centralDirectoryEntries: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const crc32 = computeCrc32(entry.content);
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const declaredCompressedSize = entry.declaredCompressedSize ?? entry.content.length;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(entry.flags ?? 0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(declaredCompressedSize, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    chunks.push(localHeader, nameBuffer, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.flags ?? 0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc32, 16);
    centralHeader.writeUInt32LE(declaredCompressedSize, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.externalAttrs ?? 0o100644 * 0x10000, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectoryEntries.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + entry.content.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralDirectoryEntries);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(centralDirectoryOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...chunks, centralDirectory, endRecord]));
}

// 测试环境不依赖 Node 版本里 zlib.crc32 的可用性，直接内置表驱动 CRC-32。
function computeCrc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name: string, text: string, extra: Partial<ZipTestEntry> = {}): ZipTestEntry {
  return { name, content: Buffer.from(text, "utf8"), ...extra };
}

describe("skill zip archive", () => {
  it("extracts skill directories from file-only entries without explicit directory records", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([
      zipEntry("review/SKILL.md", "---\nname: review\n---\nbody"),
      zipEntry("review/notes.txt", "hello"),
      zipEntry("docs/SKILL.md", "---\nname: docs\n---\nbody"),
    ]);

    await extractSkillZipArchive(archive, join(root, "out"));

    await expect(readFile(join(root, "out", "review", "SKILL.md"), "utf-8")).resolves.toContain(
      "name: review",
    );
    await expect(readFile(join(root, "out", "review", "notes.txt"), "utf-8")).resolves.toBe(
      "hello",
    );
    await expect(readFile(join(root, "out", "docs", "SKILL.md"), "utf-8")).resolves.toContain(
      "name: docs",
    );
  });

  // yauzl 在派发 entry 事件前就拒绝穿越/绝对路径；extractSkillZipArchive 内的
  // normalizeSkillSyncRelativePath 是第二道防线（负责保留名、`.`/空段等 yauzl 不查的形态）。
  it("rejects path traversal entry names", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([zipEntry("../evil.txt", "boom")]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow(
      "invalid relative path: ../evil.txt",
    );
  });

  it("rejects absolute entry paths", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([zipEntry("/etc/evil.txt", "boom")]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow(
      "absolute path: /etc/evil.txt",
    );
  });

  it("rejects backslash entry paths", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([zipEntry("dir\\evil.txt", "boom")]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow();
  });

  it("rejects symlink entries declared through unix file type bits", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([
      zipEntry("link", "/etc/passwd", { externalAttrs: 0o120777 * 0x10000 }),
    ]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow(
      "unsupported skill zip archive entry type",
    );
  });

  it("rejects encrypted entries", async () => {
    const root = await tempDir("zcode-skill-zip-");
    // 传统 ZipCrypto 会在文件数据前加 12 字节头，声明压缩大小需包含该头
    // 才能通过 yauzl 的大小校验、走到本实现的加密拒绝分支。
    const content = Buffer.from("boom", "utf8");
    const archive = buildStoredZip([
      {
        name: "secret.txt",
        content,
        flags: 1,
        declaredCompressedSize: content.length + 12,
      },
    ]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow(
      "encrypted skill zip archive entries are not supported",
    );
  });

  it("rejects windows reserved device names in any path segment", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([zipEntry("aux/SKILL.md", "body")]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow(
      "unsafe skill zip archive path",
    );
  });

  it("rejects entry counts beyond the configured limit", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip(
      Array.from({ length: 5 }, (_, index) => zipEntry(`file-${index}.txt`, "a")),
    );

    await expect(
      extractSkillZipArchive(archive, join(root, "out"), { maxEntries: 4 }),
    ).rejects.toThrow("too many entries");
  });

  it("reports a structured error when extracted content exceeds the size limit", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([zipEntry("review/large.txt", "a".repeat(4096))]);

    await expect(
      extractSkillZipArchive(archive, join(root, "out"), { maxExtractedBytes: 1024 }),
    ).rejects.toMatchObject({
      code: SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
      data: {
        actualBytes: expect.any(Number),
        maxBytes: 1024,
        phase: "extracted-content",
      },
    });
  });

  it("accepts many small entries when total content stays within the limit", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const fileCount = 300;
    const archive = buildStoredZip(
      Array.from({ length: fileCount }, (_, index) => zipEntry(`file-${index}.txt`, "a")),
    );

    await expect(
      extractSkillZipArchive(archive, join(root, "out"), {
        maxExtractedBytes: fileCount,
        maxEntries: fileCount,
      }),
    ).resolves.toBeUndefined();
    await expect(readFile(join(root, "out", "file-299.txt"), "utf-8")).resolves.toBe("a");
  });

  it("rejects duplicate entry names instead of overwriting", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const archive = buildStoredZip([
      zipEntry("review/SKILL.md", "first"),
      zipEntry("review/SKILL.md", "second"),
    ]);

    await expect(extractSkillZipArchive(archive, join(root, "out"))).rejects.toThrow();
  });

  it("rejects archives that are not zip files", async () => {
    const root = await tempDir("zcode-skill-zip-");
    const target = join(root, "out");
    await mkdir(target, { recursive: true });

    await expect(
      extractSkillZipArchive(new Uint8Array(Buffer.from("plain text", "utf8")), target),
    ).rejects.toThrow();
  });
});
