import type { CustomPublishOptions } from "builder-util-runtime";
import type { AppUpdater, ResolvedUpdateFileInfo, UpdateInfo } from "electron-updater";
import { Provider } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, type ElectronReleaseChannel } from "@zcode/shared";
import {
  buildElectronManifestUrl,
  getElectronReleasePlatform,
  getLinuxUpdateExtensions,
  normalizeReleaseChannel,
  resolveUpdateFilesAgainstBaseUrl,
} from "./manifestUpdateProvider.js";
import { parse as parseYaml } from "yaml";

/**
 * GitHub / Gitea Release 作为自定义更新源（docs/auto-update.md「自定义更新源」）。
 *
 * 与官方 manifest provider 的差异：更新事实不是服务端 manifest，而是用户配置仓库的
 * Release 附件——releases API 按通道选 Release，下载附件中的 electron-builder 通用
 * 清单（stable `latest.yml` / preview `beta.yml`），安装包 URL 按附件所在目录解析。
 * GitHub 与 Gitea 的 releases API 响应按兼容字段消费，附件 URL 两者同为
 * `.../releases/download/{tag}/{file}` 形态，相对路径解析规则一致。
 */

export interface ReleaseFeedSource {
  readonly kind: "github" | "gitea";
  /** releases 列表 API 的完整 URL。 */
  readonly releasesApiUrl: string;
  readonly owner: string;
  readonly repo: string;
}

export interface ReleaseFeedAssetLike {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
}

export interface ReleaseFeedReleaseLike {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly body?: unknown;
  readonly name?: unknown;
  readonly assets?: readonly ReleaseFeedAssetLike[];
}

const GITHUB_API_ORIGIN = "https://api.github.com";
const RELEASES_LIST_LIMIT = 15;

/** electron-builder 各通道的更新清单附件名；preview 发布走 beta 通道。 */
function updateInfoAssetNameForChannel(channel: ElectronReleaseChannel): string[] {
  return channel === "preview" ? ["beta.yml", "latest.yml"] : ["latest.yml"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/^www\./u, "");
}

/**
 * 解析用户输入的自定义更新源。`owner/repo`（无主机）与 `github.com/owner/repo` 视为
 * GitHub；其它 http(s) 主机按 Gitea 处理。允许尾部 `/releases`（仓库页粘贴容错）；
 * 路径段数不是 2（或 3 且首段为主机）时视为无效，返回 null 由调用方回退官方源。
 */
export function parseReleaseFeedSource(rawInput: string): ReleaseFeedSource | null {
  let input = rawInput.trim();
  if (input.length === 0) return null;
  input = input.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, "").replace(/\/+$/u, "");
  if (input.toLowerCase().endsWith("/releases")) {
    input = input.slice(0, -"/releases".length);
  }
  if (input.length === 0) return null;

  const segments = input.split("/").filter((segment) => segment.length > 0);
  let kind: "github" | "gitea";
  let hostIndex = 0;
  const firstHost = normalizeHost(segments[0] ?? "");
  if (firstHost === "github.com") {
    kind = "github";
    hostIndex = 1;
  } else if (segments.length >= 3 && firstHost.includes(".")) {
    kind = "gitea";
    hostIndex = 1;
  } else if (segments.length === 2) {
    // 无主机前缀：按最常用的 GitHub 处理。
    kind = "github";
  } else {
    return null;
  }

  // 严格限定 host(可选) + owner/repo 三段以内：多余路径段（子路径部署、深层链接）
  // 一律拒绝而不是静默截断，避免把错误输入解析成另一个仓库。
  if (segments.length !== hostIndex + 2) return null;
  const [owner, repo] = segments.slice(hostIndex);
  if (!owner || !repo || owner.length === 0 || repo.length === 0) return null;
  const cleanRepo = repo.replace(/\.git$/iu, "");
  if (cleanRepo.length === 0) return null;

  if (kind === "github") {
    return {
      kind,
      owner,
      repo: cleanRepo,
      releasesApiUrl: `${GITHUB_API_ORIGIN}/repos/${owner}/${cleanRepo}/releases?per_page=${RELEASES_LIST_LIMIT}`,
    };
  }
  // Gitea：主机可能是带端口/子路径的自建部署；子路径场景要求用户输入完整 origin + 路径，
  // 这里把首段之外的主机段原样拼回（host/owner/repo 中 host 只取一段的常见形态直接可用）。
  const origin = `https://${segments.slice(0, hostIndex).join("/")}`;
  return {
    kind,
    owner,
    repo: cleanRepo,
    releasesApiUrl: `${origin}/api/v1/repos/${owner}/${cleanRepo}/releases?limit=${RELEASES_LIST_LIMIT}`,
  };
}

