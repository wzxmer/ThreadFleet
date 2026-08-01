// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, CodexKeyProfile, WorkspaceInfo } from "@/types";
import {
  restoreProviderRuntimeSettings,
  useProviderProfileRuntimeSync,
  type ProviderRuntimeSettingsSnapshot,
} from "./useProviderProfileRuntimeSync";

const workspace = {
  id: "ws-1",
  name: "Workspace",
  path: "D:/Project/Test",
  kind: "main",
  connected: true,
} as WorkspaceInfo;

const profile = (id: string): CodexKeyProfile => ({
  id,
  name: id,
  providerKind: "opencode",
  keyEnvVar: "OPENAI_API_KEY",
  key: `key-${id}`,
  baseUrlEnvVar: "OPENAI_BASE_URL",
  baseUrl: "https://opencode.ai/zen/go/v1",
  model: "minimax-m3",
  contextWindow: null,
  maxOutputTokens: null,
  useGateway: true,
  supportsThinking: true,
  supportsReasoningEffort: true,
  lastModelRefreshAtMs: null,
  cachedModels: [],
  groupName: id,
});

const runtimeSettings = (
  activeProfile: CodexKeyProfile | null,
  syncLocalConfig: boolean,
): ProviderRuntimeSettingsSnapshot => ({
  activeCodexKeyProfileId: activeProfile?.id ?? null,
  activeProfile,
  syncProviderProfileToLocalConfig: syncLocalConfig,
});

const noopRollbackSettings = async () => undefined;

