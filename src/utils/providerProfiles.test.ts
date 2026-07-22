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
    ]);
    expect(model.defaultReasoningEffort).toBe("medium");
  });
});