function isNonDraftRelease(release: ReleaseFeedReleaseLike): boolean {
  return release.draft !== true;
}

/**
 * 按通道选择 Release：列表新→旧，取第一个非 draft；stable 额外要求非 prerelease，
 * preview 允许 prerelease（自定义源没有官方的服务端通道隔离，用 prerelease 标记区分）。
 */
export function selectReleaseForChannel(
  releases: readonly ReleaseFeedReleaseLike[],
  channel: ElectronReleaseChannel,
): ReleaseFeedReleaseLike | null {
  for (const release of releases) {
    if (!isRecord(release) || !isNonDraftRelease(release)) continue;
    if (channel === "stable" && release.prerelease === true) continue;
    return release;
  }
  return null;
}

/** 在 Release 附件里定位更新清单（preview 缺 beta.yml 时回退 latest.yml）。 */
export function findUpdateInfoAsset(
  assets: readonly ReleaseFeedAssetLike[] | undefined,
  channel: ElectronReleaseChannel,
): ReleaseFeedAssetLike | null {
  const candidates = updateInfoAssetNameForChannel(channel);
  for (const assetName of candidates) {
    for (const asset of assets ?? []) {
      if (
        isRecord(asset) &&
        typeof asset.name === "string" &&
        asset.name.toLowerCase() === assetName &&
        typeof asset.browser_download_url === "string" &&
        asset.browser_download_url.length > 0
      ) {
        return asset as unknown as ReleaseFeedAssetLike & {
          name: string;
          browser_download_url: string;
        };
      }
    }
  }
  return null;
}

export interface ParsedReleaseUpdateInfo {
  readonly updateInfo: UpdateInfo;
  /** 附件所在目录：清单内相对 URL 的解析基准。 */
  readonly baseUrl: URL;
}

/** 官方 manifest 说明回退的产物：与 electron-updater UpdateInfo 的扩展字段同形。 */
export interface OfficialReleaseNotesFallback {
  releaseNotes?: string;
  releaseNotesByLocale?: Record<string, unknown>;
}

/**
 * 从官方 manifest YAML 中提取与本次更新版本一致的更新说明（纯函数）。
 *
 * 官方 manifest 只返回各通道"最新版"，没有按版本查询；因此仅当 `manifest.version` 与
 * `version` 完全一致时才采用其 `releaseNotes` / `releaseNotesByLocale`，避免把官方
 * 另一个版本的说明错配到自定义源的发布上。版本不一致 / 无说明字段 / 响应非法一律
 * 返回 null，由调用方继续探测下一通道或静默跳过。
 */
export function extractOfficialReleaseNotesForVersion(input: {
  manifestYaml: string;
  version: string;
}): OfficialReleaseNotesFallback | null {
  if (!input.version || !input.manifestYaml.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(input.manifestYaml);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== input.version) {
    return null;
  }
  const fallback: OfficialReleaseNotesFallback = {};
  if (typeof parsed.releaseNotes === "string" && parsed.releaseNotes.trim()) {
    fallback.releaseNotes = parsed.releaseNotes;
  }
  if (isRecord(parsed.releaseNotesByLocale)) {
    fallback.releaseNotesByLocale = parsed.releaseNotesByLocale;
  }
  return fallback.releaseNotes || fallback.releaseNotesByLocale ? fallback : null;
}

/**
 * 解析 Release 附件中的 electron-builder 更新清单为 electron-updater UpdateInfo；
 * 清单缺 releaseNotes 时回退 Release 正文，保证更新弹窗有内容可展示。
 */
