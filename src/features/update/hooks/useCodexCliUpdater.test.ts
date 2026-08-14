// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseAssetDownloadProgress } from "@/types";
import {
  checkCodexCliUpdate,
  installManagedCodex,
} from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";
import { useCodexCliUpdater } from "./useCodexCliUpdater";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock("@services/tauri", () => ({
  checkCodexCliUpdate: vi.fn(),
  installManagedCodex: vi.fn(),
}));

vi.mock("@services/events", () => ({
  subscribeReleaseAssetDownloadProgress: vi.fn(() => vi.fn()),
}));

const checkMock = vi.mocked(checkCodexCliUpdate);
const installMock = vi.mocked(installManagedCodex);
const subscribeProgressMock = vi.mocked(subscribeReleaseAssetDownloadProgress);
let progressListener: ((event: ReleaseAssetDownloadProgress) => void) | null = null;

const availableCheck = {
  status: "available" as const,
  installed: true,
  currentVersion: "0.144.0",
  latestVersion: "0.147.0",
  platform: "windows-x86_64",
  source: "tencent",
  package: {
    version: "0.147.0",
    fileName: "codex-cli-0.147.0-windows-x86_64.zip",
    urls: ["https://download.example/codex.zip"],
    size: 100,
    sha256: "a".repeat(64),
  },
  reasonCode: null,
};

describe("useCodexCliUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressListener = null;
    checkMock.mockResolvedValue(availableCheck);
    installMock.mockResolvedValue({
      path: "C:\\ThreadFleet\\managed-codex\\0.147.0\\codex.exe",
      version: "0.147.0",
    });
    subscribeProgressMock.mockImplementation((listener) => {
      progressListener = listener;
      return vi.fn();
    });
  });

  it("checks and prompts without installing", async () => {
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        codexBin: null,
        onInstalled: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("available");
    expect(result.current.promptOpen).toBe(true);
    expect(installMock).not.toHaveBeenCalled();
  });

  it("installs only after confirmation and reports progress", async () => {
    const onInstalled = vi.fn();
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        codexBin: "codex",
        onInstalled,
      }),
    );
    await act(async () => {
      await result.current.checkForUpdates();
    });

    await act(async () => {
      await result.current.startInstall();
    });

    expect(installMock).toHaveBeenCalledWith(
      availableCheck.package.urls,
      availableCheck.package.fileName,
      expect.stringMatching(/^codex-cli-/),
      "0.147.0",
      100,
      "a".repeat(64),
    );
    expect(onInstalled).toHaveBeenCalledWith(
      "C:\\ThreadFleet\\managed-codex\\0.147.0\\codex.exe",
      "0.147.0",
    );
    expect(result.current.state.stage).toBe("restartRequired");

    act(() => {
      progressListener?.({ id: "other", downloadedBytes: 100, totalBytes: 100 });
    });
    await waitFor(() => expect(result.current.state.stage).toBe("restartRequired"));
  });

  it("reopens the prompt and renders progress when installation starts from settings", async () => {
    let resolveInstall:
      | ((value: { path: string; version: string }) => void)
      | null = null;
    installMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        codexBin: "codex",
        onInstalled: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.checkForUpdates();
    });
    act(() => result.current.dismissPrompt());
    expect(result.current.promptOpen).toBe(false);

    act(() => {
      void result.current.startInstall();
    });
    await waitFor(() => expect(result.current.state.stage).toBe("downloading"));
    expect(result.current.promptOpen).toBe(true);

    const requestId = installMock.mock.calls[0]?.[2];
    act(() => {
      progressListener?.({
        id: requestId,
        downloadedBytes: 50,
        totalBytes: 100,
      });
    });
    expect(result.current.state.progress).toEqual({
      downloadedBytes: 50,
      totalBytes: 100,
    });

    act(() => {
      resolveInstall?.({
        path: "C:\\ThreadFleet\\managed-codex\\0.147.0\\codex.exe",
        version: "0.147.0",
      });
    });
    await waitFor(() => expect(result.current.state.stage).toBe("restartRequired"));
  });

  it("refuses control-side installation for a remote host", async () => {
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        installEnabled: false,
        codexBin: null,
        onInstalled: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.checkForUpdates();
      await result.current.startInstall();
    });
    expect(result.current.state.stage).toBe("available");
    expect(installMock).not.toHaveBeenCalled();
  });
});
