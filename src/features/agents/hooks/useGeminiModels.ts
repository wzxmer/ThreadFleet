import { useCallback, useEffect, useRef, useState } from "react";
import { agentRuntimeRequest } from "@services/tauri";
import type { AgentEngine, CodexKeyProfile } from "@/types";
import { useI18n } from "@/features/i18n/I18nProvider";

type GeminiModel = { id: string; model: string; displayName: string };

export function useGeminiModels(
  workspaceId: string | null,
  threadId: string | null,
  engine: AgentEngine,
  onModel: (model: string | null) => void,
  provider: CodexKeyProfile | null = null,
  beforeRequest?: () => Promise<unknown>,
) {
  const { t } = useI18n();
  const [models, setModels] = useState<GeminiModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (engine !== "gemini" || !workspaceId) {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await beforeRequest?.();
      if (generation !== requestGeneration.current) return;
      const result = await agentRuntimeRequest(workspaceId, "models", { threadId });
      if (generation !== requestGeneration.current) return;
      const data = result?.models ?? result;
      const available: GeminiModel[] = Array.isArray(data?.availableModels)
        ? data.availableModels.flatMap((entry: { modelId?: string; name?: string }) =>
          typeof entry.modelId === "string" ? [{ id: entry.modelId, model: entry.modelId, displayName: entry.name ?? entry.modelId }] : [])
        : [];
      setModels(available);
      onModel(typeof data?.currentModelId === "string" ? data.currentModelId : provider?.model?.trim() || null);
    } catch (cause) {
      if (generation === requestGeneration.current) {
        setModels([]);
        onModel(null);
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message.includes("Gemini authentication required")
          ? `${t("agents.geminiAuthenticationHelp")}\n${message}`
          : message);
      }
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [engine, workspaceId, threadId, onModel, provider, beforeRequest, t]);
  useEffect(() => {
    void refresh();
    return () => { requestGeneration.current += 1; };
  }, [refresh]);
  return { models, loading, error, refresh };
}
