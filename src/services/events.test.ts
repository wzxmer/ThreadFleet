import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import type { AppServerEvent } from "../types";
import {
  subscribeAppServerEvents,
  subscribeMenuCycleCollaborationMode,
  subscribeMenuCycleModel,
  subscribeMenuNewAgent,
  subscribeRemoteBackendEventGap,
  subscribeTerminalOutput,
} from "./events";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("events subscriptions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("delivers payloads and unsubscribes on cleanup", async () => {
    let listener: EventCallback<AppServerEvent> = () => {};
    const unlisten = vi.fn();

    vi.mocked(listen).mockImplementation((_event, handler) => {
      listener = handler as EventCallback<AppServerEvent>;
      return Promise.resolve(unlisten);
    });

    const onEvent = vi.fn();
    const cleanup = subscribeAppServerEvents(onEvent);
    const payload: AppServerEvent = {
      workspace_id: "ws-1",
      message: { method: "ping" },
    };

    const event: Event<AppServerEvent> = {
      event: "app-server-event",
      id: 1,
      payload,
    };
    listener(event);
    expect(onEvent).toHaveBeenCalledWith(payload);

    cleanup();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("cleans up listeners that resolve after unsubscribe", async () => {
    let resolveListener: (handler: UnlistenFn) => void = () => {};
    const unlisten = vi.fn();

    vi.mocked(listen).mockImplementation(
      () =>
        new Promise<UnlistenFn>((resolve) => {
          resolveListener = resolve;
        }),
    );

    const cleanup = subscribeMenuNewAgent(() => {});
    cleanup();

    resolveListener(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("delivers menu events to subscribers", async () => {
    let listener: EventCallback<void> = () => {};
    const unlisten = vi.fn();

    vi.mocked(listen).mockImplementation((_event, handler) => {
      listener = handler as EventCallback<void>;
      return Promise.resolve(unlisten);
    });

    const onEvent = vi.fn();
    const cleanup = subscribeMenuCycleModel(onEvent);

    const event: Event<void> = {
      event: "menu-composer-cycle-model",
      id: 1,
      payload: undefined,
    };
    listener(event);
    expect(onEvent).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("delivers collaboration cycle menu events to subscribers", async () => {
    let listener: EventCallback<void> = () => {};
    const unlisten = vi.fn();

    vi.mocked(listen).mockImplementation((_event, handler) => {
      listener = handler as EventCallback<void>;
      return Promise.resolve(unlisten);
    });

    const onEvent = vi.fn();
    const cleanup = subscribeMenuCycleCollaborationMode(onEvent);

    const event: Event<void> = {
      event: "menu-composer-cycle-collaboration",
      id: 1,
      payload: undefined,
    };
    listener(event);
    expect(onEvent).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("reports listen errors through options", async () => {
    const error = new Error("nope");
    vi.mocked(listen).mockRejectedValueOnce(error);

    const onError = vi.fn();
    const cleanup = subscribeTerminalOutput(() => {}, { onError });

    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);

    cleanup();
  });

  it("delivers remote backend continuity gaps", () => {
    let listener: EventCallback<{ reason: "lagged"; skipped: number }> = () => {};
    vi.mocked(listen).mockImplementation((_event, handler) => {
      listener = handler as EventCallback<{ reason: "lagged"; skipped: number }>;
      return Promise.resolve(() => {});
    });

    const onEvent = vi.fn();
    const cleanup = subscribeRemoteBackendEventGap(onEvent);
    const payload = { reason: "lagged" as const, skipped: 3 };

    listener({ event: "remote-backend-event-gap", id: 1, payload });

    expect(listen).toHaveBeenCalledWith(
      "remote-backend-event-gap",
      expect.any(Function),
    );
    expect(onEvent).toHaveBeenCalledWith(payload);
    cleanup();
  });

  it("retries a transient listen failure while subscribers remain", async () => {
    const error = new Error("temporarily unavailable");
    let listener: EventCallback<AppServerEvent> = () => {};
    const unlisten = vi.fn();

    vi.mocked(listen)
      .mockRejectedValueOnce(error)
      .mockImplementationOnce((_event, handler) => {
        listener = handler as EventCallback<AppServerEvent>;
        return Promise.resolve(unlisten);
      });

    const onEvent = vi.fn();
    const onError = vi.fn();
    const cleanup = subscribeAppServerEvents(onEvent, { onError });

    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error);
    expect(listen).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 275));
    expect(listen).toHaveBeenCalledTimes(2);

    const payload: AppServerEvent = {
      workspace_id: "ws-1",
      message: { method: "turn/completed" },
    };
    listener({ event: "app-server-event", id: 2, payload });
    expect(onEvent).toHaveBeenCalledWith(payload);

    cleanup();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
