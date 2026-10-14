// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCliCandidate } from "@/types";
import { discoverAgentClis } from "@services/tauri";
import { useAgentCliDiscovery } from "./useAgentCliDiscovery";

vi.mock("@services/tauri", () => ({ discoverAgentClis: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("useAgentCliDiscovery", () => {
  it("ignores an outdated detection response when the execution host changes", async () => {
    let completeLocal!: (candidates: AgentCliCandidate[]) => void;
    const localResult = new Promise<AgentCliCandidate[]>((resolve) => { completeLocal = resolve; });
    const remoteCandidate: AgentCliCandidate = {
      engine: "gemini",
      path: "/remote/bin/gemini",
      version: "0.30.0",
      source: "system",
      runnable: true,
      error: null,
    };
    vi.mocked(discoverAgentClis).mockReturnValueOnce(localResult).mockResolvedValueOnce([remoteCandidate]);
    const { result, rerender } = renderHook(
      ({ host }) => useAgentCliDiscovery("gemini", null, host),
      { initialProps: { host: "local" } },
    );
    rerender({ host: "remote" });
    await waitFor(() => expect(result.current.candidates).toEqual([remoteCandidate]));
    await act(async () => completeLocal([]));
    expect(result.current.candidates).toEqual([remoteCandidate]);
    expect(result.current.loading).toBe(false);
  });
});
