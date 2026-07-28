import type { TurnPlan } from "../../../types";
import { CoordinationPanel } from "@/features/threads/components/CoordinationPanel";
import { useI18n } from "@/features/i18n/I18nProvider";

type PlanPanelProps = {
  plan: TurnPlan | null;
  planStream?: string | null;
  activeTurnId?: string | null;
  isProcessing: boolean;
  activeWorkspaceId?: string | null;
  activeThreadId?: string | null;
  workspacePath?: string | null;
};

function formatProgress(plan: TurnPlan) {
  const total = plan.steps.length;
  if (!total) {
    return "";
  }
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  return `${completed}/${total}`;
}

function statusLabel(status: TurnPlan["steps"][number]["status"]) {
  if (status === "completed") {
    return "[x]";
  }
  if (status === "inProgress") {
    return "[>]";
  }
  return "[ ]";
}

export function PlanPanel({
  plan,
  planStream = null,
  activeTurnId = null,
  isProcessing,
  activeWorkspaceId = null,
  activeThreadId = null,
  workspacePath = null,
}: PlanPanelProps) {
  const { t } = useI18n();
  const showPlanStream = Boolean(
    planStream && (!plan || Boolean(activeTurnId && plan.turnId !== activeTurnId)),
  );
  const visiblePlan = showPlanStream ? null : plan;
  const progress = visiblePlan ? formatProgress(visiblePlan) : "";
  const steps = visiblePlan?.steps ?? [];
  const showEmpty = !showPlanStream && !steps.length && !visiblePlan?.explanation;
  const emptyLabel = isProcessing
    ? t("plan.panel.waiting")
    : t("plan.panel.empty");
  const syncLabel =
    visiblePlan?.syncState === "reconciling"
      ? t("plan.panel.reconciling")
      : visiblePlan?.syncState === "stale"
        ? t("plan.panel.stale")
        : null;

  return (
    <aside className="plan-panel">
      <div className="plan-header">
        <span>{t("plan.panel.title")}</span>
        {progress && <span className="plan-progress">{progress}</span>}
      </div>
      {visiblePlan?.explanation && (
        <div className="plan-explanation">{visiblePlan.explanation}</div>
      )}
      {syncLabel && (
        <div
          className={`plan-sync-status ${visiblePlan?.syncState ?? ""}`}
          role="status"
        >
          {syncLabel}
        </div>
      )}
      {showPlanStream ? (
        <pre className="plan-stream">{planStream}</pre>
      ) : showEmpty ? (
        <div className="plan-empty">{emptyLabel}</div>
      ) : (
        <ol className="plan-list">
          {steps.map((step, index) => (
            <li key={`${step.step}-${index}`} className={`plan-step ${step.status}`}>
              <span className="plan-step-status" aria-hidden>
                {statusLabel(step.status)}
              </span>
              <span className="plan-step-text">{step.step}</span>
            </li>
          ))}
        </ol>
      )}
      {showEmpty && (
        <CoordinationPanel
          activeWorkspaceId={activeWorkspaceId}
          activeThreadId={activeThreadId}
          workspacePath={workspacePath}
        />
      )}
    </aside>
  );
}
