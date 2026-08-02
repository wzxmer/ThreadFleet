import { describe, expect, it } from "vitest";
import {
  applyRefreshedCodexProviderModels,
  mergeCodexProviderModels,
  resolveCodexProviderBaseUrl,
  resolveCodexProviderModel,
  resolveCodexProviderModelOptions,
} from "./providerProfiles";

describe("resolveCodexProviderBaseUrl", () => {
  it("prefers explicit URLs and supplies known provider defaults", () => {
    expect(resolveCodexProviderBaseUrl("deepseek", null)).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(resolveCodexProviderBaseUrl("opencode", null)).toBe(
      "https://opencode.ai/zen/go/v1",
    );
    expect(resolveCodexProviderBaseUrl("openrouter", " https://proxy.example/v1 ")).toBe(
      "https://proxy.example/v1",
    );
    expect(resolveCodexProviderBaseUrl("custom", null)).toBeNull();
  });

  it("prefers a persisted thread model and falls back to the active provider model", () => {
    expect(resolveCodexProviderModel("kimi-k2.7-code", "gpt-5.6-sol")).toBe(
      "gpt-5.6-sol",
    );
    expect(resolveCodexProviderModel(null, "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveCodexProviderModel("kimi-k2.7-code", null)).toBe("kimi-k2.7-code");
  });

  it("merges partial provider model results without losing metadata", () => {
    expect(
      mergeCodexProviderModels(
        [{
          id: "model-a",
          name: "Model A",
          contextWindow: 128000,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "xhigh", description: "Extra high" },
          ],
          defaultReasoningEffort: "high",
        }],
        [
          { id: "model-a", name: null, contextWindow: null },
          { id: "model-b", name: "Model B", contextWindow: null },
        ],
      ),
    ).toEqual([
      {
        id: "model-a",
        name: "Model A",
        contextWindow: 128000,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "High" },
          { reasoningEffort: "xhigh", description: "Extra high" },
        ],
        defaultReasoningEffort: "high",
      },
      { id: "model-b", name: "Model B", contextWindow: null },
    ]);
  });

  it("refreshes provider models without overwriting current profile flags", () => {
    const settings = {
      codexKeyProfiles: [
        {
          id: "opencode",
          name: "OpenCode",
          providerKind: "opencode" as const,
          keyEnvVar: "OPENAI_API_KEY",
          key: "secret",
          baseUrlEnvVar: "OPENAI_BASE_URL",
          baseUrl: "https://opencode.ai/zen/go/v1",
          model: "model-a",
          supportsThinking: true,
          supportsReasoningEffort: true,
          cachedModels: [
            { id: "model-a", name: "Model A", contextWindow: null },
          ],
        },
      ],
    } as unknown as import("@/types").AppSettings;

    const next = applyRefreshedCodexProviderModels(
      settings,
      "opencode",
      [{ id: "model-b", name: "Model B", contextWindow: null }],
      123,
    );

    expect(next.codexKeyProfiles[0]).toMatchObject({
      supportsThinking: true,
      supportsReasoningEffort: true,
      lastModelRefreshAtMs: 123,
      cachedModels: [
        { id: "model-a", name: "Model A", contextWindow: null },
        { id: "model-b", name: "Model B", contextWindow: null },
      ],
    });
  });

  it("isolates refreshed model caches by credential while preserving legacy provider fallback", () => {
    const settings = {
      codexProviders: [
        {
          id: "provider-a",
          name: "Provider A",
          baseUrlEnvVar: "OPENAI_BASE_URL",
          baseUrl: "https://example.test/v1",
          groups: [
            {
              id: "group-a",
              name: "Group A",
              credentials: [
                {
                  id: "key-a",
                  name: "Key A",
                  key: "secret",
                  keyEnvVar: "OPENAI_API_KEY",
                },
                {
                  id: "key-b",
                  name: "Key B",
                  key: "secret-b",
                  keyEnvVar: "OPENAI_API_KEY",
                },
              ],
            },
          ],
          cachedModels: [{ id: "model-a", name: "Model A", contextWindow: null }],
        },
      ],
      codexKeyProfiles: [],
    } as unknown as import("@/types").AppSettings;

    const next = applyRefreshedCodexProviderModels(
      settings,
      "provider-a:group-a:key-b",
      [{ id: "model-b", name: "Model B", contextWindow: 128000 }],
      456,
    );

    expect(next.codexProviders?.[0]).toMatchObject({
      cachedModels: [{ id: "model-a", name: "Model A", contextWindow: null }],
    });
    const credentials = next.codexProviders?.[0]?.groups[0]?.credentials ?? [];
    expect(credentials[0]?.id).toBe("key-a");
    expect(credentials[0]).not.toHaveProperty("cachedModels");
    expect(credentials[0]).not.toHaveProperty("lastModelRefreshAtMs");
    expect(credentials[1]).toMatchObject({
      id: "key-b",
      lastModelRefreshAtMs: 456,
      cachedModels: [
        { id: "model-b", name: "Model B", contextWindow: 128000 },
      ],
    });
    expect(next.codexKeyProfiles).toEqual([
      expect.objectContaining({
        id: "provider-a:group-a:key-a",
        cachedModels: [{ id: "model-a", name: "Model A", contextWindow: null }],
      }),
      expect.objectContaining({
        id: "provider-a:group-a:key-b",
        cachedModels: [
          { id: "model-b", name: "Model B", contextWindow: 128000 },
        ],
      }),
    ]);
  });

  it("builds an authoritative model list from the active provider profile", () => {
    expect(
      resolveCodexProviderModelOptions({
        id: "opencode",
        name: "OpenCode",
        providerKind: "opencode",
        keyEnvVar: "OPENAI_API_KEY",
        key: "secret",
        baseUrlEnvVar: "OPENAI_BASE_URL",
        baseUrl: "https://opencode.ai/zen/go/v1",
        model: "model-b",
        cachedModels: [{ id: "model-a", name: "Model A", contextWindow: null }],
      }),
    ).toEqual([
      expect.objectContaining({ id: "model-b", model: "model-b", isDefault: true }),
      expect.objectContaining({ id: "model-a", model: "model-a", isDefault: false }),
    ]);
  });

  it("exposes configured chat reasoning levels to the composer", () => {
    const models = resolveCodexProviderModelOptions({
      id: "deepseek",
      name: "DeepSeek",
      providerKind: "deepseek",
      keyEnvVar: "OPENAI_API_KEY",
      key: "secret",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-reasoner",
      supportsThinking: true,
      supportsReasoningEffort: true,
      cachedModels: [
        { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: null },
      ],
    });

    expect(models[0]?.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
      { reasoningEffort: "xhigh", description: "" },
      { reasoningEffort: "max", description: "" },
      { reasoningEffort: "ultra", description: "" },
    ]);
    expect(models[0]?.defaultReasoningEffort).toBe("medium");
  });

  it("prefers per-model reasoning levels over the provider fallback", () => {
    const [model] = resolveCodexProviderModelOptions({
      id: "custom",
      name: "Custom",
      providerKind: "custom",
      keyEnvVar: "OPENAI_API_KEY",
      key: "secret",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      baseUrl: "https://api.example.com/v1",
      model: "reasoning-model",
      supportsThinking: true,
      supportsReasoningEffort: true,
      cachedModels: [{
        id: "reasoning-model",
        name: "Reasoning Model",
        contextWindow: null,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "" },
          { reasoningEffort: "xhigh", description: "" },
        ],
        defaultReasoningEffort: "xhigh",
      }],
    });

    expect(model.supportedReasoningEfforts.map((option) => option.reasoningEffort)).toEqual([
      "high",
      "xhigh",
    ]);
    expect(model.defaultReasoningEffort).toBe("xhigh");
  });

  it("keeps the provider fallback when legacy metadata is null", () => {
    const [model] = resolveCodexProviderModelOptions({
      id: "legacy",
      name: "Legacy",
      providerKind: "custom",
      keyEnvVar: "OPENAI_API_KEY",
      key: "secret",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      baseUrl: "https://api.example.com/v1",
      model: "legacy-model",
      supportsThinking: true,
      supportsReasoningEffort: true,
      cachedModels: [{
        id: "legacy-model",
        name: null,
        contextWindow: null,
        defaultReasoningEffort: null,
      }],
    });

    expect(model.supportedReasoningEfforts.map((option) => option.reasoningEffort)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(model.defaultReasoningEffort).toBe("medium");
  });

  it("maps duck model id reasoning variants to compatible effort options", () => {
    const models = resolveCodexProviderModelOptions({
      id: "duck",
      name: "duck",
      providerKind: "custom",
      keyEnvVar: "OPENAI_API_KEY",
      key: "secret",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      baseUrl: "https://api.duckcoding.ai",
      model: "gpt-5.6-luna-max",
      supportsThinking: true,
      supportsReasoningEffort: true,
      cachedModels: [
        { id: "gpt-5.6-luna", name: null, contextWindow: null },
        { id: "gpt-5.6-luna-low", name: null, contextWindow: null },
        { id: "gpt-5.6-luna-max", name: null, contextWindow: null },
      ],
    });

    expect(models.find((model) => model.id === "gpt-5.6-luna-max")).toMatchObject({
      supportedReasoningEfforts: [{ reasoningEffort: "max", description: "" }],
      defaultReasoningEffort: "max",
    });
    expect(models.find((model) => model.id === "gpt-5.6-luna-low")).toMatchObject({
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }],
      defaultReasoningEffort: "low",
    });
    expect(models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "medium", description: "" },
        { reasoningEffort: "high", description: "" },
        { reasoningEffort: "xhigh", description: "" },
        { reasoningEffort: "max", description: "" },
        { reasoningEffort: "ultra", description: "" },
      ],
      defaultReasoningEffort: "medium",
    });
  });

  it("keeps max available for the base gpt-5.6-luna model when xhigh is cached", () => {
    const [model] = resolveCodexProviderModelOptions({
      id: "luna-provider",
      name: "Luna Provider",
      providerKind: "custom",
      keyEnvVar: "OPENAI_API_KEY",
      key: "secret",
      baseUrlEnvVar: "OPENAI_BASE_URL",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-5.6-luna",
      supportsThinking: true,
      supportsReasoningEffort: true,
      cachedModels: [{
        id: "gpt-5.6-luna",
        name: null,
        contextWindow: null,
        supportedReasoningEfforts: [{ reasoningEffort: "xhigh", description: "" }],
        defaultReasoningEffort: "xhigh",
      }],
    });

    expect(model.supportedReasoningEfforts.map((option) => option.reasoningEffort)).toEqual([
      "xhigh",
      "max",
    ]);
    expect(model.defaultReasoningEffort).toBe("xhigh");
  });
});
