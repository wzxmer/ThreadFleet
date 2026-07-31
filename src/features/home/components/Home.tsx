import { useState } from "react";
import { Info } from "lucide-react";
import { FeatureIntroPrompt } from "@app/components/FeatureIntroPrompt";
import { useI18n } from "@/features/i18n/I18nProvider";
import type {
  AccountSnapshot,
  LocalUsageSnapshot,
  RateLimitSnapshot,
} from "../../../types";
import { HomeActions } from "./HomeActions";
import { HomeUsageSection } from "./HomeUsageSection";
import type {
  LatestAgentRun,
  UsageMetric,
  UsageWorkspaceOption,
} from "../homeTypes";

type HomeProps = {
  onStartNoProjectChat?: () => void;
  onAddWorkspace: () => void;
  onAddWorkspaceFromUrl: () => void;
  latestAgentRuns: LatestAgentRun[];
  isLoadingLatestAgents: boolean;
  localUsageSnapshot: LocalUsageSnapshot | null;
  isLoadingLocalUsage: boolean;
  localUsageError: string | null;
  onRefreshLocalUsage: () => void;
  usageMetric: UsageMetric;
  onUsageMetricChange: (metric: UsageMetric) => void;
  usageWorkspaceId: string | null;
  usageWorkspaceOptions: UsageWorkspaceOption[];
  onUsageWorkspaceChange: (workspaceId: string | null) => void;
  accountRateLimits: RateLimitSnapshot | null;
  usageShowRemaining: boolean;
  accountInfo: AccountSnapshot | null;
  onSelectThread: (workspaceId: string, threadId: string) => void;
};

export function Home({
  onStartNoProjectChat,
  onAddWorkspace,
  onAddWorkspaceFromUrl,
  localUsageSnapshot,
  isLoadingLocalUsage,
  localUsageError,
  onRefreshLocalUsage,
  usageMetric,
  onUsageMetricChange,
  usageWorkspaceId,
  usageWorkspaceOptions,
  onUsageWorkspaceChange,
  accountRateLimits,
  usageShowRemaining,
  accountInfo,
}: HomeProps) {
  const { t } = useI18n();
  const [featureIntroOpen, setFeatureIntroOpen] = useState(false);
  return (
    <div className="home">
      <header className="home-header">
        <div className="home-heading">
          <div className="home-product">ThreadFleet</div>
          <div className="home-kicker">{t("home.kicker")}</div>
          <div className="home-title">{t("home.title")}</div>
          <div className="home-subtitle">{t("home.subtitle")}</div>
        </div>
        <div className="home-header-actions">
          <HomeActions
            onStartNoProjectChat={onStartNoProjectChat ?? (() => {})}
            onAddWorkspace={onAddWorkspace}
            onAddWorkspaceFromUrl={onAddWorkspaceFromUrl}
          />
          <button
            type="button"
            className="home-feature-intro-button ds-tooltip-trigger"
            onClick={() => setFeatureIntroOpen(true)}
            aria-label={t("featureIntro.action")}
            title={t("featureIntro.action")}
            data-tooltip={t("featureIntro.action")}
            data-tooltip-align="end"
            data-tooltip-placement="bottom"
          >
            <Info aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="home-dashboard">
        <section className="home-dashboard-primary">
          <HomeUsageSection
            accountInfo={accountInfo}
            accountRateLimits={accountRateLimits}
            isLoadingLocalUsage={isLoadingLocalUsage}
            localUsageError={localUsageError}
            localUsageSnapshot={localUsageSnapshot}
            onRefreshLocalUsage={onRefreshLocalUsage}
            onUsageMetricChange={onUsageMetricChange}
            onUsageWorkspaceChange={onUsageWorkspaceChange}
            usageMetric={usageMetric}
            usageShowRemaining={usageShowRemaining}
            usageWorkspaceId={usageWorkspaceId}
            usageWorkspaceOptions={usageWorkspaceOptions}
          />
        </section>
      </main>
      <FeatureIntroPrompt
        open={featureIntroOpen}
        onClose={() => setFeatureIntroOpen(false)}
      />
    </div>
  );
}