export function parseReleaseUpdateInfo(input: {
  release: ReleaseFeedReleaseLike;
  channel: ElectronReleaseChannel;
  updateInfoYaml: string;
  updateInfoAssetUrl: string;
}): ParsedReleaseUpdateInfo {
  const parsed = parseYaml(input.updateInfoYaml);
  if (!isRecord(parsed) || typeof parsed.version !== "string") {
    throw new Error(`Invalid release update info file: ${input.updateInfoAssetUrl}`);
  }
  const baseUrl = new URL("./", input.updateInfoAssetUrl);
  const updateInfo = {
    ...parsed,
    // 自定义源没有官方通道隔离；把本次请求通道带回 UpdateInfo，供 autoUpdater 识别过期结果。
    zcodeReleaseChannel: input.channel,
  } as unknown as UpdateInfo;
  if (!updateInfo.releaseNotes && typeof input.release.body === "string" && input.release.body.trim()) {
    updateInfo.releaseNotes = input.release.body;
  }
  if (!updateInfo.releaseName && typeof input.release.name === "string" && input.release.name.trim()) {
    updateInfo.releaseName = input.release.name.trim();
  }
  return { updateInfo, baseUrl };
}

export interface ReleaseFeedProviderOptions extends CustomPublishOptions {
  // electron-updater 的 setFeedURL 只按 CustomPublishOptions 校验 updateProvider 构造器，
  // 扩展属性必须全部可选，真正装配时由 autoUpdater 恒定传入 releaseFeed。
  readonly releaseFeed?: ReleaseFeedSource;
  readonly resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
  /** 装配方传入的发布平台（`windows-x86_64` 形态）；官方说明回退按它拼 manifest 查询。 */
  readonly releasePlatform?: string;
  /** 官方说明回退的 endpoint 覆盖（测试注入用）；默认官方生产 endpoint。 */
  readonly resolveOfficialNotesEndpointOrigin?: () => string | Promise<string>;
}

/** 官方 manifest 探测顺序：先当前通道，再另一通道——官方灰度可能只发 preview。 */
function officialNotesProbeChannels(channel: ElectronReleaseChannel): ElectronReleaseChannel[] {
  return channel === "preview" ? ["preview", "stable"] : ["stable", "preview"];
}

function updateInfoHasReleaseNotes(updateInfo: UpdateInfo): boolean {
  if (typeof updateInfo.releaseNotes === "string" && updateInfo.releaseNotes.trim()) {
    return true;
  }
  if (Array.isArray(updateInfo.releaseNotes) && updateInfo.releaseNotes.length > 0) {
    return true;
  }
  const byLocale = (updateInfo as UpdateInfo & { releaseNotesByLocale?: unknown })
    .releaseNotesByLocale;
  return isRecord(byLocale) && Object.keys(byLocale).length > 0;
}

export class ReleaseFeedUpdateProvider extends Provider<UpdateInfo> {
  private readonly options: ReleaseFeedProviderOptions;
  private readonly linuxExtensions: readonly string[] | null;
  private resolveFilesBaseUrl = new URL("https://github.com/");
  /**
   * 官方说明回退的结果缓存（含 null = 探测过但无匹配），键 `endpoint|platform|version`。
   * 更新检查约 15 分钟轮询一次，缓存避免每次都多打官方 manifest；
   * 版本变化后键不同，自动重新探测。
   */
  private readonly officialNotesCache = new Map<string, OfficialReleaseNotesFallback | null>();

