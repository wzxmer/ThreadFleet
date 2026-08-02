import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DebugEntry, ModelOption, WorkspaceInfo } from "../../../types";
import { getConfigModel, getModelList } from "../../../services/tauri";
import {
  normalizeEffortValue,
  parseModelListResponse,
} from "../utils/modelListResponse";

type UseModelsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onDebug?: (entry: DebugEntry) => void;
  preferredModelId?: string | null;
  providerModels?: ModelOption[];
  preferredEffort?: string | null;
  selectionKey?: string | null;
};

const CONFIG_MODEL_DESCRIPTION = "Configured in CODEX_HOME/config.toml";
const CODEX_AUTO_REVIEW_MODEL = "codex-auto-review";

const formatConfigModelDisplayName = (model: string): string => {
  if (model === CODEX_AUTO_REVIEW_MODEL) {
    return "Codex Auto Review (config)";
  }
  return `${model} (config)`;
};

const findModelByIdOrModel = (
  models: ModelOption[],
  idOrModel: string | null,
): ModelOption | null => {
  if (!idOrModel) {
    return null;
  }
  return (
    models.find((model) => model.id === idOrModel) ??
    models.find((model) => model.model === idOrModel) ??
    null
  );
};

const pickDefaultModel = (models: ModelOption[], configModel: string | null) =>
  findModelByIdOrModel(models, configModel) ??
  models.find((model) => model.isDefault) ??
  models[0] ??
  null;

