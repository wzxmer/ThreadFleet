import { describe, expect, it } from "vitest";
import type { CodexProvider } from "@/types";
import {
  credentialForSelection,
  credentialSelectionId,
  effectiveUsageCredentialSelection,
  providersToLegacyProfiles,
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

  it("uses the execution credential for usage until the user selects an override", () => {
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
    ).toEqual(executionSelection);
    expect(
      effectiveUsageCredentialSelection({
        codexProviders: [provider],
        codexKeyProfiles: [],
        executionCredentialSelection: executionSelection,
        usageCredentialSelection: usageSelection,
      }),
    ).toEqual(usageSelection);
  });

  it("falls back to the execution credential when the usage override was deleted", () => {
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
    ).toEqual(executionSelection);
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
