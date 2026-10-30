import type { SkillZipImportResult } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface RemoteSkillSyncResultListProps {
  /** 本仓库定制：本地 ZIP 导入结果沿用该列表渲染（上游 3.17 已移除旧的同步结果类型）。 */
  result: SkillZipImportResult | null;
  /** 完成/状态文案可通过可选前缀换成导入等其他动作语义，默认保持远端同步文案。 */
  completeMessageId?: string;
  statusMessageIdPrefix?: string;
}

export function RemoteSkillSyncResultList({
  result,
  completeMessageId = "settings.skills.remoteSync.complete",
  statusMessageIdPrefix = "settings.skills.remoteSync",
}: RemoteSkillSyncResultListProps) {
  const { intl } = useZCodeIntl();
  if (!result) {
    return null;
  }

  return (
    <div className="grid gap-2">
      <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground">
        {intl.formatMessage({ id: completeMessageId })}
      </div>
      {result.results.map((item) => (
        <div
          key={item.directoryName}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{item.name}</span>
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: `${statusMessageIdPrefix}.${item.status}` })}
            </span>
          </div>
          {item.error ? (
            <div className="mt-1 break-words text-ui-base text-destructive">{item.error}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