  constructor(
    options: ReleaseFeedProviderOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions);
    this.options = options;
    this.linuxExtensions = getLinuxUpdateExtensions(updater);
  }

  override get isUseMultipleRangeRequest(): boolean {
    return false;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const releaseFeed = this.options.releaseFeed;
    if (!releaseFeed) {
      throw new Error("Release feed provider requires a configured releaseFeed");
    }
    const channel = normalizeReleaseChannel(await this.resolveReleaseChannel());
    const releasesRaw = await this.httpRequest(new URL(releaseFeed.releasesApiUrl), {
      accept: "application/vnd.github+json, application/json",
    });
    if (!releasesRaw) {
      throw new Error(`Empty release feed response: ${releaseFeed.releasesApiUrl}`);
    }
    const releases = JSON.parse(releasesRaw);
    if (!Array.isArray(releases)) {
      throw new Error(`Invalid release feed response: ${releaseFeed.releasesApiUrl}`);
    }
    const release = selectReleaseForChannel(releases as ReleaseFeedReleaseLike[], channel);
    if (!release) {
      throw new Error(`Release feed has no ${channel} release: ${releaseFeed.releasesApiUrl}`);
    }
    const asset = findUpdateInfoAsset(release.assets, channel);
    if (!asset) {
      throw new Error(
        `Release ${String(release.tag_name ?? "")} is missing an update info asset (${updateInfoAssetNameForChannel(channel).join(" / ")})`,
      );
    }
    const assetUrl = new URL(String(asset.browser_download_url));
    const updateInfoYaml = await this.httpRequest(assetUrl, {
      accept: "application/x-yaml,text/yaml,text/plain,*/*",
    });
    if (!updateInfoYaml) {
      throw new Error(`Empty update info file: ${assetUrl.toString()}`);
    }
    const parsed = parseReleaseUpdateInfo({
      release,
      channel,
      updateInfoYaml,
      updateInfoAssetUrl: assetUrl.toString(),
    });
    this.resolveFilesBaseUrl = parsed.baseUrl;
    // 更新说明是尽力而为：清单与 Release 正文都没有时，尝试官方 manifest 同版本说明，
    // 任何失败都不影响更新检查结果（spec 见 docs/auto-update.md 更新说明回退链）。
    if (!updateInfoHasReleaseNotes(parsed.updateInfo)) {
      const fallback = await this.fetchOfficialReleaseNotes(parsed.updateInfo.version, channel);
      if (fallback?.releaseNotes) {
        parsed.updateInfo.releaseNotes = fallback.releaseNotes;
      }
      if (fallback?.releaseNotesByLocale) {
        (parsed.updateInfo as UpdateInfo & { releaseNotesByLocale?: Record<string, unknown> })
          .releaseNotesByLocale = fallback.releaseNotesByLocale;
      }
    }
    return parsed.updateInfo;
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return resolveUpdateFilesAgainstBaseUrl(updateInfo, this.resolveFilesBaseUrl, this.linuxExtensions);
  }

  private resolveReleaseChannel(): Promise<ElectronReleaseChannel> {
    return Promise.resolve(this.options.resolveReleaseChannel?.() ?? "stable");
  }

  /**
   * 探测官方 manifest 的同版本更新说明。注意 platform 必须带架构后缀
   * （`windows-x86_64` 形态，见 manifestUpdateProvider.getElectronReleasePlatform），
   * 只传 `windows` 会被官方接口以参数错误拒绝。
   */
  private async fetchOfficialReleaseNotes(
    version: string,
    channel: ElectronReleaseChannel,
  ): Promise<OfficialReleaseNotesFallback | null> {
    const endpointOrigin = (
      (await this.options.resolveOfficialNotesEndpointOrigin?.()) ??
      DEFAULT_ZCODE_ENDPOINT_ORIGIN
    ).trim();
    if (!endpointOrigin) {
      return null;
    }
    const platform = this.options.releasePlatform?.trim() || getElectronReleasePlatform();
    const cacheKey = `${endpointOrigin}|${platform}|${version}`;
    if (this.officialNotesCache.has(cacheKey)) {
      return this.officialNotesCache.get(cacheKey) ?? null;
    }
    let result: OfficialReleaseNotesFallback | null = null;
    for (const probeChannel of officialNotesProbeChannels(channel)) {
      try {
        const manifestUrl = buildElectronManifestUrl({
          endpointOrigin,
          platform,
          channel: probeChannel,
        });
        const raw = await this.httpRequest(manifestUrl, {
          accept: "application/x-yaml,text/yaml,text/plain,*/*",
        });
        if (!raw) {
          continue;
        }
        const fallback = extractOfficialReleaseNotesForVersion({ manifestYaml: raw, version });
        if (fallback) {
          result = fallback;
          break;
        }
      } catch {
        // 网络/解析失败按"该通道无匹配"处理，继续探测另一通道。
      }
    }
    this.officialNotesCache.set(cacheKey, result);
    return result;
  }
}
