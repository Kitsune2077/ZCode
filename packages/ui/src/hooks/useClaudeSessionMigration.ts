import { useCallback, useEffect, useMemo, useState } from "react";
import type { ZCodeImportSessionsResult, ZCodeImportableSessionCandidate } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { invalidateTaskQueryCacheByScopes } from "@/store/taskQueryCacheStore.js";

export type ClaudeMigrationRange = "all" | "7d" | "30d" | "90d";
type ClaudeMigrationWorkspaceFilterMode = "all" | "current";
/** 迁移来源 provider；缺省 claude 保持 Onboarding 既有行为不变。 */
export type SessionMigrationProvider = "claude" | "openCode" | "deepseekHarness";

const DEFAULT_LIMIT = 100;
const MAX_SCAN_LIMIT = 500;
export const UNLIMITED_SCAN_LIMIT_INPUT = "unlimited";

const RANGE_TO_DURATION_MS: Record<Exclude<ClaudeMigrationRange, "all">, number> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

function resolveModifiedSince(range: ClaudeMigrationRange): number | undefined {
  if (range === "all") {
    return undefined;
  }

  return Date.now() - RANGE_TO_DURATION_MS[range];
}

function resolveClaudeMigrationScanLimit(limitInput: string): number | undefined {
  if (limitInput === UNLIMITED_SCAN_LIMIT_INPUT) {
    return undefined;
  }

  const parsed = Number.parseInt(limitInput.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_SCAN_LIMIT);
}

export interface ClaudeSessionMigrationSupportState {
  supported: boolean;
  reason?: "desktopOnly";
}

function normalizeWorkspaceFilterMode(
  mode: ClaudeMigrationWorkspaceFilterMode,
  workspacePath: string | null,
): ClaudeMigrationWorkspaceFilterMode {
  if (mode === "current" && !workspacePath) {
    return "all";
  }

  return mode;
}

