import type {
  AppSettings,
  CodexCredential,
  CodexKeyProfile,
  CodexProvider,
  CodexProviderTransportMode,
  CredentialSelection,
} from "@/types";

const DEFAULT_KEY_ENV_VAR = "OPENAI_API_KEY";
const DEFAULT_BASE_URL_ENV_VAR = "OPENAI_BASE_URL";

function legacyTransportMode(profile: CodexKeyProfile): CodexProviderTransportMode {
  if (profile.transportMode) return profile.transportMode;
  return profile.useGateway ? "chat-completions-gateway" : "auto";
}

function providerUsesGateway(provider: CodexProvider): boolean {
  if (provider.transportMode === "chat-completions-gateway") return true;
  if (provider.transportMode === "responses") return false;
  return Boolean(provider.useGateway);
}

export function createProviderEntityId(prefix: "provider" | "group" | "credential"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function credentialSelectionId(selection: CredentialSelection): string {
  return `${selection.providerId}:${selection.groupId}:${selection.credentialId}`;
}

export function parseCredentialSelectionId(value: string | null | undefined): CredentialSelection | null {
  if (!value) return null;
  const [providerId, groupId, credentialId, extra] = value.split(":");
  if (!providerId || !groupId || !credentialId || extra) return null;
  return { providerId, groupId, credentialId };
}

export function sameCredentialSelection(
  left: CredentialSelection | null | undefined,
  right: CredentialSelection | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.providerId === right.providerId &&
      left.groupId === right.groupId &&
      left.credentialId === right.credentialId,
  );
}

export function effectiveUsageCredentialSelection(
  settings: Pick<
    AppSettings,
    "codexProviders" | "codexKeyProfiles" | "executionCredentialSelection" | "usageCredentialSelection"
  >,
): CredentialSelection | null {
  const providers = providersFromSettings(settings);
  const usageSelection = settings.usageCredentialSelection;
  if (credentialForSelection(providers, usageSelection)) {
    return usageSelection ?? null;
  }
  const executionSelection = settings.executionCredentialSelection;
  return credentialForSelection(providers, executionSelection)
    ? executionSelection ?? null
    : null;
}

type ProviderSelectionSettings = Pick<
    AppSettings,
    | "codexProviders"
    | "codexKeyProfiles"
    | "activeCodexKeyProfileId"
    | "executionCredentialSelection"
    | "usageCredentialSelection"
  >;

export function synchronizeUsageProviderSelection<T extends ProviderSelectionSettings>(
  settings: T,
  usageSelection: CredentialSelection | null,
): T {
  if (!usageSelection) {
    return {
      ...settings,
      usageCredentialSelection: null,
    };
  }

  const providers = providersFromSettings(settings);
  const selectedCredential = credentialForSelection(providers, usageSelection);
  if (!selectedCredential) {
    return {
      ...settings,
      usageCredentialSelection: null,
    };
  }

  const currentExecution = credentialForSelection(
    providers,
    settings.executionCredentialSelection,
  );
  const executionSelection =
    currentExecution?.provider.id === selectedCredential.provider.id
      ? settings.executionCredentialSelection ?? null
      : usageSelection;

  return {
    ...settings,
    usageCredentialSelection: usageSelection,
    executionCredentialSelection: executionSelection,
    activeCodexKeyProfileId: executionSelection
      ? credentialSelectionId(executionSelection)
      : null,
  };
}

export function providerSelection(
  provider: CodexProvider,
  groupId?: string,
  credentialId?: string,
): CredentialSelection | null {
  const group =
    provider.groups.find((candidate) => candidate.id === groupId) ?? provider.groups[0];
  const credential =
    group?.credentials.find((candidate) => candidate.id === credentialId) ??
    group?.credentials[0];
  return group && credential
    ? { providerId: provider.id, groupId: group.id, credentialId: credential.id }
    : null;
}

export function credentialForSelection(
  providers: CodexProvider[],
  selection: CredentialSelection | null | undefined,
): { provider: CodexProvider; groupId: string; credential: CodexCredential } | null {
  if (!selection) return null;
  const provider = providers.find((candidate) => candidate.id === selection.providerId);
  const group = provider?.groups.find((candidate) => candidate.id === selection.groupId);
  const credential = group?.credentials.find(
    (candidate) => candidate.id === selection.credentialId,
  );
  return provider && group && credential
    ? { provider, groupId: group.id, credential }
    : null;
}

