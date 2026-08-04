import { useI18n } from "@/features/i18n/I18nProvider";
import { RoundedSelect } from "@/features/design-system/components/select/RoundedSelect";
import type { ThirdPartyKeyUsageSnapshot } from "../utils/thirdPartyKeyUsage";
import type { CodexKeyProfile, CodexProvider, CredentialSelection } from "@/types";
import {
  providersFromSettings,
  providerSelection,
} from "@/utils/providerCredentials";

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
  codexProviders?: CodexProvider[];
  usageCredentialSelection?: CredentialSelection | null;
  effectiveUsageCredentialSelection?: CredentialSelection | null;
  onSelectUsageCredential: (selection: CredentialSelection | null) => void;
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
  showDetails?: boolean;
  providers?: CodexProvider[];
  usageSelection?: CredentialSelection | null;
  effectiveUsageSelection?: CredentialSelection | null;
  onSelectUsageCredential: (selection: CredentialSelection | null) => void;
};

function ThirdPartyUsageSummary({
  tokens,
  costUsd,
  providerUsage,
  showDetails = true,
  providers = [],
  usageSelection,
  effectiveUsageSelection,
  onSelectUsageCredential,
}: ThirdPartyUsageSummaryProps) {
  const { t } = useI18n();
  const selectedProvider =
    providers.find((provider) => provider.id === effectiveUsageSelection?.providerId) ?? null;
  const selectedGroup =
    selectedProvider?.groups.find((group) => group.id === effectiveUsageSelection?.groupId) ??
    selectedProvider?.groups[0];
  const providerOptions = [
    {
      value: "__local_codex_config__",
      label: t("sidebar.usageLocalCodexConfig"),
    },
    ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
  ];
  const providerValue = usageSelection
    ? selectedProvider?.id ?? ""
    : providerOptions.find((option) => option.value === "__local_codex_config__")?.value ??
      providerOptions[0]?.value ??
      "";
  const providerLabel =
    providerOptions.find((option) => option.value === providerValue)?.label ??
    providerOptions[0]?.label ??
    "";
  const groupOptions = (selectedProvider?.groups ?? []).map((group) => ({
    value: group.id,
    label: group.name,
  }));
  const groupValue = selectedGroup?.id ?? groupOptions[0]?.value ?? "";
  const groupLabel =
    groupOptions.find((option) => option.value === groupValue)?.label ??
    groupOptions[0]?.label ??
    "";

  const selectUsage = (selection: CredentialSelection | null) => {
    onSelectUsageCredential(selection);
  };

  return (
    <div className="sidebar-usage-third-party">
      {providers.length > 0 ? (
        <div className="sidebar-usage-selection-stack">
          <div className="sidebar-usage-stat">
            <span>{t("sidebar.usageProvider")}</span>
            {providerOptions.length > 1 ? (
              <RoundedSelect
                className="sidebar-usage-select"
                popoverClassName="sidebar-usage-select-popover"
                style={{ width: "100%" }}
                value={providerValue}
                ariaLabel={t("sidebar.usageProvider")}
                options={providerOptions}
                onChange={(providerId) => {
                  if (providerId === "__local_codex_config__") {
                    selectUsage(null);
                    return;
                  }
                  const provider = providers.find((item) => item.id === providerId);
                  selectUsage(provider ? providerSelection(provider) : null);
                }}
              />
            ) : (
              <span className="sidebar-usage-select-value">{providerLabel}</span>
            )}
          </div>
          {selectedProvider ? (
            <div className="sidebar-usage-stat">
              <span>{t("sidebar.usageGroup")}</span>
              {groupOptions.length > 1 ? (
                <RoundedSelect
                  className="sidebar-usage-select"
                  popoverClassName="sidebar-usage-select-popover"
                  style={{ width: "100%" }}
                  value={groupValue}
                  ariaLabel={t("sidebar.usageGroup")}
                  options={groupOptions}
                  onChange={(groupId) => {
                    const group = selectedProvider.groups.find((item) => item.id === groupId);
                    const credential = group?.credentials[0];
                    selectUsage(
                      group && credential
                        ? {
                            providerId: selectedProvider.id,
                            groupId: group.id,
                            credentialId: credential.id,
                          }
                        : null,
                    );
                  }}
                />
              ) : (
                <span className="sidebar-usage-select-value">{groupLabel}</span>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {showDetails ? providerUsage ? (
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
      ) : null}
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
  codexProviders,
  usageCredentialSelection,
  effectiveUsageCredentialSelection,
  onSelectUsageCredential,
}: SidebarBottomRailProps) {
  const { t } = useI18n();
  const providers = providersFromSettings({
    codexProviders,
    codexKeyProfiles,
  });

  return (
    <div className="sidebar-bottom-rail">
      {showUsage && (
        <div className="sidebar-usage-panel">
          {providers.length > 0 && thirdPartyUsageTokens === null ? (
            <ThirdPartyUsageSummary
              tokens={0}
              costUsd={null}
              providerUsage={null}
              showDetails={false}
              providers={providers}
              usageSelection={usageCredentialSelection}
              effectiveUsageSelection={effectiveUsageCredentialSelection}
              onSelectUsageCredential={onSelectUsageCredential}
            />
          ) : null}
          {thirdPartyUsageTokens === null && creditsLabel && (
            <div className="sidebar-usage-credits">{creditsLabel}</div>
          )}
          {thirdPartyUsageTokens !== null ? (
            <ThirdPartyUsageSummary
              tokens={thirdPartyUsageTokens}
              costUsd={thirdPartyUsageCostUsd}
              providerUsage={thirdPartyProviderUsage}
              providers={providers}
              usageSelection={usageCredentialSelection}
              effectiveUsageSelection={effectiveUsageCredentialSelection}
              onSelectUsageCredential={onSelectUsageCredential}
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
