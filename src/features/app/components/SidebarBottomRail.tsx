import { useI18n } from "@/features/i18n/I18nProvider";
import type { ThirdPartyKeyUsageSnapshot } from "../utils/thirdPartyKeyUsage";
import type { CodexKeyProfile } from "@/types";

type SidebarBottomRailProps = {
  showUsage: boolean;
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetLabel: string | null;
  weeklyResetLabel: string | null;
  creditsLabel: string | null;
  showWeekly: boolean;
  thirdPartyUsageTokens: number | null;
  thirdPartyUsageCostUsd: number | null;
  thirdPartyProviderUsage: ThirdPartyKeyUsageSnapshot | null;
  codexKeyProfiles: CodexKeyProfile[];
  activeCodexKeyProfileId: string | null;
  onSelectCodexKeyProfile: (profileId: string) => void;
};

type UsageRowProps = {
  label: string;
  percent: number | null;
  resetLabel: string | null;
};

function UsageRow({ label, percent, resetLabel }: UsageRowProps) {
  return (
    <div className="sidebar-usage-row">
      <div className="sidebar-usage-row-head">
        <span className="sidebar-usage-name">{label}</span>
        <span className="sidebar-usage-value">
          {percent === null ? "--" : `${percent}%`}
        </span>
      </div>
      <div className="sidebar-usage-bar" aria-hidden>
        <span className="sidebar-usage-bar-fill" style={{ width: `${percent ?? 0}%` }} />
      </div>
      {resetLabel && <div className="sidebar-usage-reset">{resetLabel}</div>}
    </div>
  );
}

function formatTokenCount(tokens: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(Math.max(0, tokens));
}

function formatUsdValue(value: number | null) {
  if (value === null) {
    return "--";
  }
  const amount = Math.max(0, value);
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: amount >= 1 ? 2 : 4,
    minimumFractionDigits: amount > 0 && amount < 1 ? 4 : 2,
  }).format(amount);
  return `$${formatted}`;
}

function formatLatency(latencyMs: number) {
  const normalized = Math.max(0, latencyMs);
  if (normalized < 1_000) {
    return `${Math.round(normalized)} ms`;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(normalized / 1_000)} s`;
}

type ThirdPartyUsageSummaryProps = {
  tokens: number;
  costUsd: number | null;
  providerUsage: ThirdPartyKeyUsageSnapshot | null;
  keyProfiles: CodexKeyProfile[];
  activeKeyProfileId: string | null;
  onSelectKeyProfile: (profileId: string) => void;
};

function ThirdPartyUsageSummary({
  tokens,
  costUsd,
  providerUsage,
  keyProfiles,
  activeKeyProfileId,
  onSelectKeyProfile,
}: ThirdPartyUsageSummaryProps) {
  const { t } = useI18n();

  return (
    <div className="sidebar-usage-third-party">
      {keyProfiles.length > 0 && (
        <div className="sidebar-usage-stat">
          <span>{t("sidebar.usageGroup")}</span>
          <select
            className="sidebar-usage-group-select"
            value={activeKeyProfileId ?? ""}
            aria-label={t("sidebar.usageGroup")}
            onChange={(event) => onSelectKeyProfile(event.target.value)}
          >
            <option value="">{t("settings.codex.defaultEnvVars")}</option>
            {keyProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.groupName?.trim() || profile.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {providerUsage ? (
        <>
          <div className="sidebar-usage-stat">
            <span>
              {t(
                providerUsage.balanceScope === "token"
                  ? "sidebar.usageTokenQuota"
                  : "sidebar.usageBalance",
              )}
            </span>
            <strong>
              {providerUsage.isUnlimited
                ? t("sidebar.usageUnlimited")
                : formatUsdValue(providerUsage.balanceUsd)}
            </strong>
          </div>
          <div className="sidebar-usage-stat">
            <span>
              {t(
                providerUsage.spendPeriod === "total"
                  ? "sidebar.usageTotalCost"
                  : "sidebar.usageTodayCost",
              )}
            </span>
            <strong>
              {formatUsdValue(
                providerUsage.spendPeriod === "total"
                  ? providerUsage.totalCostUsd
                  : providerUsage.todayCostUsd,
              )}
            </strong>
          </div>
          {providerUsage.averageLatencyMs !== null && (
            <div className="sidebar-usage-stat">
              <span>{t("sidebar.usageAverageLatency")}</span>
              <strong>{formatLatency(providerUsage.averageLatencyMs)}</strong>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="sidebar-usage-stat">
            <span>{t("sidebar.usageConsumed")}</span>
            <strong>{formatTokenCount(tokens)}</strong>
          </div>
          <div className="sidebar-usage-stat">
            <span>{t("sidebar.usageEstimatedCost")}</span>
            <strong>{formatUsdValue(costUsd)}</strong>
          </div>
        </>
      )}
    </div>
  );
}

export function SidebarBottomRail({
  showUsage,
  sessionPercent,
  weeklyPercent,
  sessionResetLabel,
  weeklyResetLabel,
  creditsLabel,
  showWeekly,
  thirdPartyUsageTokens,
  thirdPartyUsageCostUsd,
  thirdPartyProviderUsage,
  codexKeyProfiles,
  activeCodexKeyProfileId,
  onSelectCodexKeyProfile,
}: SidebarBottomRailProps) {
  const { t } = useI18n();

  return (
    <div className="sidebar-bottom-rail">
      {showUsage && (
        <div className="sidebar-usage-panel">
          {thirdPartyUsageTokens === null && creditsLabel && (
            <div className="sidebar-usage-credits">{creditsLabel}</div>
          )}
          {thirdPartyUsageTokens !== null ? (
            <ThirdPartyUsageSummary
              tokens={thirdPartyUsageTokens}
              costUsd={thirdPartyUsageCostUsd}
              providerUsage={thirdPartyProviderUsage}
              keyProfiles={codexKeyProfiles}
              activeKeyProfileId={activeCodexKeyProfileId}
              onSelectKeyProfile={onSelectCodexKeyProfile}
            />
          ) : (
            <div className="sidebar-usage-list">
              <UsageRow
                label={t("sidebar.session")}
                percent={sessionPercent}
                resetLabel={sessionResetLabel}
              />
              {showWeekly && (
                <UsageRow
                  label={t("sidebar.weekly")}
                  percent={weeklyPercent}
                  resetLabel={weeklyResetLabel}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
