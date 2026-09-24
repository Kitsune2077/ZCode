export type RuntimeToolId = "bfs" | "lark-cli" | "ripgrep" | "ugrep";

export interface RuntimeToolRuntimeDescriptor {
  binaryEnvVar: string;
  bundledResourceDir: string;
  resolveEntrySegments(platform: string): string[];
}

export interface RemoteRuntimeToolDescriptor extends RuntimeToolRuntimeDescriptor {
  versions: Readonly<Partial<Record<string, string>>>;
}

export interface ResolvedRemoteRuntimeTool {
  toolId: RuntimeToolId;
  runtime: RemoteRuntimeToolDescriptor;
  version: string;
}

function resolvePlatformBinaryName(binaryName: string, platform: string): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export const RUNTIME_TOOL_RUNTIME: Record<RuntimeToolId, RuntimeToolRuntimeDescriptor> = {
  bfs: {
    binaryEnvVar: "ZCODE_BFS_BINARY",
    bundledResourceDir: "bfs",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("bfs", platform)],
  },
  "lark-cli": {
    // 飞书 CLI 的原生二进制（上游以 GitHub Release 分发单文件，npm 包只是转发壳）。
    // 桌面端 desktopRuntimeEnv 已按同一个环境变量注入随包路径，这里补上消费方：
    // buildRuntimeToolEnvPatch 解析到二进制后会把所在目录追加进 PATH，插件
    // skills/setup 的 `command -v lark-cli` 因此命中内置副本，跳过 npm 安装，
    // 用户无需预装 Node.js/npm。
    binaryEnvVar: "ZCODE_LARK_CLI_BINARY",
    bundledResourceDir: "lark-cli",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("lark-cli", platform)],
  },
  ripgrep: {
    binaryEnvVar: "ZCODE_RG_BINARY",
    bundledResourceDir: "ripgrep",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("rg", platform)],
  },
  ugrep: {
    binaryEnvVar: "ZCODE_UGREP_BINARY",
    bundledResourceDir: "ugrep",
    resolveEntrySegments: (platform) => [resolvePlatformBinaryName("ugrep", platform)],
  },
};

export const REMOTE_RUNTIME_TOOL_RUNTIME = {
  bfs: {
    ...RUNTIME_TOOL_RUNTIME.bfs,
    versions: {
      linux: "v4.1.1-2",
    },
  },
  "lark-cli": {
    ...RUNTIME_TOOL_RUNTIME["lark-cli"],
    // 只随桌面/本机包内置，不参与远端 workspace 的工具部署：
    // 版本表留空后 getRemoteRuntimeToolsForPlatform 不会产出该工具。
    versions: {},
  },
  ripgrep: {
    ...RUNTIME_TOOL_RUNTIME.ripgrep,
    versions: {
      darwin: "v13.0.0-10",
      linux: "v14.1.1-1",
    },
  },
  ugrep: {
    ...RUNTIME_TOOL_RUNTIME.ugrep,
    versions: {
      linux: "v7.8.4-1",
    },
  },
} as const satisfies Record<RuntimeToolId, RemoteRuntimeToolDescriptor>;

export function getRemoteRuntimeToolsForPlatform(platform: string): ResolvedRemoteRuntimeTool[] {
  // Linux remote 已切到 native-search 三工具，但 Darwin 仍依赖 legacy rg13。
  // 部署集合必须按目标平台解析，不能用一个全局版本把两条发布链互相覆盖。
  return (
    Object.entries(REMOTE_RUNTIME_TOOL_RUNTIME) as Array<
      [RuntimeToolId, RemoteRuntimeToolDescriptor]
    >
  ).flatMap(([toolId, runtime]) => {
    const version = runtime.versions[platform];
    return version ? [{ toolId, runtime, version }] : [];
  });
}

export function getRuntimeToolRuntime(toolId: RuntimeToolId): RuntimeToolRuntimeDescriptor {
  return RUNTIME_TOOL_RUNTIME[toolId];
}
