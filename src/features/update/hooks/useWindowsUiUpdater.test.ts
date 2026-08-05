// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseAssetDownloadProgress } from "@/types";
import {
  checkWindowsUiUpdate,
  installWindowsUiUpdate,
} from "@services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "@services/events";
import { useWindowsUiUpdater } from "./useWindowsUiUpdater";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock("@services/tauri", () => ({
  checkWindowsUiUpdate: vi.fn(),
  installWindowsUiUpdate: vi.fn(),
}));

vi.mock("@services/events", () => ({
  subscribeReleaseAssetDownloadProgress: vi.fn(() => vi.fn()),
}));

const checkMock = vi.mocked(checkWindowsUiUpdate);
const installMock = vi.mocked(installWindowsUiUpdate);
const subscribeProgressMock = vi.mocked(subscribeReleaseAssetDownloadProgress);
let progressListener: ((event: ReleaseAssetDownloadProgress) => void) | null = null;

const availableCheck = {
  status: "available" as const,
  installed: true,
  managed: true,
  currentVersion: "1.3.16",
  release: {
    version: "1.3.18",
    releaseUrl: "https://github.com/sbroenne/mcp-windows/releases/tag/v1.3.18",
    assetSize: 100,
    assetSha256: "a".repeat(64),
  },
  reasonCode: null,
};

describe("useWindowsUiUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    progressListener = null;
    checkMock.mockResolvedValue(availableCheck);
    installMock.mockResolvedValue({
      version: "1.3.18",
      requiresCodexRestart: true,
    });
    subscribeProgressMock.mockImplementation((listener) => {
      progressListener = listener;
      return vi.fn();
    });
  });

  it("checks without installing", async () => {
    const { result } = renderHook(() =>
      useWindowsUiUpdater({ autoCheckOnMount: false }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("available");
    expect(result.current.state.check?.currentVersion).toBe("1.3.16");
    expect(installMock).not.toHaveBeenCalled();
  });

  it("installs only after an explicit start call and reports restart", async () => {
    const { result } = renderHook(() =>
      useWindowsUiUpdater({ autoCheckOnMount: false }),
    );
    await act(async () => {
      await result.current.checkForUpdates();
    });

    await act(async () => {
      await result.current.startInstall();
    });

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock).toHaveBeenCalledWith(
      "1.3.18",
      expect.stringMatching(/^windows-ui-/),
      100,
      "a".repeat(64),
    );
    expect(result.current.state).toMatchObject({
      stage: "restartRequired",
      version: "1.3.18",
    });
  });

  it("ignores progress from other downloads", async () => {
    let resolveInstall: ((value: { version: string; requiresCodexRestart: boolean }) => void) | null = null;
    installMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useWindowsUiUpdater({ autoCheckOnMount: false }),
    );
    await act(async () => {
      await result.current.checkForUpdates();
    });

    act(() => {
      void result.current.startInstall();
    });
    await waitFor(() => expect(result.current.state.stage).toBe("downloading"));
    act(() => {
      progressListener?.({ id: "other", downloadedBytes: 100, totalBytes: 100 });
    });
    expect(result.current.state.stage).toBe("downloading");

    act(() => {
      resolveInstall?.({ version: "1.3.18", requiresCodexRestart: true });
    });
    await waitFor(() => expect(result.current.state.stage).toBe("restartRequired"));
  });

  it("does not call the backend when disabled", async () => {
    const { result } = renderHook(() =>
      useWindowsUiUpdater({ enabled: false, autoCheckOnMount: false }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
      await result.current.startInstall();
    });

    expect(checkMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
  });
});
