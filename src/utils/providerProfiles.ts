import type {
  AppSettings,
  CodexKeyProfile,
  CodexProviderModel,
  ModelOption,
} from "@/types";
import {
  parseCredentialSelectionId,
  providersToLegacyProfiles,
} from "@/utils/providerCredentials";
import {
  normalizeReasoningEffortValue,
  parseReasoningEffortOptions,
} from "@utils/reasoningEfforts";

const PROVIDER_BASE_URLS: Partial<
  Record<NonNullable<CodexKeyProfile["providerKind"]>, string>
> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  opencode: "https://opencode.ai/zen/go/v1",
};

const PROVIDER_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
].map(
  (reasoningEffort) => ({ reasoningEffort, description: "" }),
);

export function resolveCodexProviderBaseUrl(
  providerKind: CodexKeyProfile["providerKind"],
  baseUrl: string | null | undefined,
): string | null {
  const explicit = baseUrl?.trim();
  if (explicit) {
    return explicit;
  }
  return PROVIDER_BASE_URLS[providerKind ?? "custom"] ?? null;
}

export function resolveCodexProviderModel(
  providerModel: string | null | undefined,
  threadModel: string | null | undefined,
): string | null {
  return threadModel?.trim() || providerModel?.trim() || null;
}

export function mergeCodexProviderModels(
  ...modelLists: Array<readonly CodexProviderModel[] | null | undefined>
): CodexProviderModel[] {
  const merged = new Map<string, CodexProviderModel>();
  for (const models of modelLists) {
    for (const model of models ?? []) {
      const id = model.id.trim();
      if (!id) {
        continue;
      }
      const previous = merged.get(id);
      const supportedReasoningEfforts = model.supportedReasoningEfforts === undefined
        ? previous?.supportedReasoningEfforts
        : parseReasoningEffortOptions(model.supportedReasoningEfforts);
      const defaultReasoningEffort = model.defaultReasoningEffort === undefined
        ? previous?.defaultReasoningEffort
        : normalizeReasoningEffortValue(model.defaultReasoningEffort);
      merged.set(id, {
        id,
        name: model.name?.trim() || previous?.name || null,
        contextWindow: model.contextWindow ?? previous?.contextWindow ?? null,
        ...(supportedReasoningEfforts !== undefined ? { supportedReasoningEfforts } : {}),
        ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
      });
    }
  }
  return [...merged.values()];
}

export function applyRefreshedCodexProviderModels(
  settings: AppSettings,
  profileId: string,
  refreshedModels: readonly CodexProviderModel[],
  refreshedAtMs: number,
): AppSettings {
  const selection = parseCredentialSelectionId(profileId);
  if (selection && settings.codexProviders?.length) {
    let providerChanged = false;
    const codexProviders = settings.codexProviders.map((provider) => {
      if (provider.id !== selection.providerId) return provider;
      providerChanged = true;
      return {
        ...provider,
        cachedModels: mergeCodexProviderModels(provider.cachedModels, refreshedModels),
        lastModelRefreshAtMs: refreshedAtMs,
      };
    });
    if (providerChanged) {
      return {
        ...settings,
        codexProviders,
        codexKeyProfiles: providersToLegacyProfiles(codexProviders),
      };
    }
  }
  let changed = false;
  const codexKeyProfiles = settings.codexKeyProfiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile;
    }
    changed = true;
    return {
      ...profile,
      cachedModels: mergeCodexProviderModels(profile.cachedModels, refreshedModels),
      lastModelRefreshAtMs: refreshedAtMs,
    };
  });
  return changed ? { ...settings, codexKeyProfiles } : settings;
}

export function resolveCodexProviderModelOptions(
  profile: CodexKeyProfile | null | undefined,
): ModelOption[] {
  if (!profile) {
    return [];
  }
  const selectedModel = profile.model?.trim() || null;
  const cachedModels = mergeCodexProviderModels(profile.cachedModels);
  if (selectedModel && !cachedModels.some((model) => model.id === selectedModel)) {
    cachedModels.unshift({ id: selectedModel, name: null, contextWindow: null });
  }
  return cachedModels.map((model) => {
    const modelDefault = normalizeReasoningEffortValue(model.defaultReasoningEffort);
    const hasModelReasoningMetadata =
      model.supportedReasoningEfforts !== undefined || modelDefault !== null;
    const modelEfforts = parseReasoningEffortOptions(model.supportedReasoningEfforts ?? []);
    if (
      modelDefault &&
      !modelEfforts.some(
        (option) => option.reasoningEffort.toLocaleLowerCase() === modelDefault.toLocaleLowerCase(),
      )
    ) {
      modelEfforts.push({ reasoningEffort: modelDefault, description: "" });
    }
    const supportedReasoningEfforts = hasModelReasoningMetadata
      ? modelEfforts
      : profile.supportsReasoningEffort
        ? PROVIDER_REASONING_EFFORTS
        : [];
    const defaultReasoningEffort = hasModelReasoningMetadata
      ? modelDefault ??
        supportedReasoningEfforts.find(
          (option) => option.reasoningEffort.toLocaleLowerCase() === "medium",
        )?.reasoningEffort ??
        supportedReasoningEfforts[0]?.reasoningEffort ??
        null
      : profile.supportsReasoningEffort
        ? "medium"
        : null;
    return {
      id: model.id,
      model: model.id,
      displayName: model.name ?? model.id,
      description: profile.name,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      isDefault: model.id === selectedModel,
    };
  });
}