describe("useProviderProfileRuntimeSync", () => {
  it("restores only Provider transaction fields and preserves unrelated settings", () => {
    const profileA = profile("profile-a");
    const editedProfileA = { ...profileA, key: "edited-key" };
    const profileB = profile("profile-b");
    const current = {
      codexKeyProfiles: [editedProfileA, profileB],
      activeCodexKeyProfileId: profileB.id,
      syncProviderProfileToLocalConfig: true,
      theme: "dark",
    } as AppSettings;

    const restored = restoreProviderRuntimeSettings(
      current,
      runtimeSettings(profileA, false),
    );

    expect(restored.activeCodexKeyProfileId).toBe(profileA.id);
    expect(restored.syncProviderProfileToLocalConfig).toBe(false);
    expect(restored.codexKeyProfiles).toEqual([profileA, profileB]);
    expect(restored.theme).toBe("dark");
  });

  it("syncs the connected workspace when the active provider changes", async () => {
    const syncWorkspaceRuntime = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ activeProfile }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer: false,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(activeProfile, false),
          syncWorkspaceRuntime,
          rollbackSettings: noopRollbackSettings,
        }),
      { initialProps: { activeProfile: profile("profile-a") } },
    );

    await waitFor(() =>
      expect(syncWorkspaceRuntime).toHaveBeenLastCalledWith("ws-1", "thread-1"),
    );

    rerender({ activeProfile: profile("profile-b") });

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(2));
    expect(syncWorkspaceRuntime).toHaveBeenNthCalledWith(1, "ws-1", "thread-1");
    expect(syncWorkspaceRuntime).toHaveBeenNthCalledWith(2, "ws-1", "thread-1");
  });

  it("does not resync only because the selected thread changes", async () => {
    const syncWorkspaceRuntime = vi.fn(async () => undefined);
    const activeProfile = profile("profile-a");
    const { rerender } = renderHook(
      ({ activeThreadId }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId,
          settingsLoading: false,
          defer: false,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(activeProfile, false),
          syncWorkspaceRuntime,
          rollbackSettings: noopRollbackSettings,
        }),
      { initialProps: { activeThreadId: "thread-1" } },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ activeThreadId: "thread-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1);
  });

  it("defers provider changes until all processing threads finish", async () => {
    const syncWorkspaceRuntime = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ defer }) =>
        useProviderProfileRuntimeSync({
          activeProfile: profile("profile-a"),
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(profile("profile-a"), false),
          syncWorkspaceRuntime,
          rollbackSettings: noopRollbackSettings,
        }),
      { initialProps: { defer: true } },
    );

    expect(syncWorkspaceRuntime).not.toHaveBeenCalled();
    rerender({ defer: false });
    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
  });

  it("applies provider edits made while processing after processing finishes", async () => {
    const syncWorkspaceRuntime = vi.fn(async () => undefined);
    const initialProfile = profile("profile-a");
    const editedProfile = { ...initialProfile, key: "edited-key-profile-a" };
    const { rerender } = renderHook(
      ({ activeProfile, defer }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(activeProfile, false),
          syncWorkspaceRuntime,
          rollbackSettings: noopRollbackSettings,
        }),
      { initialProps: { activeProfile: initialProfile, defer: false } },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ activeProfile: editedProfile, defer: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1);

    rerender({ activeProfile: editedProfile, defer: false });
    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(2));
  });

  it("resyncs when local config synchronization is enabled", async () => {
    const syncWorkspaceRuntime = vi.fn(async () => undefined);
    const activeProfile = profile("profile-a");
    const { rerender } = renderHook(
      ({ syncLocalConfig }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer: false,
          syncLocalConfig,
          settingsSnapshot: runtimeSettings(activeProfile, syncLocalConfig),
          syncWorkspaceRuntime,
          rollbackSettings: noopRollbackSettings,
        }),
      { initialProps: { syncLocalConfig: false } },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ syncLocalConfig: true });
    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(2));
  });

  it("resyncs when a provider environment variable mapping changes", async () => {
    const syncWorkspaceRuntime = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ keyEnvVar }) =>
        useProviderProfileRuntimeSync({
          activeProfile: { ...profile("profile-a"), keyEnvVar },
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer: false,
          syncLocalConfig: true,
          settingsSnapshot: runtimeSettings(
            { ...profile("profile-a"), keyEnvVar },
            true,
          ),
          syncWorkspaceRuntime,
          rollbackSettings: noopRollbackSettings,
        }),
      { initialProps: { keyEnvVar: "OPENAI_API_KEY" } },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ keyEnvVar: "COMPANY_API_KEY" });
    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(2));
  });

  it("rolls settings back to the last successful Provider transaction", async () => {
    const syncWorkspaceRuntime = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("spawn failed"));
    const rollbackSettings = vi.fn(async () => undefined);
    const onError = vi.fn();
    const profileA = profile("profile-a");
    const profileB = profile("profile-b");
    const { rerender } = renderHook(
      ({ activeProfile }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer: false,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(activeProfile, false),
          syncWorkspaceRuntime,
          rollbackSettings,
          onError,
        }),
      { initialProps: { activeProfile: profileA } },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ activeProfile: profileB });

    await waitFor(() =>
      expect(rollbackSettings).toHaveBeenCalledWith(
        runtimeSettings(profileA, false),
      ),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "spawn failed" }),
    );
  });

  it("does not let a stale failed switch roll back a newer Provider request", async () => {
    let rejectStale: (error: Error) => void = () => undefined;
    const staleRequest = new Promise<void>((_resolve, reject) => {
      rejectStale = reject;
    });
    const syncWorkspaceRuntime = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => staleRequest)
      .mockResolvedValueOnce(undefined);
    const rollbackSettings = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ activeProfile }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer: false,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(activeProfile, false),
          syncWorkspaceRuntime,
          rollbackSettings,
        }),
      { initialProps: { activeProfile: profile("profile-a") } },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ activeProfile: profile("profile-b") });
    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(2));
    rerender({ activeProfile: profile("profile-a") });
    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(3));
    rejectStale(new Error("stale failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rollbackSettings).not.toHaveBeenCalled();
  });

  it("invalidates an older request even while the newer Provider is deferred", async () => {
    let rejectInitial: (error: Error) => void = () => undefined;
    const initialRequest = new Promise<void>((_resolve, reject) => {
      rejectInitial = reject;
    });
    const syncWorkspaceRuntime = vi.fn(() => initialRequest);
    const rollbackSettings = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ activeProfile, defer }) =>
        useProviderProfileRuntimeSync({
          activeProfile,
          activeWorkspace: workspace,
          activeThreadId: "thread-1",
          settingsLoading: false,
          defer,
          syncLocalConfig: false,
          settingsSnapshot: runtimeSettings(activeProfile, false),
          syncWorkspaceRuntime,
          rollbackSettings,
        }),
      {
        initialProps: {
          activeProfile: profile("profile-a"),
          defer: false,
        },
      },
    );

    await waitFor(() => expect(syncWorkspaceRuntime).toHaveBeenCalledTimes(1));
    rerender({ activeProfile: profile("profile-b"), defer: true });
    rejectInitial(new Error("stale failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rollbackSettings).not.toHaveBeenCalled();
  });
});
