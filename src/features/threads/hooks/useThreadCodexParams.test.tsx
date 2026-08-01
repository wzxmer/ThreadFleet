// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY_THREAD_CODEX_PARAMS } from "@threads/utils/threadStorage";
import { useThreadCodexParams } from "./useThreadCodexParams";

describe("useThreadCodexParams", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("patches and retrieves thread-scoped Codex params", () => {
    const { result } = renderHook(() => useThreadCodexParams());

    act(() => {
      result.current.patchThreadCodexParams("ws-1", "thread-1", {
        modelId: "gpt-5.1",
        effort: "high",
        serviceTier: "fast",
        accessMode: "full-access",
        collaborationModeId: "plan",
        codexArgsOverride: "--profile dev",
        workflowGateId: "wf-thread-1",
      });
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-1")).toEqual(
      expect.objectContaining({
        modelId: "gpt-5.1",
        effort: "high",
        serviceTier: "fast",
        accessMode: "full-access",
        collaborationModeId: "plan",
        codexArgsOverride: "--profile dev",
        workflowGateId: "wf-thread-1",
      }),
    );

    const persisted = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY_THREAD_CODEX_PARAMS) ?? "{}",
    ) as Record<string, unknown>;
    expect(persisted["ws-1:thread-1"]).toBeTruthy();
  });

  it("sanitizes malformed persisted entries", () => {
    window.localStorage.setItem(
      STORAGE_KEY_THREAD_CODEX_PARAMS,
      JSON.stringify({
        "ws-1:thread-1": {
          modelId: "gpt-4.1",
          effort: "medium",
          serviceTier: "nope",
          accessMode: "nope",
          collaborationModeId: 99,
          codexArgsOverride: 12,
          workflowGateId: 42,
          updatedAt: "never",
        },
      }),
    );

    const { result } = renderHook(() => useThreadCodexParams());

    expect(result.current.getThreadCodexParams("ws-1", "thread-1")).toEqual({
      modelId: "gpt-4.1",
      effort: "medium",
      serviceTier: null,
      accessMode: null,
      collaborationModeId: null,
      codexArgsOverride: null,
      workflowGateId: null,
      updatedAt: 0,
    });
  });

  it("preserves missing codexArgsOverride for legacy persisted entries", () => {
    window.localStorage.setItem(
      STORAGE_KEY_THREAD_CODEX_PARAMS,
      JSON.stringify({
        "ws-1:thread-legacy": {
          modelId: "gpt-4.1",
          effort: "medium",
          accessMode: "current",
          collaborationModeId: "default",
          updatedAt: 123,
        },
      }),
    );

    const { result } = renderHook(() => useThreadCodexParams());
    const legacy = result.current.getThreadCodexParams("ws-1", "thread-legacy");
    expect(legacy).toEqual(
      expect.objectContaining({
        modelId: "gpt-4.1",
        effort: "medium",
        accessMode: "current",
        collaborationModeId: "default",
        updatedAt: 123,
      }),
    );
    expect(legacy?.serviceTier).toBeUndefined();
    expect(legacy?.codexArgsOverride).toBeUndefined();
    expect(legacy?.workflowGateId).toBeUndefined();
  });

  it("syncs from storage events", async () => {
    const { result } = renderHook(() => useThreadCodexParams());

    window.localStorage.setItem(
      STORAGE_KEY_THREAD_CODEX_PARAMS,
      JSON.stringify({
        "ws-1:thread-2": {
          modelId: "gpt-5",
          effort: "low",
          serviceTier: "fast",
          accessMode: "current",
          collaborationModeId: "default",
          codexArgsOverride: "--profile ws",
          workflowGateId: "  wf-thread-2  ",
          updatedAt: 1,
        },
      }),
    );

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY_THREAD_CODEX_PARAMS }),
      );
    });

    await waitFor(() => {
      expect(result.current.version).toBe(1);
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-2")).toEqual({
      modelId: "gpt-5",
      effort: "low",
      serviceTier: "fast",
      accessMode: "current",
      collaborationModeId: "default",
      codexArgsOverride: "--profile ws",
      workflowGateId: "wf-thread-2",
      updatedAt: 1,
    });
  });

  it("deletes per-thread overrides", () => {
    const { result } = renderHook(() => useThreadCodexParams());

    act(() => {
      result.current.patchThreadCodexParams("ws-1", "thread-3", {
        modelId: "gpt-5",
      });
    });
    expect(result.current.getThreadCodexParams("ws-1", "thread-3")).not.toBeNull();

    act(() => {
      result.current.deleteThreadCodexParams("ws-1", "thread-3");
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-3")).toBeNull();
  });

  it("keeps explicit undefined codexArgsOverride as inherit in memory", () => {
    const { result } = renderHook(() => useThreadCodexParams());

    act(() => {
      result.current.patchThreadCodexParams("ws-1", "thread-4", {
        modelId: "gpt-5",
        codexArgsOverride: undefined,
      });
    });

    expect(result.current.getThreadCodexParams("ws-1", "thread-4")).toEqual(
      expect.objectContaining({
        modelId: "gpt-5",
      }),
    );
    expect(
      result.current.getThreadCodexParams("ws-1", "thread-4")?.codexArgsOverride,
    ).toBeUndefined();
  });

  it("rejects oversized persisted WorkflowGate ids", () => {
    window.localStorage.setItem(
      STORAGE_KEY_THREAD_CODEX_PARAMS,
      JSON.stringify({
        "ws-1:thread-long": {
          workflowGateId: "w".repeat(161),
          updatedAt: 1,
        },
      }),
    );

    const { result } = renderHook(() => useThreadCodexParams());

    expect(
      result.current.getThreadCodexParams("ws-1", "thread-long")?.workflowGateId,
    ).toBeNull();
  });
});