export function useClaudeSessionMigration(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
  provider?: SessionMigrationProvider;
}) {
  const provider = params.provider ?? "claude";
  const providerLabel =
    provider === "openCode" ? "OpenCode" : provider === "deepseekHarness" ? "DSH" : "Claude";
  const zcodeTaskService = useZCodeTaskService(
    params.workspacePath ?? undefined,
    undefined,
    params.workspaceIdentity,
  );
  const tabStoreApi = useTabStoreApi();
  const [workspaceFilterModeState, setWorkspaceFilterModeState] =
    useState<ClaudeMigrationWorkspaceFilterMode>("all");
  const [range, setRange] = useState<ClaudeMigrationRange>("30d");
  const [limitInput, setLimitInput] = useState(String(DEFAULT_LIMIT));
  const [candidates, setCandidates] = useState<ZCodeImportableSessionCandidate[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [lastImportResult, setLastImportResult] = useState<ZCodeImportSessionsResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const workspaceFilterMode = useMemo(
    () => normalizeWorkspaceFilterMode(workspaceFilterModeState, params.workspacePath),
    [workspaceFilterModeState, params.workspacePath],
  );

  const effectiveWorkspacePath = useMemo(
    () => (workspaceFilterMode === "current" ? (params.workspacePath ?? undefined) : undefined),
    [workspaceFilterMode, params.workspacePath],
  );
  const effectiveWorkspaceIdentity = useMemo(
    () =>
      workspaceFilterMode === "current" ? params.workspaceIdentity?.trim() || undefined : undefined,
    [params.workspaceIdentity, workspaceFilterMode],
  );

  const supportState = useMemo<ClaudeSessionMigrationSupportState>(() => {
    // 关键业务逻辑：原生历史迁移读取的是“当前机器上的本地来源目录”
    // （Claude: ~/.claude/projects；OpenCode: ~/.local/share/opencode/opencode.db）。
    // 因此这里只拦 web 场景；workspace 现在只是可选筛选条件，不再决定能力是否可用。
    if (!params.isDesktop) {
      return {
        supported: false,
        reason: "desktopOnly",
      };
    }

    return {
      supported: true,
    };
  }, [params.isDesktop]);

  // 切换来源 provider 时旧候选/勾选/结果全部失效，避免把 Claude 的勾选带进 OpenCode 导入。
  useEffect(() => {
    setCandidates([]);
    setSelectedSessionIds([]);
    setScanError(null);
    setImportError(null);
    setLastImportResult(null);
  }, [provider]);

  const scanLimit = useMemo(() => resolveClaudeMigrationScanLimit(limitInput), [limitInput]);

  const setWorkspaceFilterMode = useCallback(
    (mode: ClaudeMigrationWorkspaceFilterMode) => {
      setWorkspaceFilterModeState(normalizeWorkspaceFilterMode(mode, params.workspacePath));
    },
    [params.workspacePath],
  );

  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((previous) => {
      if (previous.includes(sessionId)) {
        return previous.filter((current) => current !== sessionId);
      }

      return [...previous, sessionId];
    });
  }, []);

  const selectAllSessions = useCallback(() => {
    setSelectedSessionIds(candidates.map((candidate) => candidate.sessionId));
  }, [candidates]);

  const clearSelectedSessions = useCallback(() => {
    setSelectedSessionIds([]);
  }, []);

  const scan = useCallback(async () => {
    if (!supportState.supported) {
      return;
    }

    setIsScanning(true);
    setScanError(null);

    try {
      logger.info(
        `[Migration] 开始扫描 ${providerLabel} 原生历史 workspaceFilter=${effectiveWorkspacePath ?? "all"} range=${range} limit=${scanLimit ?? "unlimited"}`,
      );
      const scanParams = {
        workspacePath: effectiveWorkspacePath,
        ...(effectiveWorkspaceIdentity ? { workspaceIdentity: effectiveWorkspaceIdentity } : {}),
        modifiedSince: resolveModifiedSince(range),
        ...(scanLimit === undefined ? {} : { limit: scanLimit }),
      };
      const nextCandidates =
        provider === "openCode"
          ? await zcodeTaskService.scanImportableOpenCodeSessions(scanParams)
          : provider === "deepseekHarness"
            ? await zcodeTaskService.scanImportableDshSessions(scanParams)
            : await zcodeTaskService.scanImportableClaudeSessions(scanParams);
      setCandidates(nextCandidates);
      // 关键业务逻辑：重扫后只保留仍然可见的勾选项。
      // 这样用户调筛选条件或刷新结果时，不会把已经不在当前列表里的旧 session 混进导入请求。
      setSelectedSessionIds((previous) =>
        previous.filter((sessionId) =>
          nextCandidates.some((candidate) => candidate.sessionId === sessionId),
        ),
      );
      logger.info(
        `[Migration] ${providerLabel} 原生历史扫描完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} count=${nextCandidates.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Migration] 扫描 ${providerLabel} 原生历史失败`, error);
      setScanError(message);
    } finally {
      setIsScanning(false);
    }
  }, [
    zcodeTaskService,
    effectiveWorkspaceIdentity,
    effectiveWorkspacePath,
    provider,
    providerLabel,
    range,
    scanLimit,
    supportState.supported,
  ]);

  const importSessions = useCallback(
    async (sessionIds: string[]) => {
      if (!supportState.supported || sessionIds.length === 0) {
        return null;
      }

      setIsImporting(true);
      setImportError(null);

      try {
        logger.info(
          `[Migration] 开始导入 ${providerLabel} 原生历史 workspaceFilter=${effectiveWorkspacePath ?? "all"} selected=${sessionIds.length}`,
        );
        const importParams = {
          workspacePath: effectiveWorkspacePath,
          ...(effectiveWorkspaceIdentity ? { workspaceIdentity: effectiveWorkspaceIdentity } : {}),
          sessionIds,
        };
        const result =
          provider === "openCode"
            ? await zcodeTaskService.importOpenCodeSessions(importParams)
            : provider === "deepseekHarness"
              ? await zcodeTaskService.importDshSessions(importParams)
              : await zcodeTaskService.importClaudeSessions(importParams);
        setLastImportResult(result);
        const handledSessionIds = new Set([
          ...result.imported.map((item) => item.sessionId),
          ...result.skipped.map((item) => item.sessionId),
          ...result.failed.map((item) => item.sessionId),
        ]);
        setSelectedSessionIds((previous) =>
          previous.filter((sessionId) => !handledSessionIds.has(sessionId)),
        );
        if (result.imported.length > 0) {
          const importedWorkspacePaths = new Set(result.imported.map((item) => item.workspacePath));
          // 早期迁移实现通过 bumpTaskListVersion 让各处任务列表整轮重查，
          // 但这里真正需要的只是把受影响 workspace 的查询结果失效并重新拉取。
          // 改成局部失效后，仍然能让新导入任务出现在侧边栏，同时避免把无关 workspace 一起带着刷新。
          const importedWorkspaceScopes = result.imported.map((item) => ({
            workspacePath: item.workspacePath,
          }));
          for (const workspacePath of importedWorkspacePaths) {
            tabStoreApi.getState().ensureWorkspaceTab(workspacePath);
          }
          invalidateTaskQueryCacheByScopes(importedWorkspaceScopes);
        }
        logger.info(
          `[Migration] ${providerLabel} 原生历史导入完成 workspaceFilter=${effectiveWorkspacePath ?? "all"} imported=${result.imported.length} skipped=${result.skipped.length} failed=${result.failed.length}`,
        );
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Migration] 导入 ${providerLabel} 原生历史失败`, error);
        setImportError(message);
        return null;
      } finally {
        setIsImporting(false);
      }
    },
    [
      zcodeTaskService,
      effectiveWorkspaceIdentity,
      effectiveWorkspacePath,
      provider,
      providerLabel,
      supportState.supported,
      tabStoreApi,
    ],
  );

  const importSelectedSessions = useCallback(async () => {
    return importSessions(selectedSessionIds);
  }, [importSessions, selectedSessionIds]);

  return {
    supportState,
    workspaceFilterMode,
    setWorkspaceFilterMode,
    hasCurrentWorkspaceFilter: params.workspacePath !== null,
    range,
    setRange,
    limitInput,
    setLimitInput,
    scanLimit,
    candidates,
    selectedSessionIds,
    selectedCount: selectedSessionIds.length,
    scanError,
    importError,
    lastImportResult,
    isScanning,
    isImporting,
    scan,
    importSessions,
    importSelectedSessions,
    toggleSessionSelection,
    selectAllSessions,
    clearSelectedSessions,
  };
}
