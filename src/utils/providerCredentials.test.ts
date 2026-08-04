import { describe, expect, it } from "vitest";
import type { CodexProvider } from "@/types";
import {
  credentialForSelection,
  credentialSelectionId,
  effectiveUsageCredentialSelection,
  providersToLegacyProfiles,
  synchronizeUsageProviderSelection,
} from "./providerCredentials";

const provider: CodexProvider = {
  id: "provider-a",
  name: "Provider A",
  providerKind: "custom",
  usageProtocol: "new-api",
  baseUrlEnvVar: "OPENAI_BASE_URL",
  baseUrl: "https://example.test/v1",
  model: "model-a",
  groups: [
    {
      id: "group-a",
      name: "Group A",
      credentials: [
        {
          id: "key-a",
          name: "Key A",
          key: "secret-a",
          newApiAccessToken: "token-a",
          keyEnvVar: "OPENAI_API_KEY",
          functionToolCapability: {
            state: "verified",
            model: "model-a",
            transport: "chat-completions-gateway",
            checkedAtMs: 100,
          },
        },
        {
          id: "key-b",
          name: "Key B",
          key: "secret-b",
          keyEnvVar: "OPENAI_API_KEY",
          functionToolCapability: {
            state: "unsupported",
            model: "model-a",
            transport: "chat-completions-gateway",
            checkedAtMs: 200,
            failureCode: "function_call_not_returned",
          },
        },
      ],
    },
  ],
};

describe("provider credential projection", () => {
  it("preserves provider, group, and credential identity in legacy profiles", () => {
    const profiles = providersToLegacyProfiles([provider]);

    expect(profiles.map((profile) => profile.id)).toEqual([
      "provider-a:group-a:key-a",
      "provider-a:group-a:key-b",
    ]);
    expect(profiles[0]).toMatchObject({
      name: "Key A",
      groupName: "Group A",
      model: "model-a",
      newApiAccessToken: "token-a",
    });
  });

  it("resolves one selected credential without falling back to another key", () => {
    const selection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-b",
    };

    expect(credentialSelectionId(selection)).toBe("provider-a:group-a:key-b");
    expect(credentialForSelection([provider], selection)?.credential.key).toBe("secret-b");
    expect(
      credentialForSelection([provider], { ...selection, credentialId: "missing" }),
    ).toBeNull();
  });

  it("uses local Codex configuration until the user selects an override", () => {
    const executionSelection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-a",
    };
    const usageSelection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-b",
    };

    expect(
      effectiveUsageCredentialSelection({
        codexProviders: [provider],
        codexKeyProfiles: [],
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: null,
      }),
    ).toBeNull();
    expect(
      effectiveUsageCredentialSelection({
        codexProviders: [provider],
        codexKeyProfiles: [],
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: usageSelection,
      }),
    ).toEqual(usageSelection);
  });

  it("synchronizes a usage provider switch with the active execution provider", () => {
    const providerB: CodexProvider = {
      ...provider,
      id: "provider-b",
      name: "Provider B",
      groups: [
        {
          ...provider.groups[0],
          id: "group-b",
          credentials: [{ ...provider.groups[0].credentials[0], id: "key-b" }],
        },
      ],
    };
    const executionSelection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-a",
    };
    const usageSelection = {
      providerId: "provider-b",
      groupId: "group-b",
      credentialId: "key-b",
    };

    const next = synchronizeUsageProviderSelection(
      {
        codexProviders: [provider, providerB],
        codexKeyProfiles: [],
        activeCodexKeyProfileId: credentialSelectionId(executionSelection),
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: null,
      },
      usageSelection,
    );

    expect(next.usageCredentialSelection).toEqual(usageSelection);
    expect(next.executionCredentialSelection).toEqual(usageSelection);
    expect(next.activeCodexKeyProfileId).toBe(credentialSelectionId(usageSelection));
  });

  it("switches execution back to the local Codex configuration", () => {
    const executionSelection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-a",
    };

    const next = synchronizeUsageProviderSelection(
      {
        codexProviders: [provider],
        codexKeyProfiles: [],
        activeCodexKeyProfileId: credentialSelectionId(executionSelection),
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: executionSelection,
      },
      null,
    );

    expect(next.usageCredentialSelection).toBeNull();
    expect(next.executionCredentialSelection).toBeNull();
    expect(next.activeCodexKeyProfileId).toBeNull();
  });

  it("synchronizes execution when the usage group changes", () => {
    const providerWithTwoGroups: CodexProvider = {
      ...provider,
      groups: [
        ...provider.groups,
        {
          id: "group-b",
          name: "Group B",
          credentials: [
            {
              id: "key-c",
              name: "Key C",
              key: "secret-c",
              keyEnvVar: "OPENAI_API_KEY",
            },
          ],
        },
      ],
    };
    const usageSelection = {
      providerId: "provider-a",
      groupId: "group-b",
      credentialId: "key-c",
    };
    const executionSelection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-a",
    };

    const next = synchronizeUsageProviderSelection(
      {
        codexProviders: [providerWithTwoGroups],
        codexKeyProfiles: [],
        activeCodexKeyProfileId: credentialSelectionId(executionSelection),
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: null,
      },
      usageSelection,
    );

    expect(next.usageCredentialSelection).toEqual(usageSelection);
    expect(next.executionCredentialSelection).toEqual(usageSelection);
    expect(next.activeCodexKeyProfileId).toBe(credentialSelectionId(usageSelection));
  });

  it("falls back to local Codex configuration when the usage override was deleted", () => {
    const executionSelection = {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-a",
    };

    expect(
      effectiveUsageCredentialSelection({
        codexProviders: [provider],
        codexKeyProfiles: [],
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: {
          ...executionSelection,
          credentialId: "deleted-key",
        },
      }),
    ).toBeNull();
  });

  it("keeps function-tool capability results isolated by API key", () => {
    const first = credentialForSelection([provider], {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-a",
    });
    const second = credentialForSelection([provider], {
      providerId: "provider-a",
      groupId: "group-a",
      credentialId: "key-b",
    });

    expect(first?.credential.functionToolCapability?.state).toBe("verified");
    expect(second?.credential.functionToolCapability).toMatchObject({
      state: "unsupported",
      failureCode: "function_call_not_returned",
    });
  });
});
