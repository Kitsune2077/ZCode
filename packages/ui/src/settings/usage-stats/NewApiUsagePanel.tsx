/* oxlint-disable eslint(max-lines) -- NewAPI 用量页集中展示账号卡片与近 7 天趋势，拆分会让数据来源与展示状态更分散。 */
import type { NewApiAccountInfo, NewApiRoleLabel } from "@zcode/services";
import { RefreshCw } from "lucide-react";
import { TID_SETTINGS_USAGE_NEWAPI_PANEL } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNewApiAccount } from "@/hooks/useNewApiAccount.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import { UsageEmptyState, formatCompactNumber } from "@/settings/usage-stats/usageStatsUiParts.js";

const ROLE_MESSAGE_ID: Record<NewApiRoleLabel, string> = {
  "common-user": "settings.usage.newApi.role.commonUser",
  admin: "settings.usage.newApi.role.admin",
  root: "settings.usage.newApi.role.root",
  unknown: "settings.usage.newApi.role.unknown",
};

/** 金额换算：NewAPI 的 quota 是整数单位，金额 = quota / quota_per_unit。 */
export function formatNewApiQuotaAmount(
  info: Pick<NewApiAccountInfo, "quotaPerUnit" | "currencySymbol">,
  value: number,
): string {
  const unit = info.quotaPerUnit > 0 ? info.quotaPerUnit : 1;
  const amount = value / unit;
  const fractionDigits = Math.abs(amount) >= 1 ? 2 : 4;
  return `${info.currencySymbol}${amount.toFixed(fractionDigits)}`;
}

function AccountStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ui-sm text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate text-ui-base font-medium text-foreground">{value}</span>
      {hint ? (
        <span className="min-w-0 truncate text-ui-sm text-foreground-subtlest">{hint}</span>
      ) : null}
    </div>
  );
}

function NewApiTrendChart({ info }: { info: NewApiAccountInfo }) {
  const { intl, locale } = useZCodeIntl();
  const maxQuota = info.daily.reduce((peak, point) => Math.max(peak, point.quota), 0);

  if (info.daily.length === 0) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usage.newApi.trendEmpty" })}
      </p>
    );
  }

  return (
    <div className="flex items-end gap-2">
      {info.daily.map((point) => {
        const ratio = maxQuota > 0 ? point.quota / maxQuota : 0;
        return (
          <div key={point.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="text-ui-sm text-foreground-subtle">
              {formatCompactNumber(locale, point.quota)}
            </span>
            <div
              className="w-full rounded-sm bg-[var(--color-usage-chart-1)]"
              style={{ height: `${Math.max(4, Math.round(ratio * 72))}px` }}
              title={intl.formatMessage(
                { id: "settings.usage.newApi.trendCell" },
                {
                  count: formatCompactNumber(locale, point.count),
                  quota: formatCompactNumber(locale, point.quota),
                },
              )}
            />
            <span className="text-ui-sm text-foreground-subtlest">{point.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function NewApiUsagePanel() {
  const { intl, locale } = useZCodeIntl();
  const { connection, state, refresh } = useNewApiAccount();

  if (state.status === "loading") {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usage.newApi.loading" })}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3">
        <UsageStatsErrorNotice error={state.message} />
        <Button type="button" size="sm" variant="outline" onClick={refresh}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>
    );
  }

  if (state.status !== "ready") {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.newApi.notConnectedTitle" })}
        description={intl.formatMessage({
          id: connection
            ? "settings.usage.newApi.loadFailedDescription"
            : "settings.usage.newApi.notConnectedDescription",
        })}
      />
    );
  }

  const info = state.info;
  const accountLabel = info.id === undefined ? info.username : `${info.username} (${info.id})`;
  const statusText =
    info.status === 1
      ? intl.formatMessage({ id: "settings.usage.newApi.status.enabled" })
      : info.status === 2
        ? intl.formatMessage({ id: "settings.usage.newApi.status.disabled" })
        : undefined;

  return (
    <section className="space-y-6" data-testid={TID_SETTINGS_USAGE_NEWAPI_PANEL}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.usage.newApi.title" })}
          </h3>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.usage.newApi.description" },
              { system: info.systemName ?? connection?.baseUrl ?? "NewAPI" },
            )}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={refresh}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <AccountStat
          label={intl.formatMessage({ id: "settings.usage.newApi.accountName" })}
          value={accountLabel}
        />
        <AccountStat
          label={intl.formatMessage({ id: "settings.usage.newApi.role" })}
          value={intl.formatMessage({ id: ROLE_MESSAGE_ID[info.roleLabel] })}
          {...(info.group ? { hint: info.group } : {})}
        />
        {statusText ? (
          <AccountStat
            label={intl.formatMessage({ id: "settings.usage.newApi.status" })}
            value={statusText}
          />
        ) : null}
        <AccountStat
          label={intl.formatMessage({ id: "settings.usage.newApi.balance" })}
          value={formatNewApiQuotaAmount(info, info.quota)}
          hint={intl.formatMessage(
            { id: "settings.usage.newApi.quotaUnits" },
            { value: formatCompactNumber(locale, info.quota) },
          )}
        />
        <AccountStat
          label={intl.formatMessage({ id: "settings.usage.newApi.usedBalance" })}
          value={formatNewApiQuotaAmount(info, info.usedQuota)}
          hint={intl.formatMessage(
            { id: "settings.usage.newApi.quotaUnits" },
            { value: formatCompactNumber(locale, info.usedQuota) },
          )}
        />
        <AccountStat
          label={intl.formatMessage({ id: "settings.usage.newApi.requestCount" })}
          value={intl.formatMessage(
            { id: "settings.usage.newApi.requestCountValue" },
            { value: formatCompactNumber(locale, info.requestCount) },
          )}
        />
      </div>

      <div className="space-y-3">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.newApi.trendTitle" })}
        </h4>
        <NewApiTrendChart info={info} />
      </div>
    </section>
  );
}
