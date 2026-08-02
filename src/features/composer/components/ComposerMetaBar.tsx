import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  BrainCog,
  ChevronDown,
  Link2,
  RefreshCw,
  SlidersHorizontal,
  Zap,
} from "lucide-react";
import { RoundedSelect } from "@/features/design-system/components/select/RoundedSelect";
import { useI18n } from "@/features/i18n/I18nProvider";
import { formatReasoningEffortLabel } from "@/features/models/utils/reasoningEffortLabels";
import { ModelActivityCore } from "@/features/models/components/ModelActivityCore";
import type { ModelActivityState } from "@/features/models/components/ModelActivityCore";
import type {
  AccessMode,
  ComposerTriggerMode,
  ComposerSendShortcut,
  ServiceTier,
} from "../../../types";
import type { CodexArgsOption } from "../../threads/utils/codexArgsProfiles";
import type { WorkflowGateAdapterStatus } from "@/types";
import { WorkflowGateBindingPrompt } from "./WorkflowGateBindingPrompt";

type ComposerMetaBarProps = {
  disabled: boolean;
  isProcessing?: boolean;
  modelActivityState?: ModelActivityState;
  collaborationModes: { id: string; label: string }[];
  selectedCollaborationModeId: string | null;
  onSelectCollaborationMode: (id: string | null) => void;
  models: { id: string; displayName: string; model: string }[];
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
  onRefreshModels?: () => void;
  isRefreshingModels?: boolean;
  reasoningOptions: string[];
  selectedEffort: string | null;
  onSelectEffort: (effort: string) => void;
  selectedServiceTier: ServiceTier | null;
  reasoningSupported: boolean;
  accessMode: AccessMode;
  onSelectAccessMode: (mode: AccessMode) => void;
  composerSendShortcut: ComposerSendShortcut;
  onSelectComposerSendShortcut?: (shortcut: ComposerSendShortcut) => void;
  composerTriggerMode?: ComposerTriggerMode;
  onSelectComposerTriggerMode?: (mode: ComposerTriggerMode) => void;
  autoReconnectEnabled?: boolean;
  autoReconnectPhase?: "idle" | "waiting" | "sending" | "running";
  autoReconnectAttempt?: number;
  onAutoReconnectChange?: (enabled: boolean) => void;
  codexArgsOptions?: CodexArgsOption[];
  selectedCodexArgsOverride?: string | null;
  onSelectCodexArgsOverride?: (value: string | null) => void;
  selectedWorkflowGateId?: string | null;
  onSelectWorkflowGateId?: (workflowId: string | null) => void;
  onVerifyWorkflowGate?: (workflowId: string) => Promise<WorkflowGateAdapterStatus>;
  inputToolsHost?: HTMLElement | null;
};

const formatComposerModelLabel = (label: string) =>
  label.replace(/\s+\(config\)$/i, "");

const estimateLabelWidth = (label: string) =>
  [...label].reduce(
    (width, character) => width + ((character.codePointAt(0) ?? 0) <= 0x7f ? 7 : 12),
    0,
  );

const getControlWidthStyle = (
  label: string,
  chromeWidth: number,
  minWidth: number,
  maxWidth: number,
) => {
  const contentWidth = estimateLabelWidth(label);
  const contentEndGap = 4;
  const width = Math.min(
    maxWidth,
    Math.max(minWidth, contentWidth + chromeWidth + contentEndGap),
  );
  return { "--composer-control-width": `${width}px` } as CSSProperties;
};

const getSelectedLabel = <T extends string>(
  options: Array<{ value: T; label: string }>,
  value: T | null,
) => options.find((option) => option.value === value)?.label ?? "";

