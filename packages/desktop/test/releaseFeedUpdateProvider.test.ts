import { NsisUpdater } from "electron-updater";
import { describe, expect, it } from "vitest";
import {
  findUpdateInfoAsset,
  parseReleaseFeedSource,
  parseReleaseUpdateInfo,
  ReleaseFeedUpdateProvider,
  selectReleaseForChannel,
  type ReleaseFeedReleaseLike,
} from "@desktop/main/releaseFeedUpdateProvider.js";

describe("parseReleaseFeedSource", () => {
  it("owner/repo 无主机前缀时视为 GitHub", () => {
    const source = parseReleaseFeedSource("Kitsune2077/ZCode");
    expect(source).toMatchObject({
      kind: "github",
      owner: "Kitsune2077",
      repo: "ZCode",
      releasesApiUrl: "https://api.github.com/repos/Kitsune2077/ZCode/releases?per_page=15",
    });
  });

  it("github.com 各种写法（协议/www/尾斜杠/releases 后缀/.git 后缀）都归一到 GitHub API", () => {
    for (const input of [
      "github.com/owner/repo",
      "https://github.com/owner/repo",
      "https://www.github.com/owner/repo/",
      "https://github.com/owner/repo/releases",
      "https://github.com/owner/repo.git",
    ]) {
      expect(parseReleaseFeedSource(input)).toMatchObject({
        kind: "github",
        owner: "owner",
        repo: "repo",
        releasesApiUrl: "https://api.github.com/repos/owner/repo/releases?per_page=15",
      });
    }
  });

  it("非 github 主机按 Gitea 处理并指向 /api/v1", () => {
    for (const input of [
      "gitea.example.com/owner/repo",
      "https://gitea.example.com/owner/repo",
      "http://192.168.1.10:3000/owner/repo",
    ]) {
      expect(parseReleaseFeedSource(input)).toMatchObject({
        kind: "gitea",
        owner: "owner",
        repo: "repo",
        releasesApiUrl: expect.stringContaining("/api/v1/repos/owner/repo/releases?"),
      });
    }
  });

  it("非法输入返回 null：空串/单段/过深路径/仅主机", () => {
    expect(parseReleaseFeedSource("")).toBeNull();
    expect(parseReleaseFeedSource("  ")).toBeNull();
    expect(parseReleaseFeedSource("onlyowner")).toBeNull();
    expect(parseReleaseFeedSource("github.com/owner")).toBeNull();
    expect(parseReleaseFeedSource("https://git.example.com/gitea/owner/repo")).toBeNull();
    expect(parseReleaseFeedSource("https://github.com/owner/repo/releases/tag/v1.0.0")).toBeNull();
  });
});

describe("selectReleaseForChannel", () => {
  const releases: ReleaseFeedReleaseLike[] = [
    { tag_name: "v3.1.0-beta.1", draft: false, prerelease: true },
    { tag_name: "v3.0.0", draft: false, prerelease: false },
    { tag_name: "v2.9.0-rc.1", draft: false, prerelease: true },
    { tag_name: "v2.8.0", draft: true, prerelease: false },
  ];

  it("stable 取第一个非 draft 非 prerelease", () => {
    expect(selectReleaseForChannel(releases, "stable")?.tag_name).toBe("v3.0.0");
  });

  it("preview 允许 prerelease，仍拒绝 draft", () => {
    expect(selectReleaseForChannel(releases, "preview")?.tag_name).toBe("v3.1.0-beta.1");
  });

  it("没有可用 Release 时返回 null", () => {
    expect(selectReleaseForChannel([{ draft: true }], "stable")).toBeNull();
    expect(selectReleaseForChannel([], "preview")).toBeNull();
  });
});

describe("findUpdateInfoAsset", () => {
  const assets = [
    { name: "ZCode-Setup.exe", browser_download_url: "https://x/releases/download/v1/a.exe" },
    { name: "latest.yml", browser_download_url: "https://x/releases/download/v1/latest.yml" },
    { name: "beta.yml", browser_download_url: "https://x/releases/download/v1/beta.yml" },
  ];

  it("stable 找 latest.yml", () => {
    expect(findUpdateInfoAsset(assets, "stable")?.name).toBe("latest.yml");
  });

  it("preview 优先 beta.yml，缺失时回退 latest.yml", () => {
    expect(findUpdateInfoAsset(assets, "preview")?.name).toBe("beta.yml");
    expect(findUpdateInfoAsset([assets[0]!, assets[1]!], "preview")?.name).toBe("latest.yml");
  });

  it("清单附件缺失或下载地址为空时返回 null", () => {
    expect(findUpdateInfoAsset([{ name: "readme.txt" }], "stable")).toBeNull();
    expect(findUpdateInfoAsset(undefined, "stable")).toBeNull();
  });
});

