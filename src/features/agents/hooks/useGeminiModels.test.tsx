// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeRequest } from "@services/tauri";
import { useGeminiModels } from "./useGeminiModels";
import type { CodexKeyProfile } from "@/types";
import { I18N_STRINGS } from "@/features/i18n/strings";
vi.mock("@services/tauri", () => ({ agentRuntimeRequest: vi.fn() }));
beforeEach(() => { vi.mocked(agentRuntimeRequest).mockReset(); });

it("reads the advertised models and reports authentication errors", async () => {
  const onModel = vi.fn();
  vi.mocked(agentRuntimeRequest).mockResolvedValue({ availableModels: [{ modelId: "gemini-model", name: "Model" }], currentModelId: "gemini-model" });
  const { result } = renderHook(() => useGeminiModels("ws", null, "gemini", onModel));
  await waitFor(() => expect(result.current.models).toHaveLength(1));
  expect(onModel).toHaveBeenLastCalledWith("gemini-model");
  vi.mocked(agentRuntimeRequest).mockRejectedValue(new Error("Login required"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.error).toBe("Login required");
  expect(result.current.models).toEqual([]);
});

it("explains how to configure TF authentication without treating an OpenAI model list as Gemini auth", async () => {
  const message = "Gemini authentication required. Gemini API key is missing or not configured";
  vi.mocked(agentRuntimeRequest).mockRejectedValue(new Error(message));
  const onModel = vi.fn();
  const { result } = renderHook(() => useGeminiModels("ws", null, "gemini", onModel));
  await waitFor(() => expect(result.current.error).toBe(
    `${I18N_STRINGS.zh["agents.geminiAuthenticationHelp"]}\n${message}`,
  ));
  expect(result.current.models).toEqual([]);
});

it("ignores stale model responses after switching workspace or engine", async () => {
  let complete: (value: unknown) => void = () => {};
  vi.mocked(agentRuntimeRequest).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const onModel = vi.fn();
  const { result, rerender } = renderHook(({ engine }: { engine: "codex" | "gemini" }) =>
    useGeminiModels("ws", null, engine, onModel), { initialProps: { engine: "gemini" } });
  expect(result.current.loading).toBe(true);
  rerender({ engine: "codex" });
  await act(async () => { complete({ availableModels: [{ modelId: "stale" }], currentModelId: "stale" }); });
  expect(result.current.loading).toBe(false);
  expect(result.current.models).toEqual([]);
  expect(onModel).not.toHaveBeenCalled();
});

it("waits for saved settings and reloads after the selected Gemini provider changes", async () => {
  let finishSave: () => void = () => {};
  const beforeRequest = vi.fn(() => new Promise<void>((resolve) => { finishSave = resolve; }));
  vi.mocked(agentRuntimeRequest).mockResolvedValue({ availableModels: [], currentModelId: null });
  const onModel = vi.fn();
  const provider: CodexKeyProfile = {
    id: "relay", name: "Relay", providerKind: "gemini", key: "test-key",
    keyEnvVar: "GEMINI_API_KEY", baseUrlEnvVar: "GOOGLE_GEMINI_BASE_URL",
    baseUrl: "https://relay.example", model: "gemini-one",
  };
  const { rerender } = renderHook(({ selected }) =>
    useGeminiModels("ws", null, "gemini", onModel, selected, beforeRequest),
    { initialProps: { selected: provider } });
  expect(agentRuntimeRequest).not.toHaveBeenCalled();
  await act(async () => { finishSave(); });
  expect(agentRuntimeRequest).toHaveBeenCalledTimes(1);
  expect(onModel).toHaveBeenLastCalledWith("gemini-one");
  rerender({ selected: { ...provider, model: "gemini-two" } });
  expect(agentRuntimeRequest).toHaveBeenCalledTimes(1);
  await act(async () => { finishSave(); });
  expect(agentRuntimeRequest).toHaveBeenCalledTimes(2);
  expect(onModel).toHaveBeenLastCalledWith("gemini-two");
});
