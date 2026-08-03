import { useEffect, useMemo, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
import Clipboard from "lucide-react/dist/esm/icons/clipboard";
import Copy from "lucide-react/dist/esm/icons/copy";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle";
import Users from "lucide-react/dist/esm/icons/users";
import X from "lucide-react/dist/esm/icons/x";
import type { ParsedFileLocation } from "../../../utils/fileLinks";
import { useI18n } from "@/features/i18n/I18nProvider";
import {
  RoundedSelect,
  type RoundedSelectOption,
} from "@/features/design-system/components/select/RoundedSelect";
import { Markdown } from "./Markdown";
import type { SubagentResultStatus, SubagentResultSummary } from "../utils/subagentResults";

type SubagentResultSummaryProps = {
  results: SubagentResultSummary[];
  workspacePath?: string | null;
  codeBlockCopyUseModifier?: boolean;
  showMessageFilePath?: boolean;
  onOpenFileLink?: (path: ParsedFileLocation) => void;
  onOpenThreadLink?: (threadId: string, workspaceId?: string | null) => void;
  workspaceId?: string | null;
};

function statusIcon(status: SubagentResultStatus) {
  if (status === "running") {
    return <LoaderCircle className="subagent-result-status-icon is-spinning" size={14} aria-hidden />;
  }
  if (status === "failed") {
    return <CircleAlert className="subagent-result-status-icon" size={14} aria-hidden />;
  }
  if (status === "completed") {
    return <Check className="subagent-result-status-icon" size={14} aria-hidden />;
  }
  return <ChevronRight className="subagent-result-status-icon" size={14} aria-hidden />;
}

export function SubagentResultSummary({
  results,
  workspacePath,
  codeBlockCopyUseModifier,
  showMessageFilePath,
  onOpenFileLink,
  onOpenThreadLink,
  workspaceId,
}: SubagentResultSummaryProps) {
  const { t } = useI18n();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [copiedThreadId, setCopiedThreadId] = useState<string | null>(null);
  const selected = results.find((result) => result.threadId === selectedThreadId) ?? null;
  const activeResult =
    results.find((result) => result.threadId === activeThreadId) ??
    results[0] ??
    null;
  const isSwitchable = results.length > 1;

  useEffect(() => {
    if (activeThreadId && results.some((result) => result.threadId === activeThreadId)) {
      return;
    }
    setActiveThreadId(results[0]?.threadId ?? null);
  }, [activeThreadId, results]);

  useEffect(() => {
    if (selectedThreadId && !selected) {
      setSelectedThreadId(null);
    }
  }, [selected, selectedThreadId]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedThreadId(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const statusLabel = useMemo(
    () => ({
      running: t("messages.subagentRunning"),
      completed: t("messages.subagentCompleted"),
      failed: t("messages.subagentFailed"),
      pending: t("messages.subagentPending"),
    }),
    [t],
  );
  const resultOptions = useMemo<RoundedSelectOption[]>(
    () =>
      results.map((result) => ({
        value: result.threadId,
        label: result.title,
        title: `${result.title} · ${statusLabel[result.status]}`,
      })),
    [results, statusLabel],
  );

  if (results.length === 0) {
    return null;
  }

  const copyResult = async (result: SubagentResultSummary) => {
    if (!result.content) {
      return;
    }
    try {
      await navigator.clipboard.writeText(result.content);
      setCopiedThreadId(result.threadId);
      window.setTimeout(() => setCopiedThreadId(null), 1400);
    } catch {
      // Clipboard access can be unavailable in restricted WebView contexts.
    }
  };

  const handleActiveResultChange = (threadId: string) => {
    setActiveThreadId(threadId);
    if (selectedThreadId && selectedThreadId !== threadId) {
      setSelectedThreadId(null);
    }
  };

  const renderResultRow = (result: SubagentResultSummary) => (
    <article
      key={result.threadId}
      className={`subagent-result-row is-${result.status}`}
    >
      <button
        type="button"
        className="subagent-result-main"
        onClick={() => setSelectedThreadId(result.threadId)}
        aria-label={`${t("messages.subagentViewDetails")}: ${result.title}`}
        aria-expanded={selectedThreadId === result.threadId}
      >
        <span className="subagent-result-status" title={statusLabel[result.status]}>
          {statusIcon(result.status)}
        </span>
        <span className="subagent-result-copy">
          <span className="subagent-result-title-line">
            <span className="subagent-result-title">{result.title}</span>
            <span className="subagent-result-status-label">{statusLabel[result.status]}</span>
          </span>
          <span className="subagent-result-preview">
            {result.summary || t("messages.subagentNoResult")}
          </span>
        </span>
        <ChevronRight className="subagent-result-open-icon" size={15} aria-hidden />
      </button>
      <div className="subagent-result-actions">
        <button
          type="button"
          className="ghost icon-button subagent-result-action"
          onClick={() => void copyResult(result)}
          aria-label={
            copiedThreadId === result.threadId
              ? t("messages.subagentCopied")
              : t("messages.subagentCopyResult")
          }
          title={
            copiedThreadId === result.threadId
              ? t("messages.subagentCopied")
              : t("messages.subagentCopyResult")
          }
          disabled={!result.content}
        >
          {copiedThreadId === result.threadId ? (
            <Clipboard size={14} aria-hidden />
          ) : (
            <Copy size={14} aria-hidden />
          )}
        </button>
        {onOpenThreadLink && (
          <button
            type="button"
            className="ghost icon-button subagent-result-action"
            onClick={() => onOpenThreadLink(result.threadId, workspaceId)}
            aria-label={t("messages.subagentOpenThread")}
            title={t("messages.subagentOpenThread")}
          >
            <Users size={14} aria-hidden />
          </button>
        )}
      </div>
    </article>
  );

  const visibleResults = isSwitchable
    ? activeResult
      ? [activeResult]
      : []
    : results;

  return (
    <section className="subagent-results" aria-label={t("messages.subagentResults")}>
      <div className="subagent-results-header">
        <div className="subagent-results-heading">
          <Users size={15} aria-hidden />
          <span>{t("messages.subagentResults")}</span>
          <span className="subagent-results-count">{results.length}</span>
        </div>
        {isSwitchable && activeResult ? (
          <div className="subagent-result-select-wrap">
            <RoundedSelect
              value={activeResult.threadId}
              options={resultOptions}
              onChange={handleActiveResultChange}
              ariaLabel={t("messages.subagentSelectResult")}
              className="subagent-result-select"
              popoverClassName="subagent-result-select-popover"
            >
              <span className="subagent-result-select-content">
                <span
                  className={`subagent-result-select-status is-${activeResult.status}`}
                >
                  {statusIcon(activeResult.status)}
                </span>
                <span className="subagent-result-select-title">
                  {activeResult.title}
                </span>
                <span className="subagent-result-select-status-label">
                  {statusLabel[activeResult.status]}
                </span>
              </span>
            </RoundedSelect>
          </div>
        ) : null}
      </div>
      <div className="subagent-results-list">
        {visibleResults.map(renderResultRow)}
      </div>
      {selected && (
        <aside className="subagent-result-drawer" role="dialog" aria-label={selected.title}>
          <header className="subagent-result-drawer-header">
            <div>
              <div className="subagent-result-drawer-kicker">
                {statusIcon(selected.status)}
                <span>{statusLabel[selected.status]}</span>
              </div>
              <h2>{selected.title}</h2>
            </div>
            <div className="subagent-result-drawer-actions">
              <button
                type="button"
                className="ghost icon-button"
                onClick={() => void copyResult(selected)}
                aria-label={
                  copiedThreadId === selected.threadId
                    ? t("messages.subagentCopied")
                    : t("messages.subagentCopyResult")
                }
                title={
                  copiedThreadId === selected.threadId
                    ? t("messages.subagentCopied")
                    : t("messages.subagentCopyResult")
                }
                disabled={!selected.content}
              >
                {copiedThreadId === selected.threadId ? (
                  <Clipboard size={14} aria-hidden />
                ) : (
                  <Copy size={14} aria-hidden />
                )}
              </button>
              {onOpenThreadLink && (
                <button
                  type="button"
                  className="ghost icon-button"
                  onClick={() => onOpenThreadLink(selected.threadId, workspaceId)}
                  aria-label={t("messages.subagentOpenThread")}
                  title={t("messages.subagentOpenThread")}
                >
                  <Users size={14} aria-hidden />
                </button>
              )}
              <button
                type="button"
                className="ghost icon-button"
                onClick={() => setSelectedThreadId(null)}
                aria-label={t("messages.subagentCloseDetails")}
                title={t("messages.subagentCloseDetails")}
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          </header>
          <div className="subagent-result-drawer-meta">
            {t("messages.subagentCheckpointCount").replace("{count}", String(selected.checkpointCount))}
          </div>
          <div className="subagent-result-drawer-body">
            {selected.content ? (
              <Markdown
                value={selected.content}
                workspacePath={workspacePath}
                codeBlockCopyUseModifier={codeBlockCopyUseModifier}
                showFilePath={showMessageFilePath}
                onOpenFileLink={onOpenFileLink}
              />
            ) : (
              <p className="subagent-result-empty">{t("messages.subagentNoResult")}</p>
            )}
          </div>
        </aside>
      )}
    </section>
  );
}
