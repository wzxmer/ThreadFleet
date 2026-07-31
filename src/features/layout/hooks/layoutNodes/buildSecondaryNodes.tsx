import { DebugPanel } from "../../../debug/components/DebugPanel";
import { useI18n } from "../../../i18n/I18nProvider";
import type { I18nKey } from "../../../i18n/strings";
import { PlanPanel } from "../../../plan/components/PlanPanel";
import { TerminalDock } from "../../../terminal/components/TerminalDock";
import { TerminalPanel } from "../../../terminal/components/TerminalPanel";
import type {
  LayoutNodesResult,
  LayoutSecondarySurface,
} from "./types";

export type SecondaryLayoutNodesOptions = LayoutSecondarySurface;

type SecondaryLayoutNodes = Pick<
  LayoutNodesResult,
  | "planPanelNode"
  | "debugPanelNode"
  | "debugPanelFullNode"
  | "terminalDockNode"
  | "compactEmptyCodexNode"
  | "compactEmptyGitNode"
  | "compactGitBackNode"
>;

function buildTerminalPanelNode(terminalState: SecondaryLayoutNodesOptions["terminalState"]) {
  if (!terminalState) {
    return null;
  }

  return (
    <TerminalPanel
      containerRef={terminalState.containerRef}
      status={terminalState.status}
      message={terminalState.message}
    />
  );
}

function buildDebugPanels(debugPanelProps: SecondaryLayoutNodesOptions["debugPanelProps"]) {
  const debugPanelNode = <DebugPanel {...debugPanelProps} />;
  const debugPanelFullNode = (
    <DebugPanel
      {...debugPanelProps}
      isOpen
      variant="full"
    />
  );

  return { debugPanelNode, debugPanelFullNode };
}

function CompactEmptyNode({
  titleKey,
  descriptionKey,
  onGoProjects,
}: {
  titleKey: I18nKey;
  descriptionKey: I18nKey;
  onGoProjects: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="compact-empty">
      <h3>{t(titleKey)}</h3>
      <p>{t(descriptionKey)}</p>
      <button type="button" className="ghost" onClick={onGoProjects}>
        {t("layout.goToProjects")}
      </button>
    </div>
  );
}

function CompactGitBackNode({
  compactNavProps,
}: {
  compactNavProps: SecondaryLayoutNodesOptions["compactNavProps"],
}) {
  const { t } = useI18n();
  const compactGitDiffActive =
    compactNavProps.centerMode === "diff" &&
    Boolean(compactNavProps.selectedDiffPath);

  return (
    <div className="compact-git-back">
      <button
        type="button"
        className={`compact-git-switch-button${compactGitDiffActive ? "" : " active"}`}
        onClick={compactNavProps.onBackFromDiff}
      >
        {t("layout.files")}
      </button>
      <button
        type="button"
        className={`compact-git-switch-button${compactGitDiffActive ? " active" : ""}`}
        onClick={compactNavProps.onShowSelectedDiff}
        disabled={!compactNavProps.hasActiveGitDiffs}
      >
        {t("layout.diff")}
      </button>
    </div>
  );
}

export function buildSecondaryNodes(options: SecondaryLayoutNodesOptions): SecondaryLayoutNodes {
  const planPanelNode = <PlanPanel {...options.planPanelProps} />;
  const terminalPanelNode = buildTerminalPanelNode(options.terminalState);

  const terminalDockNode = (
    <TerminalDock
      {...options.terminalDockProps}
      terminalNode={terminalPanelNode}
    />
  );

  const { debugPanelNode, debugPanelFullNode } = buildDebugPanels(options.debugPanelProps);

  const compactEmptyCodexNode = (
    <CompactEmptyNode
      titleKey="layout.emptyWorkspaceTitle"
      descriptionKey="layout.emptyChatDescription"
      onGoProjects={options.compactNavProps.onGoProjects}
    />
  );

  const compactEmptyGitNode = (
    <CompactEmptyNode
      titleKey="layout.emptyWorkspaceTitle"
      descriptionKey="layout.emptyGitDescription"
      onGoProjects={options.compactNavProps.onGoProjects}
    />
  );

  const compactGitBackNode = (
    <CompactGitBackNode compactNavProps={options.compactNavProps} />
  );

  return {
    planPanelNode,
    debugPanelNode,
    debugPanelFullNode,
    terminalDockNode,
    compactEmptyCodexNode,
    compactEmptyGitNode,
    compactGitBackNode,
  };
}