function legacyProfileToProvider(profile: CodexKeyProfile): CodexProvider {
  const parsed = parseCredentialSelectionId(profile.id);
  const providerId = parsed?.providerId ?? `provider-${profile.id}`;
  const groupId = parsed?.groupId ?? `group-${profile.id}`;
  const credentialId = parsed?.credentialId ?? `credential-${profile.id}`;
  const selectedModel = profile.cachedModels?.find((model) => model.id === profile.model);
  return {
    id: providerId,
    name: profile.name,
    providerKind: profile.providerKind ?? "custom",
    usageProtocol: profile.usageProtocol ?? "auto",
    baseUrlEnvVar: profile.baseUrlEnvVar || DEFAULT_BASE_URL_ENV_VAR,
    baseUrl: profile.baseUrl ?? null,
    model: profile.model ?? null,
    contextWindow: profile.contextWindow ?? null,
    maxOutputTokens: profile.maxOutputTokens ?? null,
    useGateway: Boolean(profile.useGateway),
    transportMode: legacyTransportMode(profile),
    supportsThinking: Boolean(profile.supportsThinking) || Boolean(profile.supportsReasoningEffort),
    supportsReasoningEffort: Boolean(profile.supportsReasoningEffort),
    defaultReasoningEffort: selectedModel?.defaultReasoningEffort ?? null,
    lastModelRefreshAtMs: profile.lastModelRefreshAtMs ?? null,
    cachedModels: profile.cachedModels ?? [],
    groups: [
      {
        id: groupId,
        name: profile.groupName?.trim() || profile.name,
        credentials: [
          {
            id: credentialId,
            name: profile.name,
            key: profile.key,
            newApiAccessToken: profile.newApiAccessToken ?? null,
            newApiSessionCookie: profile.newApiSessionCookie ?? null,
            keyEnvVar: profile.keyEnvVar || DEFAULT_KEY_ENV_VAR,
            lastModelRefreshAtMs: profile.lastModelRefreshAtMs ?? null,
            cachedModels: profile.cachedModels ?? [],
          },
        ],
      },
    ],
  };
}

export function providersFromSettings(settings: Pick<AppSettings, "codexProviders" | "codexKeyProfiles">): CodexProvider[] {
  return settings.codexProviders?.length
    ? settings.codexProviders
    : settings.codexKeyProfiles.map(legacyProfileToProvider);
}

export function providersToLegacyProfiles(providers: CodexProvider[]): CodexKeyProfile[] {
  return providers.flatMap((provider) =>
    provider.groups.flatMap((group) =>
      group.credentials.map((credential) => {
        const cachedModels = credential.cachedModels ?? provider.cachedModels ?? [];
        return {
          id: credentialSelectionId({
            providerId: provider.id,
            groupId: group.id,
            credentialId: credential.id,
          }),
          name: credential.name,
          providerKind: provider.providerKind ?? "custom",
          usageProtocol: provider.usageProtocol ?? "auto",
          newApiAccessToken: credential.newApiAccessToken ?? null,
          newApiSessionCookie: credential.newApiSessionCookie ?? null,
          keyEnvVar: credential.keyEnvVar || DEFAULT_KEY_ENV_VAR,
          key: credential.key,
          baseUrlEnvVar: provider.baseUrlEnvVar || DEFAULT_BASE_URL_ENV_VAR,
          baseUrl: provider.baseUrl ?? null,
          model: provider.model ?? null,
          contextWindow: provider.contextWindow ?? null,
          maxOutputTokens: provider.maxOutputTokens ?? null,
          useGateway: providerUsesGateway(provider),
          transportMode: provider.transportMode ?? "auto",
          supportsThinking:
            Boolean(provider.supportsThinking) || Boolean(provider.supportsReasoningEffort),
          supportsReasoningEffort: Boolean(provider.supportsReasoningEffort),
          lastModelRefreshAtMs:
            credential.lastModelRefreshAtMs ?? provider.lastModelRefreshAtMs ?? null,
          cachedModels,
          groupName: group.name,
        };
      }),
    ),
  );
}

export function maskCredential(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "********";
  return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
}
