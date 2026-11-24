import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReleaseNotes } from "./desktop-release-info.mjs";
import {
  extractReleaseNotesFromManifest,
  fetchOfficialReleaseNotes,
} from "./official-release-notes.mjs";

// 保险丝：每个用例都必须注入假 fetch。漏注入时 fetchOfficialReleaseNotes 会退回全局 fetch，
// 真的去请求官方接口——这里让它直接抛错暴露出来，而不是悄悄依赖网络。
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unit test must not hit the network: inject a fake fetch");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 官方 update manifest 的形态：顶层键顶格，releaseNotes 是缩进的块标量。
const manifest = (version, notes = ["- 新功能 A", "", "- 修复 B"]) =>
  [
    `version: ${version}`,
    "files: []",
    "releaseNotes: |",
    ...notes.map((line) => `  ${line}`),
    "path: x.exe",
    "sha512: abc",
  ].join("\n");

const ok = (body) => async () => new Response(body, { status: 200 });
const notFound = async () => new Response("not found", { status: 404 });

const buildInfo = {
  arch: "x64",
  artifacts: [
    {
      form: "安装包（NSIS）",
      kind: "installer",
      name: "ZCode-4.0.0-win-x64.exe",
      sha256: "a".repeat(64),
      sizeBytes: 100 * 1024 * 1024,
    },
    {
      kind: "auxiliary",
      name: "ZCode-4.0.0-win-x64.exe.blockmap",
      sha256: "b".repeat(64),
      sizeBytes: 1024,
    },
  ],
  commit: "0123456789abcdef",
  os: "win",
  remoteAssetsIncluded: false,
  version: "4.0.0",
};

describe("extractReleaseNotesFromManifest", () => {
  it("版本一致时剥离块标量缩进并保留内部空行", () => {
    expect(extractReleaseNotesFromManifest(manifest("4.0.0"), "4.0.0")).toBe(
      "- 新功能 A\n\n- 修复 B",
    );
  });

  it("版本不一致时不采用，避免把相邻版本的说明贴错", () => {
    expect(extractReleaseNotesFromManifest(manifest("4.0.1"), "4.0.0")).toBeNull();
  });

  it("manifest 没有 releaseNotes 块时返回 null", () => {
    expect(extractReleaseNotesFromManifest("version: 4.0.0\nfiles: []\n", "4.0.0")).toBeNull();
  });
});

describe("fetchOfficialReleaseNotes", () => {
  it("stable 通道命中时直接采用，不再请求其它来源", async () => {
    const fetchImpl = vi.fn(ok(manifest("4.0.0")));

    const found = await fetchOfficialReleaseNotes("4.0.0", { fetch: fetchImpl });

    expect(found).toEqual({ notes: "- 新功能 A\n\n- 修复 B", source: "官方 update manifest（stable 通道）" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0].href).toBe(
      "https://zcode.z.ai/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=1",
    );
  });

  it("stable 版本不匹配时继续探测 preview 通道", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(ok(manifest("4.0.1")))
      .mockImplementationOnce(ok(manifest("4.0.0")));

    const found = await fetchOfficialReleaseNotes("4.0.0", { fetch: fetchImpl });

    expect(found.source).toBe("官方 update manifest（preview 通道）");
    expect(fetchImpl.mock.calls[1][0].href).toContain("channel=3");
  });

  it("两个通道都未命中时回退到官方 GitHub Release，并带上令牌", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(notFound)
      .mockImplementationOnce(notFound)
      .mockImplementationOnce(ok(JSON.stringify({ body: "来自 GitHub Release" })));

    const found = await fetchOfficialReleaseNotes("4.0.0", { fetch: fetchImpl, token: "t0ken" });

    expect(found).toEqual({ notes: "来自 GitHub Release", source: "官方 GitHub Release" });
    const [url, init] = fetchImpl.mock.calls[2];
    expect(String(url)).toBe("https://api.github.com/repos/zai-org/ZCode/releases/tags/v4.0.0");
    expect(init.headers.authorization).toBe("Bearer t0ken");
  });

  it("所有来源都未命中时返回 null 而不是抛错", async () => {
    const fetchImpl = vi.fn(notFound);

    await expect(fetchOfficialReleaseNotes("4.0.0", { fetch: fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("网络异常按该来源未命中处理，仍会尝试后续来源", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(notFound)
      .mockImplementationOnce(ok(JSON.stringify({ body: "  来自 GitHub Release \n" })));

    await expect(fetchOfficialReleaseNotes("4.0.0", { fetch: fetchImpl })).resolves.toEqual({
      notes: "来自 GitHub Release",
      source: "官方 GitHub Release",
    });
  });
});

describe("buildReleaseNotes 官方更新日志一节", () => {
  const base = { commit: buildInfo.commit, infos: [buildInfo], runUrl: null };

  it("追加在正文末尾，自带标题降一级成为子标题，代码围栏内不动，节末注明来源", () => {
    const content = buildReleaseNotes({
      ...base,
      officialNotes: [
        "## 新功能",
        "",
        "- 新功能 A",
        "",
        "```sh",
        "# 不是标题",
        "```",
        "",
        "### 修复",
      ].join("\n"),
    });

    const headingAt = content.indexOf("## 官方更新日志（v4.0.0）");
    // 原有内容（产物表格与「说明」）都原样留在这一节之前。
    expect(headingAt).toBeGreaterThan(content.indexOf("| 平台 | 架构 |"));
    expect(headingAt).toBeGreaterThan(content.indexOf("### 说明"));
    expect(content).toContain("## 官方更新日志（v4.0.0）\n\n### 新功能\n\n- 新功能 A\n");
    expect(content).toContain("```sh\n# 不是标题\n```\n\n#### 修复");
    expect(content).toContain("来源：官方 update manifest / GitHub Release");
    expect(content.trimEnd().endsWith("完整变更以本仓库提交记录为准。")).toBe(true);
  });

  it("取不到官方说明时省略整节，其余内容逐字不变", () => {
    const withNotes = buildReleaseNotes({ ...base, officialNotes: "- 新功能 A" });
    const without = buildReleaseNotes({ ...base, officialNotes: null });

    expect(without).not.toContain("官方更新日志");
    // 标题前是一个空行分隔，所以前缀比原正文多两个换行。
    expect(withNotes.slice(0, withNotes.indexOf("## 官方更新日志"))).toBe(`${without}\n\n`);
  });

  it("未传官方说明时同样省略该节", () => {
    expect(buildReleaseNotes(base)).not.toContain("官方更新日志");
  });
});