export function ComposerMetaBar({
  disabled,
  isProcessing = false,
  modelActivityState,
  collaborationModes,
  selectedCollaborationModeId,
  onSelectCollaborationMode,
  models,
  selectedModelId,
  onSelectModel,
  onRefreshModels,
  isRefreshingModels = false,
  reasoningOptions,
  selectedEffort,
  onSelectEffort,
  selectedServiceTier,
  reasoningSupported,
  accessMode,
  onSelectAccessMode,
  composerSendShortcut,
  onSelectComposerSendShortcut,
  composerTriggerMode = "default",
  onSelectComposerTriggerMode,
  autoReconnectEnabled = false,
  autoReconnectPhase = "idle",
  autoReconnectAttempt = 0,
  onAutoReconnectChange,
  codexArgsOptions = [],
  selectedCodexArgsOverride = null,
  onSelectCodexArgsOverride,
  selectedWorkflowGateId = null,
  onSelectWorkflowGateId,
  onVerifyWorkflowGate,
  inputToolsHost = null,
}: ComposerMetaBarProps) {
  const { t } = useI18n();
  const [workflowGatePromptOpen, setWorkflowGatePromptOpen] = useState(false);
  const [inputMenuOpen, setInputMenuOpen] = useState(false);
  const inputMenuRef = useRef<HTMLDivElement | null>(null);
  const workflowGateLabel = selectedWorkflowGateId
    ? t("composer.workflowGate.boundLabel").replace("{workflowId}", selectedWorkflowGateId)
    : t("composer.workflowGate.open");
  const planMode =
    collaborationModes.find((mode) => mode.id === "plan") ?? null;
  const defaultMode =
    collaborationModes.find((mode) => mode.id === "default") ?? null;
  const canUsePlanToggle =
    Boolean(planMode) &&
    collaborationModes.every(
      (mode) => mode.id === "default" || mode.id === "plan",
    );
  const planSelected = selectedCollaborationModeId === (planMode?.id ?? "");
  const collaborationOptions = collaborationModes.map((mode) => ({
    value: mode.id,
    label: mode.label || mode.id,
  }));
  const modelOptions =
    models.length > 0
      ? models.map((model) => ({
          value: model.id,
          label: formatComposerModelLabel(model.displayName || model.model),
          title: formatComposerModelLabel(model.displayName || model.model),
        }))
      : [{ value: "", label: t("composer.noModel"), disabled: true }];
  const reasoningSelectOptions =
    reasoningOptions.length > 0
      ? reasoningOptions.map((effort) => ({
          value: effort,
          label: formatReasoningEffortLabel(effort),
        }))
      : [{ value: "", label: t("composer.default"), disabled: true }];
  const codexArgsSelectOptions = codexArgsOptions.map((option) => ({
    value: option.value,
    label: option.label,
  }));
  const accessModeOptions: Array<{ value: AccessMode; label: string }> = [
    { value: "read-only", label: t("composer.access.readOnly") },
    { value: "current", label: t("composer.access.current") },
    { value: "full-access", label: t("composer.access.fullAccess") },
  ];
  const sendShortcutOptions: Array<{
    value: ComposerSendShortcut;
    label: string;
    summaryLabel: string;
    title: string;
  }> = [
    {
      value: "enter",
      label: t("composer.shortcut.chat"),
      summaryLabel: t("composer.shortcut.chatShort"),
      title: t("composer.shortcut.chatTooltip"),
    },
    {
      value: "ctrl-enter",
      label: t("composer.shortcut.editor"),
      summaryLabel: t("composer.shortcut.editorShort"),
      title: t("composer.shortcut.editorTooltip"),
    },
    {
      value: "steer-priority",
      label: t("composer.shortcut.steerPriority"),
      summaryLabel: t("composer.shortcut.steerPriorityShort"),
      title: t("composer.shortcut.steerPriorityTooltip"),
    },
  ];
  const triggerModeOptions: Array<{
    value: ComposerTriggerMode;
    label: string;
    summaryLabel: string;
  }> = [
    {
      value: "default",
      label: t("composer.trigger.default"),
      summaryLabel: t("composer.trigger.defaultShort"),
    },
    {
      value: "swap-slash-at",
      label: t("composer.trigger.swap"),
      summaryLabel: t("composer.trigger.swapShort"),
    },
  ];
  const selectedSendShortcut =
    composerSendShortcut === "enter-and-ctrl-enter"
      ? "enter"
      : composerSendShortcut;
  const inputSummary = t("composer.inputSummary")
    .replace(
      "{shortcut}",
      sendShortcutOptions.find((option) => option.value === selectedSendShortcut)
        ?.summaryLabel ?? "",
    )
    .replace(
      "{trigger}",
      triggerModeOptions.find((option) => option.value === composerTriggerMode)
        ?.summaryLabel ?? "",
    );
  const hasInputSettings =
    Boolean(onSelectComposerSendShortcut) || Boolean(onSelectComposerTriggerMode);
  const hasSecondaryControls =
    Boolean(onSelectWorkflowGateId && onVerifyWorkflowGate) || Boolean(onAutoReconnectChange);

  useEffect(() => {
    if (!inputMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (inputMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setInputMenuOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [inputMenuOpen]);

  const inputSettingsNode = hasInputSettings ? (
    <div
      className={`composer-input-settings${inputToolsHost ? " is-header" : ""}`}
      ref={inputMenuRef}
    >
      <button
        type="button"
        className="composer-input-settings-trigger"
        data-button-elevation="none"
        disabled={disabled}
        aria-label={t("composer.inputSettings")}
        aria-haspopup="menu"
        aria-expanded={inputMenuOpen}
        title={inputSummary}
        onClick={() => setInputMenuOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setInputMenuOpen(false);
          }
        }}
      >
        <span className="composer-input-settings-label">{inputSummary}</span>
        <ChevronDown size={13} strokeWidth={1.8} aria-hidden />
      </button>
      {inputMenuOpen && !disabled && (
        <div
          className="composer-input-settings-popover"
          role="menu"
          aria-label={t("composer.inputSettings")}
        >
          {onSelectComposerSendShortcut && (
            <div
              className="composer-input-settings-section"
              role="group"
              aria-label={t("composer.inputShortcutSection")}
            >
              <div className="composer-input-settings-heading">
                {t("composer.inputShortcutSection")}
              </div>
              {sendShortcutOptions.map((option) => {
                const selected = option.value === selectedSendShortcut;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`composer-input-settings-option${
                      selected ? " is-selected" : ""
                    }`}
                    data-button-elevation="none"
                    role="menuitemradio"
                    aria-checked={selected}
                    title={option.title}
                    onClick={() => {
                      onSelectComposerSendShortcut(option.value);
                      setInputMenuOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                    <span className="composer-input-settings-option-hint">
                      {option.title}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {onSelectComposerTriggerMode && (
            <div
              className="composer-input-settings-section"
              role="group"
              aria-label={t("composer.inputTriggerSection")}
            >
              <div className="composer-input-settings-heading">
                {t("composer.inputTriggerSection")}
              </div>
              {triggerModeOptions.map((option) => {
                const selected = option.value === composerTriggerMode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`composer-input-settings-option${
                      selected ? " is-selected" : ""
                    }`}
                    data-button-elevation="none"
                    role="menuitemradio"
                    aria-checked={selected}
                    onClick={() => {
                      onSelectComposerTriggerMode(option.value);
                      setInputMenuOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="composer-bar">
      {inputToolsHost && inputSettingsNode
        ? createPortal(inputSettingsNode, inputToolsHost)
        : null}
      <div className="composer-meta">
        <div className="composer-meta-primary">
        {collaborationModes.length > 0 && (
          canUsePlanToggle ? (
            <div className="composer-select-wrap composer-plan-toggle-wrap">
              <label className="composer-plan-toggle" aria-label={t("composer.planMode")}>
                <input
                  className="composer-plan-toggle-input"
                  type="checkbox"
                  checked={planSelected}
                  disabled={disabled}
                  onChange={(event) =>
                    onSelectCollaborationMode(
                      event.target.checked
                        ? planMode?.id ?? "plan"
                        : (defaultMode?.id ?? null),
                    )
                  }
                />
                <span className="composer-plan-toggle-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none">
                    <path
                      d="m6.5 7.5 1 1 2-2M6.5 12.5l1 1 2-2M6.5 17.5l1 1 2-2M11 7.5h7M11 12.5h7M11 17.5h7"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="composer-plan-toggle-label">
                  {planMode?.label || t("composer.plan")}
                </span>
              </label>
            </div>
          ) : (
            <div className="composer-select-wrap">
            <span className="composer-icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="m6.5 7.5 1 1 2-2M6.5 12.5l1 1 2-2M6.5 17.5l1 1 2-2M11 7.5h7M11 12.5h7M11 17.5h7"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
              <RoundedSelect
                className="composer-select composer-select--model composer-select--collab"
                ariaLabel={t("composer.collaborationMode")}
                value={selectedCollaborationModeId ?? ""}
                options={collaborationOptions}
                onChange={(nextValue) => onSelectCollaborationMode(nextValue || null)}
                disabled={disabled}
              />
            </div>
          )
        )}
        <div
          className="composer-select-wrap composer-select-wrap--model"
          style={getControlWidthStyle(
            getSelectedLabel(modelOptions, selectedModelId ?? ""),
            78,
            122,
            260,
          )}
        >
          <span className="composer-icon composer-icon--model" aria-hidden>
            <ModelActivityCore
              state={modelActivityState ?? (isProcessing ? "thinking" : "idle")}
            />
          </span>
          <RoundedSelect
            className="composer-select composer-select--model"
            popoverClassName="composer-model-select-popover"
            ariaLabel={t("composer.model")}
            value={selectedModelId ?? ""}
            options={modelOptions}
            onChange={onSelectModel}
            disabled={disabled}
          />
          {onRefreshModels && (
            <button
              className="composer-model-refresh"
              type="button"
              onClick={onRefreshModels}
              disabled={isRefreshingModels}
              aria-label={t("composer.refreshModels")}
              title={t("composer.refreshModels")}
            >
              <RefreshCw
                size={12}
                strokeWidth={1.8}
                className={isRefreshingModels ? "is-spinning" : undefined}
              />
            </button>
          )}
          {selectedServiceTier === "fast" && (
            <span
              className="composer-fast-indicator"
              role="status"
              aria-label={t("composer.fastMode")}
              title={t("composer.fastMode")}
            >
              <Zap size={12} strokeWidth={1.8} />
            </span>
          )}
        </div>
        <div
          className="composer-select-wrap composer-select-wrap--effort"
          style={getControlWidthStyle(
            getSelectedLabel(reasoningSelectOptions, selectedEffort ?? ""),
            64,
            76,
            160,
          )}
        >
          <span className="composer-icon composer-icon--effort" aria-hidden>
            <BrainCog size={14} strokeWidth={1.8} />
          </span>
          <RoundedSelect
            className="composer-select composer-select--effort"
            ariaLabel={t("composer.reasoning")}
            value={selectedEffort ?? ""}
            options={reasoningSelectOptions}
            onChange={onSelectEffort}
            disabled={disabled || !reasoningSupported}
          />
        </div>
        {codexArgsOptions.length > 1 && onSelectCodexArgsOverride && (
          <div
            className="composer-select-wrap composer-select-wrap--args"
            style={getControlWidthStyle(
              getSelectedLabel(codexArgsSelectOptions, selectedCodexArgsOverride ?? ""),
              64,
              80,
              180,
            )}
          >
            <span className="composer-icon" aria-hidden>
              <SlidersHorizontal size={14} strokeWidth={1.8} />
            </span>
            <RoundedSelect
              className="composer-select composer-select--approval"
              ariaLabel={t("composer.codexArgs")}
              disabled={disabled}
              value={selectedCodexArgsOverride ?? ""}
              options={codexArgsSelectOptions}
              onChange={(nextValue) => onSelectCodexArgsOverride(nextValue || null)}
            />
          </div>
        )}
        <div
          className="composer-select-wrap composer-select-wrap--access"
          style={getControlWidthStyle(
            getSelectedLabel(accessModeOptions, accessMode),
            64,
            80,
            180,
          )}
        >
          <span className="composer-icon" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none">
              <path
                d="M12 4l7 3v5c0 4.5-3 7.5-7 8-4-0.5-7-3.5-7-8V7l7-3z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="M9.5 12.5l1.8 1.8 3.7-4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <RoundedSelect
            className="composer-select composer-select--approval"
            ariaLabel={t("composer.agentAccess")}
            disabled={disabled}
            value={accessMode}
            options={accessModeOptions}
            onChange={(nextValue) => onSelectAccessMode(nextValue as AccessMode)}
          />
        </div>
        </div>
        {(hasSecondaryControls || (!inputToolsHost && inputSettingsNode)) && (
        <div className="composer-meta-secondary">
        {!inputToolsHost ? inputSettingsNode : null}
        {onSelectWorkflowGateId && onVerifyWorkflowGate && (
          <button
            type="button"
            className={`composer-workflow-gate${selectedWorkflowGateId ? " is-bound" : ""}`}
            onClick={() => setWorkflowGatePromptOpen(true)}
            disabled={disabled}
            aria-label={workflowGateLabel}
            title={workflowGateLabel}
          >
            <Link2 size={15} strokeWidth={1.8} />
            {selectedWorkflowGateId && <span aria-hidden className="composer-workflow-gate-dot" />}
          </button>
        )}
        {onAutoReconnectChange ? (
          <label
            className={`composer-auto-reconnect${autoReconnectEnabled ? " is-on" : ""}`}
            title={t("composer.autoReconnectHelp")}
          >
            <input
              type="checkbox"
              role="switch"
              checked={autoReconnectEnabled}
              aria-label={t("composer.autoReconnect")}
              onChange={(event) => onAutoReconnectChange(event.target.checked)}
            />
            <span className="composer-auto-reconnect-track" aria-hidden="true">
              <span className="composer-auto-reconnect-knob" />
            </span>
            <span className="composer-auto-reconnect-label">
              {t("composer.autoReconnect")}
            </span>
            {autoReconnectEnabled && autoReconnectPhase !== "idle" ? (
              <span className="composer-auto-reconnect-status" role="status">
                {autoReconnectPhase === "waiting"
                  ? `${t("composer.autoReconnectWaiting")} · ${autoReconnectAttempt}`
                  : t("composer.autoReconnectRunning")}
              </span>
            ) : null}
          </label>
        ) : null}
        </div>
        )}
      </div>
      {workflowGatePromptOpen && onSelectWorkflowGateId && onVerifyWorkflowGate && (
        <WorkflowGateBindingPrompt
          selectedWorkflowGateId={selectedWorkflowGateId}
          onSelectWorkflowGateId={onSelectWorkflowGateId}
          onVerifyWorkflowGate={onVerifyWorkflowGate}
          onClose={() => setWorkflowGatePromptOpen(false)}
        />
      )}
    </div>
  );
}
