// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadStallWarnings } from "./useThreadStallWarnings";

describe("useThreadStallWarnings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns once when a processing thread has been active for over 10 minutes", () => {
    const pushThreadErrorMessage = vi.fn();
    const safeMessageActivity = vi.fn();
    const onReconcileThread = vi.fn();

    renderHook(() =>
      useThreadStallWarnings({
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 1_000_000 - 10 * 60 * 1000,
            lastDurationMs: null,
          },
        },
        pushThreadErrorMessage,
        safeMessageActivity,
        onReconcileThread,
      }),
    );

    expect(pushThreadErrorMessage).toHaveBeenCalledWith(
      "thread-1",
      "Turn may be stalled: Codex has been working for over 10 minutes without a completion or error event.",
    );
    expect(safeMessageActivity).toHaveBeenCalledTimes(1);
    expect(onReconcileThread).toHaveBeenCalledWith("thread-1");

    vi.advanceTimersByTime(60 * 1000);

    expect(pushThreadErrorMessage).toHaveBeenCalledTimes(1);
    expect(onReconcileThread).toHaveBeenCalledTimes(1);
  });

  it("uses the latest event activity instead of only the processing start", () => {
    const pushThreadErrorMessage = vi.fn();
    const onReconcileThread = vi.fn();

    renderHook(() =>
      useThreadStallWarnings({
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 1_000_000 - 20 * 60 * 1000,
            lastDurationMs: null,
          },
        },
        lastActivityAtByThreadRef: {
          current: { "thread-1": 1_000_000 - 2 * 60 * 1000 },
        },
        pushThreadErrorMessage,
        safeMessageActivity: vi.fn(),
        onReconcileThread,
      }),
    );

    expect(pushThreadErrorMessage).not.toHaveBeenCalled();
    expect(onReconcileThread).not.toHaveBeenCalled();
  });

  it("does not reconcile an active processing thread merely because the window regains focus", () => {
    const pushThreadErrorMessage = vi.fn();
    const onReconcileThread = vi.fn();

    renderHook(() =>
      useThreadStallWarnings({
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 999_000,
            lastDurationMs: null,
          },
          "thread-2": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 999_000,
            lastDurationMs: null,
          },
        },
        pushThreadErrorMessage,
        safeMessageActivity: vi.fn(),
        onReconcileThread,
      }),
    );

    act(() => window.dispatchEvent(new Event("focus")));

    expect(onReconcileThread).not.toHaveBeenCalled();
    expect(pushThreadErrorMessage).not.toHaveBeenCalled();
  });

  it("does not warn before the stall threshold", () => {
    const pushThreadErrorMessage = vi.fn();

    renderHook(() =>
      useThreadStallWarnings({
        threadStatusById: {
          "thread-1": {
            isProcessing: true,
            hasUnread: false,
            isReviewing: false,
            processingStartedAt: 1_000_000 - 9 * 60 * 1000,
            lastDurationMs: null,
          },
        },
        pushThreadErrorMessage,
        safeMessageActivity: vi.fn(),
      }),
    );

    expect(pushThreadErrorMessage).not.toHaveBeenCalled();
  });

  it("allows a new warning after processing stops and starts again", () => {
    const pushThreadErrorMessage = vi.fn();
    const safeMessageActivity = vi.fn();
    const initialProps: { processingStartedAt: number | null } = {
      processingStartedAt: 1_000_000 - 10 * 60 * 1000,
    };
    const { rerender } = renderHook(
      ({ processingStartedAt }: { processingStartedAt: number | null }) =>
        useThreadStallWarnings({
          threadStatusById: {
            "thread-1": {
              isProcessing: Boolean(processingStartedAt),
              hasUnread: false,
              isReviewing: false,
              processingStartedAt,
              lastDurationMs: null,
            },
          },
          pushThreadErrorMessage,
          safeMessageActivity,
        }),
      { initialProps },
    );

    expect(pushThreadErrorMessage).toHaveBeenCalledTimes(1);

    rerender({ processingStartedAt: null });
    rerender({ processingStartedAt: 1_000_000 - 11 * 60 * 1000 });

    expect(pushThreadErrorMessage).toHaveBeenCalledTimes(2);
  });
});