export function useModels({
  activeWorkspace,
  onDebug,
  preferredModelId = null,
  providerModels = [],
  preferredEffort = null,
  selectionKey = null,
}: UseModelsOptions) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [configModel, setConfigModel] = useState<string | null>(null);
  const [selectedModelId, setSelectedModelIdState] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffortState] = useState<string | null>(null);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const lastFetchedWorkspaceId = useRef<string | null>(null);
  const inFlightWorkspaceIds = useRef(new Set<string>());
  const hasUserSelectedModel = useRef(false);
  const hasUserSelectedEffort = useRef(false);
  const lastWorkspaceId = useRef<string | null>(null);
  const lastSelectionKey = useRef<string | null>(null);
  const wasConnected = useRef(false);
  const hadProviderModels = useRef(false);
  const activeWorkspaceIdRef = useRef<string | null>(null);

  const workspaceId = activeWorkspace?.id ?? null;
  const isConnected = Boolean(activeWorkspace?.connected);
  activeWorkspaceIdRef.current = workspaceId;

  useEffect(() => {
    if (selectionKey === lastSelectionKey.current) {
      return;
    }
    lastSelectionKey.current = selectionKey;
    hasUserSelectedModel.current = false;
    hasUserSelectedEffort.current = false;
  }, [selectionKey]);

  useEffect(() => {
    if (workspaceId === lastWorkspaceId.current) {
      return;
    }
    hasUserSelectedModel.current = false;
    hasUserSelectedEffort.current = false;
    lastWorkspaceId.current = workspaceId;
    setConfigModel(null);
  }, [workspaceId]);

  useEffect(() => {
    if (selectedEffort === null) {
      return;
    }
    if (selectedEffort.trim().length > 0) {
      return;
    }
    hasUserSelectedEffort.current = false;
    setSelectedEffortState(null);
  }, [selectedEffort]);

  const setSelectedModelId = useCallback((next: string | null) => {
    hasUserSelectedModel.current = true;
    setSelectedModelIdState(next);
  }, []);

  const setSelectedEffort = useCallback((next: string | null) => {
    hasUserSelectedEffort.current = true;
    setSelectedEffortState(next);
  }, []);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === selectedModelId) ?? null,
    [models, selectedModelId],
  );

  const reasoningSupported = useMemo(() => {
    if (!selectedModel) {
      return false;
    }
    return (
      selectedModel.supportedReasoningEfforts.length > 0 ||
      selectedModel.defaultReasoningEffort !== null
    );
  }, [selectedModel]);

  const reasoningOptions = useMemo(() => {
    const supported = selectedModel?.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort,
    );
    if (supported && supported.length > 0) {
      return supported;
    }
    const defaultEffort = normalizeEffortValue(selectedModel?.defaultReasoningEffort);
    return defaultEffort ? [defaultEffort] : [];
  }, [selectedModel]);

  const resolveEffort = useCallback(
    (model: ModelOption, preferCurrent: boolean) => {
      const supportedEfforts = model.supportedReasoningEfforts.map(
        (effort) => effort.reasoningEffort,
      );
      const currentEffort = normalizeEffortValue(selectedEffort);
      const supports = (effort: string | null) =>
        effort !== null &&
        supportedEfforts.some(
          (supported) => supported.toLocaleLowerCase() === effort.toLocaleLowerCase(),
        );
      if (preferCurrent && currentEffort &&
        (supportedEfforts.length === 0 || supports(currentEffort))) {
        return currentEffort;
      }
      if (supportedEfforts.length === 0) {
        return normalizeEffortValue(preferredEffort);
      }
      const preferred = normalizeEffortValue(preferredEffort);
      if (supports(preferred)) {
        return preferred;
      }
      const defaultEffort = normalizeEffortValue(model.defaultReasoningEffort);
      if (supports(defaultEffort)) {
        return defaultEffort;
      }
      return supportedEfforts[0] ?? null;
    },
    [preferredEffort, selectedEffort],
  );

  const refreshModels = useCallback(async () => {
    if (!workspaceId || !isConnected) {
      return;
    }
    if (inFlightWorkspaceIds.current.has(workspaceId)) {
      return;
    }
    inFlightWorkspaceIds.current.add(workspaceId);
    setIsRefreshingModels(true);
    onDebug?.({
      id: `${Date.now()}-client-model-list`,
      timestamp: Date.now(),
      source: "client",
      label: "model/list",
      payload: { workspaceId },
    });
    try {
      const [modelListResult, configModelResult] = await Promise.allSettled([
        getModelList(workspaceId),
        getConfigModel(workspaceId),
      ]);
      if (activeWorkspaceIdRef.current !== workspaceId) {
        return;
      }
      const configModelFromConfig =
        configModelResult.status === "fulfilled"
          ? configModelResult.value
          : null;
      if (configModelResult.status === "rejected") {
        onDebug?.({
          id: `${Date.now()}-client-config-model-error`,
          timestamp: Date.now(),
          source: "error",
          label: "config/model error",
          payload:
            configModelResult.reason instanceof Error
              ? configModelResult.reason.message
              : String(configModelResult.reason),
        });
      }
      const response =
        modelListResult.status === "fulfilled" ? modelListResult.value : null;
      if (modelListResult.status === "rejected") {
        onDebug?.({
          id: `${Date.now()}-client-model-list-error`,
          timestamp: Date.now(),
          source: "error",
          label: "model/list error",
          payload:
            modelListResult.reason instanceof Error
              ? modelListResult.reason.message
              : String(modelListResult.reason),
        });
        setConfigModel(configModelFromConfig);
        return;
      }
      onDebug?.({
        id: `${Date.now()}-server-model-list`,
        timestamp: Date.now(),
        source: "server",
        label: "model/list response",
        payload: response,
      });
      const effectiveConfigModel =
        providerModels.length > 0 ? preferredModelId : configModelFromConfig;
      setConfigModel(effectiveConfigModel);
      const dataFromServer: ModelOption[] = parseModelListResponse(response);
      const data = (() => {
        if (providerModels.length > 0) {
          return providerModels;
        }
        if (!configModelFromConfig) {
          return dataFromServer;
        }
        const hasConfigModel = dataFromServer.some(
          (model) => model.model === configModelFromConfig,
        );
        if (hasConfigModel) {
          return dataFromServer;
        }
        const configOption: ModelOption = {
          id: configModelFromConfig,
          model: configModelFromConfig,
          displayName: formatConfigModelDisplayName(configModelFromConfig),
          description: CONFIG_MODEL_DESCRIPTION,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          isDefault: false,
        };
        return [configOption, ...dataFromServer];
      })();
      setModels(data);
      lastFetchedWorkspaceId.current = workspaceId;
      const defaultModel = pickDefaultModel(data, effectiveConfigModel);
      const existingSelection = findModelByIdOrModel(data, selectedModelId);
      if (selectedModelId && !existingSelection) {
        hasUserSelectedModel.current = false;
      }
      const preferredSelection = findModelByIdOrModel(data, preferredModelId);
      const shouldKeepExisting =
        hasUserSelectedModel.current && existingSelection !== null;
      const nextSelection =
        (shouldKeepExisting ? existingSelection : null) ??
        preferredSelection ??
        defaultModel ??
        existingSelection;
      if (nextSelection) {
        if (nextSelection.id !== selectedModelId) {
          setSelectedModelIdState(nextSelection.id);
        }
        const nextEffort = resolveEffort(
          nextSelection,
          hasUserSelectedEffort.current,
        );
        if (nextEffort !== selectedEffort) {
          setSelectedEffortState(nextEffort);
        }
      }
    } finally {
      inFlightWorkspaceIds.current.delete(workspaceId);
      setIsRefreshingModels(inFlightWorkspaceIds.current.size > 0);
    }
  }, [
    isConnected,
    onDebug,
    preferredModelId,
    providerModels,
    selectedEffort,
    selectedModelId,
    resolveEffort,
    workspaceId,
  ]);

  useEffect(() => {
    if (providerModels.length > 0) {
      hadProviderModels.current = true;
      setModels(providerModels);
      setConfigModel(preferredModelId);
      const currentSelection = findModelByIdOrModel(providerModels, selectedModelId);
      const preferredSelection = findModelByIdOrModel(providerModels, preferredModelId);
      const nextSelection =
        (hasUserSelectedModel.current ? currentSelection : null) ??
        preferredSelection ??
        providerModels.find((model) => model.isDefault) ??
        providerModels[0] ??
        null;
      if (nextSelection) {
        if (nextSelection.id !== selectedModelId) {
          setSelectedModelIdState(nextSelection.id);
        }
        const nextEffort = resolveEffort(
          nextSelection,
          hasUserSelectedEffort.current,
        );
        if (nextEffort !== selectedEffort) {
          setSelectedEffortState(nextEffort);
        }
      }
      return;
    }
    if (!hadProviderModels.current) {
      return;
    }
    hadProviderModels.current = false;
    lastFetchedWorkspaceId.current = null;
    void refreshModels();
  }, [preferredModelId, providerModels, refreshModels, resolveEffort, selectedEffort, selectedModelId]);

  useEffect(() => {
    const reconnected = isConnected && !wasConnected.current;
    wasConnected.current = isConnected;
    if (!workspaceId || !isConnected) {
      return;
    }
    if (
      !reconnected &&
      lastFetchedWorkspaceId.current === workspaceId &&
      models.length > 0
    ) {
      return;
    }
    refreshModels();
  }, [isConnected, models.length, refreshModels, workspaceId]);

  useEffect(() => {
    if (!selectedModel) {
      return;
    }
    const currentEffort = normalizeEffortValue(selectedEffort);
    const supportedEfforts = selectedModel.supportedReasoningEfforts.map(
      (effort) => effort.reasoningEffort.toLocaleLowerCase(),
    );
    if (
      currentEffort &&
      (supportedEfforts.length === 0 || supportedEfforts.includes(currentEffort.toLocaleLowerCase()))
    ) {
      return;
    }
    const nextEffort = resolveEffort(selectedModel, false);
    hasUserSelectedEffort.current = false;
    if (nextEffort !== selectedEffort) {
      setSelectedEffortState(nextEffort);
    }
  }, [resolveEffort, selectedEffort, selectedModel]);

  useEffect(() => {
    if (!models.length) {
      return;
    }
    const preferredSelection = findModelByIdOrModel(models, preferredModelId);
    const defaultModel = pickDefaultModel(models, configModel);
    const existingSelection = findModelByIdOrModel(models, selectedModelId);
    if (selectedModelId && !existingSelection) {
      hasUserSelectedModel.current = false;
    }
    const shouldKeepUserSelection =
      hasUserSelectedModel.current && existingSelection !== null;
    if (shouldKeepUserSelection) {
      const nextEffort = resolveEffort(existingSelection, hasUserSelectedEffort.current);
      if (nextEffort !== selectedEffort) {
        setSelectedEffortState(nextEffort);
      }
      return;
    }
    const nextSelection =
      preferredSelection ?? defaultModel ?? existingSelection ?? null;
    if (!nextSelection) {
      return;
    }
    if (nextSelection.id !== selectedModelId) {
      setSelectedModelIdState(nextSelection.id);
    }
    const nextEffort = resolveEffort(nextSelection, hasUserSelectedEffort.current);
    if (nextEffort !== selectedEffort) {
      setSelectedEffortState(nextEffort);
    }
  }, [
    configModel,
    models,
    preferredModelId,
    selectedEffort,
    selectedModelId,
    resolveEffort,
  ]);

  return {
    models,
    selectedModel,
    reasoningSupported,
    selectedModelId,
    setSelectedModelId,
    reasoningOptions,
    selectedEffort,
    setSelectedEffort,
    refreshModels,
    isRefreshingModels,
  };
}
