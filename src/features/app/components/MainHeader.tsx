import { useEffect, useMemo, useRef, useState } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import Folder from "lucide-react/dist/esm/icons/folder";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { BranchInfo, OpenAppTarget, WorkspaceInfo } from "../../../types";
import type { ReactNode } from "react";
import { revealInFileManagerLabel } from "../../../utils/platformPaths";
import { BranchList } from "../../git/components/BranchList";
import { filterBranches, findExactBranch } from "../../git/utils/branchSearch";
import { validateBranchName } from "../../git/utils/branchValidation";
import {
  MenuTrigger,
  PopoverSurface,
} from "../../design-system/components/popover/PopoverPrimitives";
import { OpenAppMenu } from "./OpenAppMenu";
import { LaunchScriptButton } from "./LaunchScriptButton";
import { LaunchScriptEntryButton } from "./LaunchScriptEntryButton";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { WorkspaceLaunchScriptsState } from "../hooks/useWorkspaceLaunchScripts";
import { useMenuController } from "../hooks/useMenuController";

type MainHeaderProps = {
  workspace: WorkspaceInfo;
  titleOverride?: string | null;
  parentName?: string | null;
  worktreeLabel?: string | null;
  disableBranchMenu?: boolean;
  parentPath?: string | null;
  worktreePath?: string | null;
  openTargets: OpenAppTarget[];
  openAppIconById: Record<string, string>;
  selectedOpenAppId: string;
  onSelectOpenAppId: (id: string) => void;
  branchName: string;
  branches: BranchInfo[];
  onCheckoutBranch: (name: string) => Promise<void> | void;
  onCreateBranch: (name: string) => Promise<void> | void;
  showWorkspaceTools?: boolean;
  extraActionsNode?: ReactNode;
  launchScript?: string | null;
  launchScriptEditorOpen?: boolean;
  launchScriptDraft?: string;
  launchScriptSaving?: boolean;
  launchScriptError?: string | null;
  onRunLaunchScript?: () => void;
  onOpenLaunchScriptEditor?: () => void;
  onCloseLaunchScriptEditor?: () => void;
  onLaunchScriptDraftChange?: (value: string) => void;
  onSaveLaunchScript?: () => void;
  launchScriptsState?: WorkspaceLaunchScriptsState;
  worktreeRename?: {
    name: string;
    error: string | null;
    notice: string | null;
    isSubmitting: boolean;
    isDirty: boolean;
    upstream?: {
      oldBranch: string;
      newBranch: string;
      error: string | null;
      isSubmitting: boolean;
      onConfirm: () => void;
    } | null;
    onFocus: () => void;
    onChange: (value: string) => void;
    onCancel: () => void;
    onCommit: () => void;
  };
};