describe("parseReleaseUpdateInfo", () => {
  const release = {
    tag_name: "v3.1.0",
    name: "v3.1.0 代号发布",
    body: "## 更新内容\n- 修复若干问题",
    draft: false,
    prerelease: false,
  };
  const yaml = [
    "version: 3.1.0",
    "path: ZCode-Setup-3.1.0.exe",
    "files:",
    "  - url: ZCode-Setup-3.1.0.exe",
    "    sha512: c2hhNTEy",
    "    size: 149000000",
    "releaseDate: '2026-10-20T00:00:00.000Z'",
  ].join("\n");
  const assetUrl = "https://github.com/owner/repo/releases/download/v3.1.0/latest.yml";

  it("解析清单为 UpdateInfo，文件 URL 按附件目录解析，通道随结果带回", () => {
    const parsed = parseReleaseUpdateInfo({
      release,
      channel: "stable",
      updateInfoYaml: yaml,
      updateInfoAssetUrl: assetUrl,
    });

    expect(parsed.updateInfo.version).toBe("3.1.0");
    expect(parsed.updateInfo.files?.[0]?.url).toBe("ZCode-Setup-3.1.0.exe");
    expect(parsed.baseUrl.href).toBe(
      "https://github.com/owner/repo/releases/download/v3.1.0/",
    );
    expect(parsed.updateInfo.zcodeReleaseChannel).toBe("stable");
  });

  it("清单缺 releaseNotes 时回退 Release 正文与名称", () => {
    const parsed = parseReleaseUpdateInfo({
      release,
      channel: "preview",
      updateInfoYaml: yaml,
      updateInfoAssetUrl: assetUrl,
    });

    expect(parsed.updateInfo.releaseNotes).toContain("更新内容");
    expect(parsed.updateInfo.releaseName).toBe("v3.1.0 代号发布");
  });

  it("缺少 version 字段的清单抛错", () => {
    expect(() =>
      parseReleaseUpdateInfo({
        release,
        channel: "stable",
        updateInfoYaml: "foo: bar",
        updateInfoAssetUrl: assetUrl,
      }),
    ).toThrow(/Invalid release update info file/);
  });
});

describe("ReleaseFeedUpdateProvider.resolveFiles", () => {
  it("相对文件 URL 按附件目录解析并要求校验和", () => {
    const provider = new ReleaseFeedUpdateProvider(
      {
        provider: "custom",
        releaseFeed: parseReleaseFeedSource("github.com/owner/repo")!,
      },
      Object.create(NsisUpdater.prototype),
      { platform: "win32", isUseMultipleRangeRequest: false, executor: {} as never },
    );
    // baseUrl 由 getLatestVersion 设置；未检查前默认官方占位，这里只验证解析语义。
    (
      provider as unknown as { resolveFilesBaseUrl: URL }
    ).resolveFilesBaseUrl = new URL("https://github.com/owner/repo/releases/download/v3.1.0/");

    const resolved = provider.resolveFiles({
      version: "3.1.0",
      files: [{ url: "ZCode-Setup-3.1.0.exe", sha512: "c2hhNTEy" }],
      path: "ZCode-Setup-3.1.0.exe",
      releaseDate: "2026-10-20",
    } as Parameters<typeof provider.resolveFiles>[0]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.url.href).toBe(
      "https://github.com/owner/repo/releases/download/v3.1.0/ZCode-Setup-3.1.0.exe",
    );
    expect(resolved[0]?.info.sha512).toBe("c2hhNTEy");
  });

  it("清单文件缺校验和时抛错（不进入无校验下载）", () => {
    const provider = new ReleaseFeedUpdateProvider(
      { provider: "custom", releaseFeed: parseReleaseFeedSource("github.com/owner/repo")! },
      Object.create(NsisUpdater.prototype),
      { platform: "win32", isUseMultipleRangeRequest: false, executor: {} as never },
    );
    expect(() =>
      provider.resolveFiles({
        version: "3.1.0",
        files: [{ url: "ZCode-Setup-3.1.0.exe" }],
        path: "ZCode-Setup-3.1.0.exe",
        releaseDate: "2026-10-20",
      } as Parameters<typeof provider.resolveFiles>[0]),
    ).toThrow(/missing checksum/);
  });
});
