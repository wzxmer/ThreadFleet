import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppSettings,
  CodexDoctorResult,
  CodexSyncDiagnostics,
  CodexStatus,
  CodexUpdateResult,
  ComputerControlCapabilitySnapshot,
  WorkspaceInfo,
} from "@/types";
import {
  connectWorkspace,
  getCodexStatus,
  getCodexSyncDiagnostics,
} from "@services/tauri";
import { getComputerControlStatus, listMcpServerStatus } from "@services/tauri";
import { useGlobalAgentsMd } from "./useGlobalAgentsMd";
import { useGlobalCodexConfigToml } from "./useGlobalCodexConfigToml";
import { useSettingsDefaultModels } from "./useSettingsDefaultModels";
import { buildEditorContentMeta } from "@settings/components/settingsViewHelpers";
import { normalizeCodexArgsInput } from "@/utils/codexArgsInput";

type UseSettingsCodexSectionArgs = {
  appSettings: AppSettings;
  projects: WorkspaceInfo[];
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  onRunDoctor: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexDoctorResult>;
  onRunCodexUpdate?: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexUpdateResult>;
};

export type SettingsCodexSectionProps = {
  appSettings: AppSettings;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  defaultModels: ReturnType<typeof useSettingsDefaultModels>["models"];
  defaultModelsLoading: boolean;
  defaultModelsError: string | null;
  defaultModelsConnectedWorkspaceCount: number;
  onRefreshDefaultModels: () => void;
  codexPathDraft: string;
  codexArgsDraft: string;
  codexHomeDraft: string;
  codexDirty: boolean;
  codexHomeReconnectState: {
    required: boolean;
    status: "idle" | "running" | "done";
    error: string | null;
  };
  isSavingSettings: boolean;
  doctorState: {
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  };
  codexUpdateState: {
    status: "idle" | "running" | "done";
    result: CodexUpdateResult | null;
  };
  codexStatusState: {
    status: "idle" | "loading" | "done";
    result: CodexStatus | null;
    error: string | null;
  };
  codexSyncDiagnosticsState: {
    status: "idle" | "loading" | "done";
    result: CodexSyncDiagnostics | null;
    error: string | null;
  };
  mcpStatusState: {
    status: "idle" | "loading" | "done";
    result: unknown | null;
    error: string | null;
    workspaceName: string | null;
  };
  computerControlStatusState: {
    status: "idle" | "loading" | "done";
    result: ComputerControlCapabilitySnapshot | null;
    error: string | null;
    workspaceName: string | null;
  };
  globalAgentsMeta: string;
  globalAgentsError: string | null;
  globalAgentsContent: string;
  globalAgentsLoading: boolean;
  globalAgentsRefreshDisabled: boolean;
  globalAgentsSaveDisabled: boolean;
  globalAgentsSaveLabel: string;
  globalConfigMeta: string;
  globalConfigError: string | null;
  globalConfigContent: string;
  globalConfigLoading: boolean;
  globalConfigRefreshDisabled: boolean;
  globalConfigSaveDisabled: boolean;
  globalConfigSaveLabel: string;
  onSetCodexPathDraft: Dispatch<SetStateAction<string>>;
  onSetCodexArgsDraft: Dispatch<SetStateAction<string>>;
  onSetCodexHomeDraft: Dispatch<SetStateAction<string>>;
  onSetGlobalAgentsContent: (value: string) => void;
  onSetGlobalConfigContent: (value: string) => void;
  onBrowseCodex: () => Promise<void>;
  onBrowseCodexHome: () => Promise<void>;
  onSaveCodexSettings: () => Promise<void>;
  onReconnectCodexHomeWorkspaces: () => Promise<void>;
  onRunDoctor: () => Promise<void>;
  onRunCodexUpdate: () => Promise<void>;
  onRefreshCodexStatus: () => void;
  onRefreshCodexSyncDiagnostics: () => void;
  onRefreshMcpStatus: () => void;
  onRefreshComputerControlStatus: () => void;
  onRefreshGlobalAgents: () => void;
  onSaveGlobalAgents: () => void;
  onRefreshGlobalConfig: () => void;
  onSaveGlobalConfig: () => void;
};

