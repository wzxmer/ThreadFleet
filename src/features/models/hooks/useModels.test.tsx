// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "../../../types";
import { getConfigModel, getModelList } from "../../../services/tauri";
import { useModels } from "./useModels";

vi.mock("../../../services/tauri", () => ({
  getModelList: vi.fn(),
  getConfigModel: vi.fn(),
}));

const workspace: WorkspaceInfo = {
  id: "workspace-1",
  name: "ThreadFleet",
  path: "/tmp/codex",
  connected: true,
  settings: { sidebarCollapsed: false },
};

const workspaceTwo: WorkspaceInfo = {
  ...workspace,
  id: "workspace-2",
  name: "Other Workspace",
  path: "/tmp/other",
};

describe("useModels", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("adds the config model when it is missing from model/list", async () => {
    vi.mocked(getModelList).mockResolvedValueOnce({
      result: {
        data: [
          {
            id: "remote-1",
            model: "gpt-5.1",
            displayName: "GPT-5.1",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true,
          },
        ],
      },
    });
    vi.mocked(getConfigModel).mockResolvedValueOnce("custom-model");

    const { result } = renderHook(() =>
      useModels({ activeWorkspace: workspace }),
    );

    await waitFor(() => expect(result.current.models.length).toBeGreaterThan(0));

    expect(getConfigModel).toHaveBeenCalledWith("workspace-1");
    expect(result.current.models[0]).toMatchObject({
      id: "custom-model",
      model: "custom-model",
    });
    expect(result.current.selectedModel?.model).toBe("custom-model");
    expect(result.current.reasoningSupported).toBe(false);
  });

  it("uses a friendly display name for codex-auto-review from config", async () => {
    vi.mocked(getModelList).mockResolvedValueOnce({
      result: { data: [] },
    });
    vi.mocked(getConfigModel).mockResolvedValueOnce("codex-auto-review");

    const { result } = renderHook(() =>
      useModels({ activeWorkspace: workspace }),
    );

    await waitFor(() => expect(result.current.models.length).toBe(1));

    expect(result.current.models[0]).toMatchObject({
      id: "codex-auto-review",
      model: "codex-auto-review",
      displayName: "Codex Auto Review (config)",
    });
    expect(result.current.selectedModel?.model).toBe("codex-auto-review");
  });

  it("prefers the provider entry when the config model matches by slug", async () => {
    vi.mocked(getModelList).mockResolvedValueOnce({
      result: {
        data: [
          {
            id: "provider-id",
            model: "custom-model",
            displayName: "Provider Custom",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
        ],
      },
    });
    vi.mocked(getConfigModel).mockResolvedValueOnce("custom-model");

    const { result } = renderHook(() =>
      useModels({ activeWorkspace: workspace }),
    );

    await waitFor(() => expect(result.current.selectedModelId).toBe("provider-id"));

    expect(result.current.models).toHaveLength(1);
    expect(result.current.selectedModel?.id).toBe("provider-id");
    expect(result.current.reasoningSupported).toBe(true);
  });

  it("keeps the selected reasoning effort when switching models", async () => {
    vi.mocked(getModelList).mockResolvedValueOnce({
      result: {
        data: [
          {
            id: "remote-1",
            model: "gpt-5.1",
            displayName: "GPT-5.1",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      },
    });
    vi.mocked(getConfigModel).mockResolvedValueOnce("custom-model");

    const { result } = renderHook(() =>
      useModels({ activeWorkspace: workspace }),
    );

    await waitFor(() => expect(result.current.models.length).toBeGreaterThan(1));

    act(() => {
      result.current.setSelectedEffort("high");
      result.current.setSelectedModelId("custom-model");
    });

    await waitFor(() => {
      expect(result.current.selectedModelId).toBe("custom-model");
      expect(result.current.selectedEffort).toBe("high");
    });
  });

  it("falls back when the selected effort is unsupported by the next model", async () => {
    vi.mocked(getModelList).mockResolvedValueOnce({
      result: {
        data: [
          {
            id: "model-a",
            model: "model-a",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "xhigh", description: "Extra high" },
            ],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
          {
            id: "model-b",
            model: "model-b",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
        ],
      },
    });
    vi.mocked(getConfigModel).mockResolvedValueOnce("model-a");
    const { result } = renderHook(() => useModels({ activeWorkspace: workspace }));
    await waitFor(() => expect(result.current.selectedModelId).toBe("model-a"));

    act(() => {
      result.current.setSelectedEffort("xhigh");
      result.current.setSelectedModelId("model-b");
    });

    await waitFor(() => {
      expect(result.current.selectedModelId).toBe("model-b");
      expect(result.current.selectedEffort).toBe("medium");
    });
  });

  it("refreshes again after the workspace reconnects", async () => {
    vi.mocked(getModelList).mockResolvedValue({ result: { data: [] } });
    vi.mocked(getConfigModel).mockResolvedValue("custom-model");
    const { rerender } = renderHook(
      ({ connected }) =>
        useModels({ activeWorkspace: { ...workspace, connected } }),
      { initialProps: { connected: true } },
    );

    await waitFor(() => expect(getModelList).toHaveBeenCalledTimes(1));
    rerender({ connected: false });
    rerender({ connected: true });

    await waitFor(() => expect(getModelList).toHaveBeenCalledTimes(2));
  });

  it("exposes manual refresh loading without clearing existing models", async () => {
    let resolveRefresh: ((value: unknown) => void) | null = null;
    vi.mocked(getModelList)
      .mockResolvedValueOnce({ result: { data: [] } })
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    vi.mocked(getConfigModel).mockResolvedValue("custom-model");
    const { result } = renderHook(() => useModels({ activeWorkspace: workspace }));

    await waitFor(() => expect(result.current.models).toHaveLength(1));
    act(() => {
      void result.current.refreshModels();
    });
    await waitFor(() => expect(result.current.isRefreshingModels).toBe(true));
    expect(result.current.models).toHaveLength(1);

    await act(async () => {
      resolveRefresh?.({ result: { data: [] } });
    });
    await waitFor(() => expect(result.current.isRefreshingModels).toBe(false));
  });

  it("keeps the existing model list when manual refresh fails", async () => {
    vi.mocked(getModelList)
      .mockResolvedValueOnce({ result: { data: [] } })
      .mockRejectedValueOnce(new Error("offline"));
    vi.mocked(getConfigModel).mockResolvedValue("custom-model");
    const { result } = renderHook(() => useModels({ activeWorkspace: workspace }));

    await waitFor(() => expect(result.current.models).toHaveLength(1));
    await act(async () => {
      await result.current.refreshModels();
    });

    expect(result.current.models).toHaveLength(1);
    expect(result.current.models[0].id).toBe("custom-model");
  });

  it("uses active provider models instead of the previous app-server list", async () => {
    vi.mocked(getModelList).mockResolvedValue({
      result: {
        data: [
          {
            id: "old-provider-model",
            model: "gpt-5.6-sol",
            displayName: "Old Provider",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true,
          },
        ],
      },
    });
    vi.mocked(getConfigModel).mockResolvedValue("gpt-5.6-sol");
    const providerModels = [
      {
        id: "kimi-k2.7-code",
        model: "kimi-k2.7-code",
        displayName: "Kimi K2.7 Code",
        description: "OpenCode",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        isDefault: true,
      },
    ];

    const { result } = renderHook(() =>
      useModels({
        activeWorkspace: workspace,
        preferredModelId: "kimi-k2.7-code",
        providerModels,
      }),
    );

    await waitFor(() => expect(result.current.models).toEqual(providerModels));
    expect(result.current.selectedModelId).toBe("kimi-k2.7-code");

    await act(async () => {
      await result.current.refreshModels();
    });
    expect(result.current.models).toEqual(providerModels);
  });

  it("does not expose a stale model response after switching workspaces", async () => {
    let resolveFirstModels: ((value: unknown) => void) | null = null;
    let resolveSecondModels: ((value: unknown) => void) | null = null;
    vi.mocked(getModelList)
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveFirstModels = resolve;
        }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveSecondModels = resolve;
        }),
      );
    vi.mocked(getConfigModel)
      .mockResolvedValueOnce("workspace-one-model")
      .mockResolvedValueOnce("workspace-two-model");

    const { result, rerender } = renderHook(
      ({ activeWorkspace }) => useModels({ activeWorkspace }),
      { initialProps: { activeWorkspace: workspace } },
    );
    await waitFor(() => expect(getModelList).toHaveBeenCalledWith("workspace-1"));
    rerender({ activeWorkspace: workspaceTwo });

    await act(async () => {
      resolveFirstModels?.({
        result: {
          data: [{
            id: "workspace-one-model",
            model: "workspace-one-model",
            displayName: "Workspace One",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true,
          }],
        },
      });
    });

    expect(result.current.models.map((model) => model.id)).not.toContain("workspace-one-model");
    await waitFor(() => expect(getModelList).toHaveBeenCalledWith("workspace-2"));
    await act(async () => {
      resolveSecondModels?.({
        result: {
          data: [{
            id: "workspace-two-model",
            model: "workspace-two-model",
            displayName: "Workspace Two",
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            isDefault: true,
          }],
        },
      });
    });
    await waitFor(() => {
      expect(result.current.models.map((model) => model.id)).toEqual(["workspace-two-model"]);
    });
  });
});