export function MainHeader({
  workspace,
  worktreeLabel = null,
  disableBranchMenu = false,
  parentPath = null,
  worktreePath = null,
  openTargets,
  openAppIconById,
  selectedOpenAppId,
  onSelectOpenAppId,
  branchName,
  branches,
  onCheckoutBranch,
  onCreateBranch,
  showWorkspaceTools = true,
  extraActionsNode,
  launchScript = null,
  launchScriptEditorOpen = false,
  launchScriptDraft = "",
  launchScriptSaving = false,
  launchScriptError = null,
  onRunLaunchScript,
  onOpenLaunchScriptEditor,
  onCloseLaunchScriptEditor,
  onLaunchScriptDraftChange,
  onSaveLaunchScript,
  launchScriptsState,
  worktreeRename,
}: MainHeaderProps) {
  const { t } = useI18n();
  const [branchQuery, setBranchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameConfirmRef = useRef<HTMLButtonElement | null>(null);
  const renameOnCancel = worktreeRename?.onCancel;
  const branchMenu = useMenuController({
    onDismiss: () => {
      setBranchQuery("");
      setError(null);
    },
  });
  const infoMenu = useMenuController();
  const { isOpen: menuOpen, setOpen: setMenuOpen, containerRef: menuRef } = branchMenu;
  const { isOpen: infoOpen, containerRef: infoRef } = infoMenu;

  const trimmedQuery = branchQuery.trim();
  const filteredBranches = useMemo(
    () => filterBranches(branches, branchQuery, { mode: "includes", whenEmptyLimit: 12 }),
    [branches, branchQuery],
  );
  const exactMatch = useMemo(
    () => findExactBranch(branches, trimmedQuery),
    [branches, trimmedQuery],
  );
  const canCreate = trimmedQuery.length > 0 && !exactMatch;
  const branchValidationMessage = useMemo(
    () => validateBranchName(trimmedQuery),
    [trimmedQuery],
  );
  const resolvedWorktreePath = worktreePath ?? workspace.path;
  const relativeWorktreePath = useMemo(() => {
    if (!parentPath) {
      return resolvedWorktreePath;
    }
    return resolvedWorktreePath.startsWith(`${parentPath}/`)
      ? resolvedWorktreePath.slice(parentPath.length + 1)
      : resolvedWorktreePath;
  }, [parentPath, resolvedWorktreePath]);
  const cdCommand = useMemo(
    () => `cd "${relativeWorktreePath}"`,
    [relativeWorktreePath],
  );

  useEffect(() => {
    if (!infoOpen && renameOnCancel) {
      renameOnCancel();
    }
  }, [infoOpen, renameOnCancel]);

  return (
    <header className="main-header" data-tauri-drag-region>
      <div className="workspace-header">
        <div className="workspace-context-chips">
          <span
            className="workspace-context-chip workspace-context-chip-project"
            title={workspace.name}
          >
            <Folder size={12} aria-hidden />
            <span>{workspace.name}</span>
          </span>
          {disableBranchMenu ? (
            <div className="workspace-branch-static-row" ref={infoRef}>
              <MenuTrigger
                isOpen={infoOpen}
                popupRole="dialog"
                className="workspace-branch-static-button"
                onClick={infoMenu.toggle}
                data-tauri-drag-region="false"
                title={t("mainHeader.worktreeInfo")}
              >
                {worktreeLabel || branchName}
              </MenuTrigger>
              {infoOpen && (
                <PopoverSurface className="worktree-info-popover" role="dialog">
                  {worktreeRename && (
                    <div className="worktree-info-rename">
                      <span className="worktree-info-label">{t("mainHeader.name")}</span>
                      <div className="worktree-info-command">
                        <input
                          ref={renameInputRef}
                          className="worktree-info-input"
                          value={worktreeRename.name}
                          onFocus={() => {
                            worktreeRename.onFocus();
                            renameInputRef.current?.select();
                          }}
                          onChange={(event) => worktreeRename.onChange(event.target.value)}
                          onBlur={(event) => {
                            const nextTarget = event.relatedTarget as Node | null;
                            if (
                              renameConfirmRef.current &&
                              nextTarget &&
                              renameConfirmRef.current.contains(nextTarget)
                            ) {
                              return;
                            }
                            if (!worktreeRename.isSubmitting && worktreeRename.isDirty) {
                              worktreeRename.onCommit();
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault();
                              if (!worktreeRename.isSubmitting) {
                                worktreeRename.onCancel();
                              }
                            }
                            if (event.key === "Enter" && !worktreeRename.isSubmitting) {
                              event.preventDefault();
                              worktreeRename.onCommit();
                            }
                          }}
                          data-tauri-drag-region="false"
                          disabled={worktreeRename.isSubmitting}
                        />
                        <button
                          type="button"
                          className="icon-button worktree-info-confirm"
                          ref={renameConfirmRef}
                          onClick={() => worktreeRename.onCommit()}
                          disabled={
                            worktreeRename.isSubmitting || !worktreeRename.isDirty
                          }
                          aria-label={t("mainHeader.confirmRename")}
                          title={t("mainHeader.confirmRename")}
                        >
                          <Check aria-hidden />
                        </button>
                      </div>
                      {worktreeRename.error && (
                        <div className="worktree-info-error">{worktreeRename.error}</div>
                      )}
                      {worktreeRename.notice && (
                        <span className="worktree-info-subtle">
                          {worktreeRename.notice}
                        </span>
                      )}
                      {worktreeRename.upstream && (
                        <div className="worktree-info-upstream">
                          <span className="worktree-info-subtle">
                            {t("mainHeader.updateUpstreamQuestion")}{" "}
                            <strong>{worktreeRename.upstream.newBranch}</strong>?
                          </span>
                          <button
                            type="button"
                            className="ghost worktree-info-upstream-button"
                            onClick={worktreeRename.upstream.onConfirm}
                            disabled={worktreeRename.upstream.isSubmitting}
                          >
                            {t("mainHeader.updateUpstream")}
                          </button>
                          {worktreeRename.upstream.error && (
                            <div className="worktree-info-error">
                              {worktreeRename.upstream.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="worktree-info-title">{t("mainHeader.worktree")}</div>
                  <div className="worktree-info-row">
                    <span className="worktree-info-label">
                      {t("mainHeader.terminal")}
                      {parentPath ? t("mainHeader.repoRootSuffix") : ""}
                    </span>
                    <div className="worktree-info-command">
                      <code className="worktree-info-code">
                        {cdCommand}
                      </code>
                      <button
                        type="button"
                        className="worktree-info-copy"
                        onClick={async () => {
                          await navigator.clipboard.writeText(cdCommand);
                        }}
                        data-tauri-drag-region="false"
                        aria-label={t("mainHeader.copyCommand")}
                        title={t("mainHeader.copyCommand")}
                      >
                        <Copy aria-hidden />
                      </button>
                    </div>
                    <span className="worktree-info-subtle">
                      {t("mainHeader.openWorktreeInTerminal")}
                    </span>
                  </div>
                  <div className="worktree-info-row">
                    <span className="worktree-info-label">
                      {t("mainHeader.displayLocation")}
                    </span>
                    <button
                      type="button"
                      className="worktree-info-reveal"
                      onClick={async () => {
                        await revealItemInDir(resolvedWorktreePath);
                      }}
                      data-tauri-drag-region="false"
                    >
                      {revealInFileManagerLabel()}
                    </button>
                  </div>
                </PopoverSurface>
              )}
            </div>
          ) : (
            <div className="workspace-branch-menu" ref={menuRef}>
              <MenuTrigger
                isOpen={menuOpen}
                className="workspace-branch-button"
                onClick={branchMenu.toggle}
                data-tauri-drag-region="false"
              >
                <span className="workspace-branch">{branchName}</span>
                <span className="workspace-branch-caret" aria-hidden>
                  ›
                </span>
              </MenuTrigger>
              {menuOpen && (
                <PopoverSurface
                  className="workspace-branch-dropdown"
                  role="menu"
                  data-tauri-drag-region="false"
                >
                  <div className="branch-actions">
                    <div className="branch-search">
                      <input
                        value={branchQuery}
                        onChange={(event) => {
                          setBranchQuery(event.target.value);
                          setError(null);
                        }}
                        onKeyDown={async (event) => {
                          if (event.key !== "Enter") {
                            return;
                          }
                          event.preventDefault();
                          if (branchValidationMessage) {
                            setError(branchValidationMessage);
                            return;
                          }
                          if (canCreate) {
                            try {
                              await onCreateBranch(trimmedQuery);
                              setMenuOpen(false);
                              setBranchQuery("");
                              setError(null);
                            } catch (err) {
                              setError(
                                err instanceof Error ? err.message : String(err),
                              );
                            }
                            return;
                          }
                          if (exactMatch && exactMatch.name !== branchName) {
                            try {
                              await onCheckoutBranch(exactMatch.name);
                              setMenuOpen(false);
                              setBranchQuery("");
                              setError(null);
                            } catch (err) {
                              setError(
                                err instanceof Error ? err.message : String(err),
                              );
                            }
                          }
                        }}
                        placeholder={t("mainHeader.searchOrCreateBranch")}
                        className="branch-input"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        autoFocus
                        data-tauri-drag-region="false"
                        aria-label={t("mainHeader.searchBranch")}
                      />
                      <button
                        type="button"
                        className="branch-create-button"
                        disabled={!canCreate || Boolean(branchValidationMessage)}
                        onClick={async () => {
                          if (branchValidationMessage) {
                            setError(branchValidationMessage);
                            return;
                          }
                          if (!canCreate) {
                            return;
                          }
                          try {
                            await onCreateBranch(trimmedQuery);
                            setMenuOpen(false);
                            setBranchQuery("");
                            setError(null);
                          } catch (err) {
                            setError(
                              err instanceof Error ? err.message : String(err),
                            );
                          }
                        }}
                        data-tauri-drag-region="false"
                      >
                        {t("mainHeader.create")}
                      </button>
                    </div>
                    {branchValidationMessage && (
                      <div className="branch-error">{branchValidationMessage}</div>
                    )}
                    {canCreate && !branchValidationMessage && (
                      <div className="branch-create-hint">
                        {t("mainHeader.createBranch")} “{trimmedQuery}”
                      </div>
                    )}
                  </div>
                  <BranchList
                    branches={filteredBranches}
                    currentBranch={branchName}
                    listClassName="branch-list"
                    listRole="none"
                    itemClassName="branch-item"
                    currentItemClassName="is-active"
                    itemRole="menuitem"
                    itemDataTauriDragRegion="false"
                    emptyClassName="branch-empty"
                    emptyText={t("mainHeader.noBranches")}
                    onSelect={async (branch) => {
                      if (branch.name === branchName) {
                        return;
                      }
                      try {
                        await onCheckoutBranch(branch.name);
                        setMenuOpen(false);
                        setBranchQuery("");
                        setError(null);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  />
                  {error && <div className="branch-error">{error}</div>}
                </PopoverSurface>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="main-header-actions">
        <div
          id="main-header-message-tools"
          className="main-header-message-tools"
          data-tauri-drag-region="false"
        />
        <div
          id="main-header-composer-tools"
          className="main-header-composer-tools"
          data-tauri-drag-region="false"
        />
        {showWorkspaceTools &&
          onRunLaunchScript &&
          onOpenLaunchScriptEditor &&
          onCloseLaunchScriptEditor &&
          onLaunchScriptDraftChange &&
          onSaveLaunchScript && (
            <div className="launch-script-cluster">
              <LaunchScriptButton
                launchScript={launchScript}
                editorOpen={launchScriptEditorOpen}
                draftScript={launchScriptDraft}
                isSaving={launchScriptSaving}
                error={launchScriptError}
                onRun={onRunLaunchScript}
                onOpenEditor={onOpenLaunchScriptEditor}
                onCloseEditor={onCloseLaunchScriptEditor}
                onDraftChange={onLaunchScriptDraftChange}
                onSave={onSaveLaunchScript}
                showNew={Boolean(launchScriptsState)}
                newEditorOpen={launchScriptsState?.newEditorOpen}
                newDraftScript={launchScriptsState?.newDraftScript}
                newDraftIcon={launchScriptsState?.newDraftIcon}
                newDraftLabel={launchScriptsState?.newDraftLabel}
                newError={launchScriptsState?.newError ?? null}
                onOpenNew={launchScriptsState?.onOpenNew}
                onCloseNew={launchScriptsState?.onCloseNew}
                onNewDraftChange={launchScriptsState?.onNewDraftScriptChange}
                onNewDraftIconChange={launchScriptsState?.onNewDraftIconChange}
                onNewDraftLabelChange={launchScriptsState?.onNewDraftLabelChange}
                onCreateNew={launchScriptsState?.onCreateNew}
              />
              {launchScriptsState?.launchScripts.map((entry) => (
                <LaunchScriptEntryButton
                  key={entry.id}
                  entry={entry}
                  editorOpen={launchScriptsState.editorOpenId === entry.id}
                  draftScript={launchScriptsState.draftScript}
                  draftIcon={launchScriptsState.draftIcon}
                  draftLabel={launchScriptsState.draftLabel}
                  isSaving={launchScriptsState.isSaving}
                  error={launchScriptsState.errorById[entry.id] ?? null}
                  onRun={() => launchScriptsState.onRunScript(entry.id)}
                  onOpenEditor={() => launchScriptsState.onOpenEditor(entry.id)}
                  onCloseEditor={launchScriptsState.onCloseEditor}
                  onDraftChange={launchScriptsState.onDraftScriptChange}
                  onDraftIconChange={launchScriptsState.onDraftIconChange}
                  onDraftLabelChange={launchScriptsState.onDraftLabelChange}
                  onSave={launchScriptsState.onSaveScript}
                  onDelete={launchScriptsState.onDeleteScript}
                />
              ))}
            </div>
          )}
        {showWorkspaceTools ? (
          <OpenAppMenu
            path={resolvedWorktreePath}
            openTargets={openTargets}
            selectedOpenAppId={selectedOpenAppId}
            onSelectOpenAppId={onSelectOpenAppId}
            iconById={openAppIconById}
          />
        ) : null}
        {extraActionsNode}
      </div>
    </header>
  );
}