export const useSettingsCodexSection = ({
  appSettings,
  projects,
  onUpdateAppSettings,
  onRunDoctor,
  onRunCodexUpdate,
}: UseSettingsCodexSectionArgs): SettingsCodexSectionProps => {
  const [codexPathDraft, setCodexPathDraft] = useState(appSettings.codexBin ?? "");
  const [codexArgsDraft, setCodexArgsDraft] = useState(appSettings.codexArgs ?? "");
  const [codexHomeDraft, setCodexHomeDraft] = useState(appSettings.codexHome ?? "");
  const [codexHomeReconnectState, setCodexHomeReconnectState] = useState<{
    required: boolean;
    status: "idle" | "running" | "done";
    error: string | null;
  }>({ required: false, status: "idle", error: null });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [doctorState, setDoctorState] = useState<{
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  }>({ status: "idle", result: null });
  const [codexUpdateState, setCodexUpdateState] = useState<{
    status: "idle" | "running" | "done";
    result: CodexUpdateResult | null;
  }>({ status: "idle", result: null });
  const [codexStatusState, setCodexStatusState] = useState<{
    status: "idle" | "loading" | "done";
    result: CodexStatus | null;
    error: string | null;
  }>({ status: "idle", result: null, error: null });
  const [codexSyncDiagnosticsState, setCodexSyncDiagnosticsState] = useState<{
    status: "idle" | "loading" | "done";
    result: CodexSyncDiagnostics | null;
    error: string | null;
  }>({ status: "idle", result: null, error: null });
  const [mcpStatusState, setMcpStatusState] = useState<{
    status: "idle" | "loading" | "done";
    result: unknown | null;
    error: string | null;
    workspaceName: string | null;
  }>({ status: "idle", result: null, error: null, workspaceName: null });
  const [computerControlStatusState, setComputerControlStatusState] = useState<{
    status: "idle" | "loading" | "done";
    result: ComputerControlCapabilitySnapshot | null;
    error: string | null;
    workspaceName: string | null;
  }>({ status: "idle", result: null, error: null, workspaceName: null });

  const {
    models: defaultModels,
    isLoading: defaultModelsLoading,
    error: defaultModelsError,
    connectedWorkspaceCount: defaultModelsConnectedWorkspaceCount,
    refresh: refreshDefaultModels,
  } = useSettingsDefaultModels(projects);

  const {
    content: globalAgentsContent,
    exists: globalAgentsExists,
    truncated: globalAgentsTruncated,
    isLoading: globalAgentsLoading,
    isSaving: globalAgentsSaving,
    error: globalAgentsError,
    isDirty: globalAgentsDirty,
    setContent: setGlobalAgentsContent,
    refresh: refreshGlobalAgents,
    save: saveGlobalAgents,
  } = useGlobalAgentsMd();

  const {
    content: globalConfigContent,
    exists: globalConfigExists,
    truncated: globalConfigTruncated,
    isLoading: globalConfigLoading,
    isSaving: globalConfigSaving,
    error: globalConfigError,
    isDirty: globalConfigDirty,
    setContent: setGlobalConfigContent,
    refresh: refreshGlobalConfig,
    save: saveGlobalConfig,
  } = useGlobalCodexConfigToml();

  const globalAgentsEditorMeta = buildEditorContentMeta({
    isLoading: globalAgentsLoading,
    isSaving: globalAgentsSaving,
    exists: globalAgentsExists,
    truncated: globalAgentsTruncated,
    isDirty: globalAgentsDirty,
  });

  const globalConfigEditorMeta = buildEditorContentMeta({
    isLoading: globalConfigLoading,
    isSaving: globalConfigSaving,
    exists: globalConfigExists,
    truncated: globalConfigTruncated,
    isDirty: globalConfigDirty,
  });

  const refreshCodexStatus = useCallback(() => {
    setCodexStatusState((current) => ({
      status: "loading",
      result: current.result,
      error: null,
    }));
    getCodexStatus()
      .then((result) => {
        setCodexStatusState({ status: "done", result, error: null });
      })
      .catch((error) => {
        setCodexStatusState({
          status: "done",
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  const refreshCodexSyncDiagnostics = useCallback(() => {
    setCodexSyncDiagnosticsState((current) => ({
      status: "loading",
      result: current.result,
      error: null,
    }));
    getCodexSyncDiagnostics()
      .then((result) => {
        setCodexSyncDiagnosticsState({ status: "done", result, error: null });
      })
      .catch((error) => {
        setCodexSyncDiagnosticsState({
          status: "done",
          result: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  const refreshMcpStatus = useCallback(() => {
    const workspace = projects.find((entry) => entry.connected) ?? null;
    if (!workspace) {
      setMcpStatusState({
        status: "done",
        result: null,
        error: "settings.codex.mcpNeedsWorkspace",
        workspaceName: null,
      });
      return;
    }
    setMcpStatusState((current) => ({
      status: "loading",
      result: current.result,
      error: null,
      workspaceName: workspace.name,
    }));
    listMcpServerStatus(workspace.id)
      .then((result) => {
        setMcpStatusState({
          status: "done",
          result,
          error: null,
          workspaceName: workspace.name,
        });
      })
      .catch((error) => {
        setMcpStatusState({
          status: "done",
          result: null,
          error: error instanceof Error ? error.message : String(error),
          workspaceName: workspace.name,
        });
      });
  }, [projects]);

  const refreshComputerControlStatus = useCallback(() => {
    const workspace = projects.find((entry) => entry.connected) ?? null;
    if (!workspace) {
      setComputerControlStatusState({
        status: "done",
        result: null,
        error: "settings.codex.mcpNeedsWorkspace",
        workspaceName: null,
      });
      return;
    }
    setComputerControlStatusState((current) => ({
      status: "loading",
      result: current.result,
      error: null,
      workspaceName: workspace.name,
    }));
    getComputerControlStatus(workspace.id, true)
      .then((result) => {
        setComputerControlStatusState({
          status: "done",
          result,
          error: null,
          workspaceName: workspace.name,
        });
      })
      .catch((error) => {
        setComputerControlStatusState({
          status: "done",
          result: null,
          error: error instanceof Error ? error.message : String(error),
          workspaceName: workspace.name,
        });
      });
  }, [projects]);

  useEffect(() => {
    refreshCodexStatus();
    refreshCodexSyncDiagnostics();
    refreshComputerControlStatus();
  }, [
    refreshCodexStatus,
    refreshCodexSyncDiagnostics,
    refreshComputerControlStatus,
  ]);

  useEffect(() => {
    setCodexPathDraft(appSettings.codexBin ?? "");
  }, [appSettings.codexBin]);

  useEffect(() => {
    setCodexArgsDraft(appSettings.codexArgs ?? "");
  }, [appSettings.codexArgs]);

  useEffect(() => {
    setCodexHomeDraft(appSettings.codexHome ?? "");
  }, [appSettings.codexHome]);

  const nextCodexBin = codexPathDraft.trim() ? codexPathDraft.trim() : null;
  const nextCodexArgs = normalizeCodexArgsInput(codexArgsDraft);
  const nextCodexHome = codexHomeDraft.trim() ? codexHomeDraft.trim() : null;
  const codexDirty =
    nextCodexBin !== (appSettings.codexBin ?? null) ||
    nextCodexArgs !== (appSettings.codexArgs ?? null) ||
    nextCodexHome !== (appSettings.codexHome ?? null);

  const handleBrowseCodex = async () => {
    const selection = await open({ multiple: false, directory: false });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setCodexPathDraft(selection);
  };

  const handleBrowseCodexHome = async () => {
    const selection = await open({ multiple: false, directory: true });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setCodexHomeDraft(selection);
  };

  const handleSaveCodexSettings = async () => {
    setIsSavingSettings(true);
    const codexHomeChanged = nextCodexHome !== (appSettings.codexHome ?? null);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        codexBin: nextCodexBin,
        codexArgs: nextCodexArgs,
        codexHome: nextCodexHome,
      });
      if (codexHomeChanged) {
        setCodexHomeReconnectState({
          required: true,
          status: "idle",
          error: null,
        });
      }
      refreshCodexStatus();
      refreshCodexSyncDiagnostics();
      void refreshGlobalAgents();
      void refreshGlobalConfig();
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleReconnectCodexHomeWorkspaces = async () => {
    const connectedProjects = projects.filter((project) => project.connected);
    if (connectedProjects.length === 0) {
      setCodexHomeReconnectState({
        required: false,
        status: "done",
        error: null,
      });
      return;
    }
    setCodexHomeReconnectState({
      required: true,
      status: "running",
      error: null,
    });
    try {
      await Promise.all(connectedProjects.map((project) => connectWorkspace(project.id)));
      setCodexHomeReconnectState({
        required: false,
        status: "done",
        error: null,
      });
    } catch (error) {
      setCodexHomeReconnectState({
        required: true,
        status: "done",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleRunDoctor = async () => {
    setDoctorState({ status: "running", result: null });
    try {
      const result = await onRunDoctor(nextCodexBin, nextCodexArgs);
      setDoctorState({ status: "done", result });
    } catch (error) {
      setDoctorState({
        status: "done",
        result: {
          ok: false,
          codexBin: nextCodexBin,
          version: null,
          appServerOk: false,
          details: error instanceof Error ? error.message : String(error),
          path: null,
          nodeOk: false,
          nodeVersion: null,
          nodeDetails: null,
        },
      });
    }
  };

  const handleRunCodexUpdate = async () => {
    setCodexUpdateState({ status: "running", result: null });
    try {
      if (!onRunCodexUpdate) {
        setCodexUpdateState({
          status: "done",
          result: {
            ok: false,
            method: "unknown",
            package: null,
            beforeVersion: null,
            afterVersion: null,
            upgraded: false,
            output: null,
            details: "Codex updates are not available in this build.",
          },
        });
        return;
      }

      const result = await onRunCodexUpdate(nextCodexBin, nextCodexArgs);
      setCodexUpdateState({ status: "done", result });
    } catch (error) {
      setCodexUpdateState({
        status: "done",
        result: {
          ok: false,
          method: "unknown",
          package: null,
          beforeVersion: null,
          afterVersion: null,
          upgraded: false,
          output: null,
          details: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  return {
    appSettings,
    onUpdateAppSettings,
    defaultModels,
    defaultModelsLoading,
    defaultModelsError,
    defaultModelsConnectedWorkspaceCount,
    onRefreshDefaultModels: () => {
      void refreshDefaultModels();
    },
    codexPathDraft,
    codexArgsDraft,
    codexHomeDraft,
    codexDirty,
    codexHomeReconnectState,
    isSavingSettings,
    doctorState,
    codexUpdateState,
    codexStatusState,
    codexSyncDiagnosticsState,
    mcpStatusState,
    computerControlStatusState,
    globalAgentsMeta: globalAgentsEditorMeta.meta,
    globalAgentsError,
    globalAgentsContent,
    globalAgentsLoading,
    globalAgentsRefreshDisabled: globalAgentsEditorMeta.refreshDisabled,
    globalAgentsSaveDisabled: globalAgentsEditorMeta.saveDisabled,
    globalAgentsSaveLabel: globalAgentsEditorMeta.saveLabel,
    globalConfigMeta: globalConfigEditorMeta.meta,
    globalConfigError,
    globalConfigContent,
    globalConfigLoading,
    globalConfigRefreshDisabled: globalConfigEditorMeta.refreshDisabled,
    globalConfigSaveDisabled: globalConfigEditorMeta.saveDisabled,
    globalConfigSaveLabel: globalConfigEditorMeta.saveLabel,
    onSetCodexPathDraft: setCodexPathDraft,
    onSetCodexArgsDraft: setCodexArgsDraft,
    onSetCodexHomeDraft: setCodexHomeDraft,
    onSetGlobalAgentsContent: setGlobalAgentsContent,
    onSetGlobalConfigContent: setGlobalConfigContent,
    onBrowseCodex: handleBrowseCodex,
    onBrowseCodexHome: handleBrowseCodexHome,
    onSaveCodexSettings: handleSaveCodexSettings,
    onReconnectCodexHomeWorkspaces: handleReconnectCodexHomeWorkspaces,
    onRunDoctor: handleRunDoctor,
    onRunCodexUpdate: handleRunCodexUpdate,
    onRefreshCodexStatus: refreshCodexStatus,
    onRefreshCodexSyncDiagnostics: refreshCodexSyncDiagnostics,
    onRefreshMcpStatus: refreshMcpStatus,
    onRefreshComputerControlStatus: refreshComputerControlStatus,
    onRefreshGlobalAgents: () => {
      void refreshGlobalAgents();
    },
    onSaveGlobalAgents: () => {
      void saveGlobalAgents();
    },
    onRefreshGlobalConfig: () => {
      void refreshGlobalConfig();
    },
    onSaveGlobalConfig: () => {
      void saveGlobalConfig();
    },
  };
};
