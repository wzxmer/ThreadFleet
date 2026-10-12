// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestUserInputRequest } from "@/types";
import { respondToUserInputRequest } from "@services/tauri";
import { useThreadUserInput } from "./useThreadUserInput";

vi.mock("@services/tauri", () => ({
  respondToUserInputRequest: vi.fn().mockResolvedValue(undefined),
}));

describe("useThreadUserInput", () => {
  beforeEach(() => { vi.mocked(respondToUserInputRequest).mockReset().mockResolvedValue(undefined); });
  it("submits request-user-input answers and appends an answered item", async () => {
    const dispatch = vi.fn();
    const request = {
      workspace_id: "ws-1",
      request_id: "req-7",
      params: {
        thread_id: "thread-1",
        turn_id: "turn-1",
        item_id: "item-1",
        questions: [
          {
            id: "q-choice",
            header: "Pick",
            question: "Which option?",
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
            ],
          },
        ],
      },
    };
    const response = {
      answers: {
        "q-choice": { answers: ["A", "user_note: with details"] },
      },
    };
    const { result } = renderHook(() => useThreadUserInput({ dispatch, requests: [request] }));

    await act(async () => {
      await result.current.handleUserInputSubmit(request, response);
    });

    expect(respondToUserInputRequest).toHaveBeenCalledWith(
      "ws-1",
      "req-7",
      response.answers,
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "upsertItem",
        workspaceId: "ws-1",
        threadId: "thread-1",
        item: expect.objectContaining({
          id: "user-input-ws-1-thread-1-turn-1-item-1",
          kind: "userInput",
          status: "answered",
        }),
      }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "removeUserInputRequest",
      requestId: "req-7",
      workspaceId: "ws-1",
    });
  });

  const request: RequestUserInputRequest = {
    workspace_id: "ws-1", request_id: "r", params: { thread_id: "t", turn_id: "turn", item_id: "i",
      questions: [{ id: "q", question: "Credential?", header: "", isSecret: true }] },
  };
  const response = { answers: { q: { answers: ["sensitive-value"] } } };

  it("rejects stale requests before writing to the server", async () => {
    const dispatch = vi.fn();
    const { result, rerender } = renderHook(({ requests }) => useThreadUserInput({ dispatch, requests }), { initialProps: { requests: [request] } });
    rerender({ requests: [] });
    await expect(result.current.handleUserInputSubmit(request, response)).rejects.toThrow("no longer pending");
    expect(respondToUserInputRequest).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves the pending request on transport failure", async () => {
    vi.mocked(respondToUserInputRequest).mockRejectedValueOnce(new Error("offline"));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useThreadUserInput({ dispatch, requests: [request] }));
    await expect(result.current.handleUserInputSubmit(request, response)).rejects.toThrow("offline");
    expect(dispatch).not.toHaveBeenCalled();
    await result.current.handleUserInputSubmit(request, response);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("sensitive-value");
    expect(respondToUserInputRequest).toHaveBeenLastCalledWith("ws-1", "r", response.answers);
  });

  it("deduplicates submissions until the transport finishes", async () => {
    let resolve!: () => void;
    vi.mocked(respondToUserInputRequest).mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const dispatch = vi.fn();
    const { result } = renderHook(() => useThreadUserInput({ dispatch, requests: [request] }));
    const a = result.current.handleUserInputSubmit(request, response);
    const b = result.current.handleUserInputSubmit(request, response);
    expect(a).toBe(b);
    expect(respondToUserInputRequest).toHaveBeenCalledTimes(1);
    resolve();
    await a;
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
