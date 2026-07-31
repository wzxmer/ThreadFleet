// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DebugEntry } from "../../../types";
import {
  cleanupDownloadedReleaseAssets,
  downloadAndOpenReleaseAsset,
  downloadReleaseAsset,
  getWindowsInstallerMigrationCapability,
  getWindowsInstallerMigrationRecoveryStatus,
  getReleasePlatform,
  prepareWindowsInstallerMigration,
  windowsInstallerKind,
} from "../../../services/tauri";
import { subscribeReleaseAssetDownloadProgress } from "../../../services/events";
import { useUpdater } from "./useUpdater";
import { STORAGE_KEY_PENDING_POST_UPDATE_VERSION } from "../utils/postUpdateRelease";
import type { ReleaseAssetDownloadProgress } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock("../../../services/tauri", () => ({
  cleanupDownloadedReleaseAssets: vi.fn(() => Promise.resolve()),
  downloadAndOpenReleaseAsset: vi.fn(() => Promise.resolve({ path: "installer.msi" })),
  downloadReleaseAsset: vi.fn(() => Promise.resolve({ path: "C:\\staging\\installer.msi" })),
  getWindowsInstallerMigrationCapability: vi.fn(() => Promise.resolve({
    platformSupported: true,
    runtimeEnabled: false,
    remoteExecutionAllowed: false,
  })),
  getWindowsInstallerMigrationRecoveryStatus: vi.fn(() => Promise.resolve({
    recoveryRequired: false,
    targetVersion: null,
  })),
  getReleasePlatform: vi.fn(() => Promise.resolve("windows-x86_64")),
  prepareWindowsInstallerMigration: vi.fn(() => Promise.resolve({
    targetVersion: "9.9.9",
    expiresAtUnixMs: 123,
    sourceMetadataItems: 2,
  })),
  windowsInstallerKind: vi.fn(() => Promise.resolve("msi")),
}));

vi.mock("../../../services/events", () => ({
  subscribeReleaseAssetDownloadProgress: vi.fn(() => vi.fn()),
}));

const cleanupDownloadedReleaseAssetsMock = vi.mocked(cleanupDownloadedReleaseAssets);
const downloadAndOpenReleaseAssetMock = vi.mocked(downloadAndOpenReleaseAsset);
const downloadReleaseAssetMock = vi.mocked(downloadReleaseAsset);
const migrationCapabilityMock = vi.mocked(getWindowsInstallerMigrationCapability);
const migrationRecoveryStatusMock = vi.mocked(
  getWindowsInstallerMigrationRecoveryStatus,
);
const getReleasePlatformMock = vi.mocked(getReleasePlatform);
const prepareMigrationMock = vi.mocked(prepareWindowsInstallerMigration);
const windowsInstallerKindMock = vi.mocked(windowsInstallerKind);
const subscribeReleaseAssetDownloadProgressMock = vi.mocked(
  subscribeReleaseAssetDownloadProgress,
);
const fetchMock = vi.fn();
let progressListener: ((event: ReleaseAssetDownloadProgress) => void) | null = null;

function latestReleaseResponse(
  version: string,
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
    digest?: string;
  }> = releaseAssets(),
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: `v${version}`,
      html_url: `https://github.com/wzxmer/ThreadFleet/releases/tag/v${version}`,
      body: "## Latest",
      assets,
    }),
  } as Response;
}

function releaseAssets() {
  return [
    {
      name: "ThreadFleet_9.9.9_x64_en-US.msi",
      browser_download_url:
        "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_x64_en-US.msi",
      size: 100,
    },
    {
      name: "ThreadFleet_9.9.9_aarch64.dmg",
      browser_download_url:
        "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_aarch64.dmg",
      size: 100,
    },
    {
      name: "threadfleet_9.9.9_amd64.AppImage",
      browser_download_url:
        "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/threadfleet_9.9.9_amd64.AppImage",
      size: 100,
    },
  ];
}

describe("useUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupDownloadedReleaseAssetsMock.mockResolvedValue(undefined);
    downloadAndOpenReleaseAssetMock.mockResolvedValue({ path: "installer.msi" });
    downloadReleaseAssetMock.mockResolvedValue({ path: "C:\\staging\\installer.msi" });
    migrationCapabilityMock.mockResolvedValue({
      platformSupported: true,
      runtimeEnabled: false,
      remoteExecutionAllowed: false,
    });
    migrationRecoveryStatusMock.mockResolvedValue({
      recoveryRequired: false,
      targetVersion: null,
    });
    getReleasePlatformMock.mockResolvedValue("windows-x86_64");
    prepareMigrationMock.mockResolvedValue({
      targetVersion: "9.9.9",
      expiresAtUnixMs: 123,
      sourceMetadataItems: 2,
    });
    windowsInstallerKindMock.mockResolvedValue("msi");
    progressListener = null;
    subscribeReleaseAssetDownloadProgressMock.mockImplementation((listener) => {
      progressListener = listener;
      return vi.fn();
    });
    window.localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sets error state when update check fails", async () => {
    fetchMock.mockRejectedValue(new Error("nope"));
    const onDebug = vi.fn();
    const { result } = renderHook(() => useUpdater({ onDebug }));

    await act(async () => {
      await result.current.startUpdate();
    });

    expect(result.current.state.stage).toBe("error");
    expect(result.current.state.error).toBe("nope");
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        timestamp: expect.any(Number),
        label: "updater/error",
        source: "error",
        payload: "nope",
      } satisfies Partial<DebugEntry>),
    );
  });

  it("reports up-to-date when no update is available", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse(__APP_VERSION__));
    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.startUpdate();
    });

    expect(result.current.state.stage).toBe("upToDate");
  });

  it("reports up-to-date when no update is available for manual checks", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse(__APP_VERSION__));
    const { result } = renderHook(() => useUpdater({}));
    let checkResult: Awaited<ReturnType<typeof result.current.checkForUpdates>>;

    await act(async () => {
      checkResult = await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("upToDate");
    expect(checkResult).toEqual({ stage: "upToDate" });
  });

  it("surfaces an error when the latest release has no compatible installer", async () => {
    const onDebug = vi.fn();
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9", []));
    const { result } = renderHook(() => useUpdater({ onDebug }));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("error");
    expect(result.current.state.error).toBe(
      "No compatible installer asset found in the latest release.",
    );
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "updater/error",
        source: "error",
        payload: "No compatible installer asset found in the latest release.",
      }),
    );
  });

  it("fails closed when native macOS architecture cannot be proven", async () => {
    vi.stubGlobal("navigator", {
      ...window.navigator,
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    });
    getReleasePlatformMock.mockResolvedValue("macos-unknown");
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9", [
      {
        name: "ThreadFleet_9.9.9_x86_64.dmg",
        browser_download_url:
          "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_x86_64.dmg",
        size: 100,
      },
      {
        name: "ThreadFleet_9.9.9_aarch64.dmg",
        browser_download_url:
          "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_aarch64.dmg",
        size: 100,
      },
    ]));
    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state).toEqual({
      stage: "error",
      error: "No compatible installer asset found in the latest release.",
    });
  });

  it("blocks automatic installer selection for mixed MSI and NSIS ownership", async () => {
    windowsInstallerKindMock.mockResolvedValue("mixed");
    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state).toEqual({
      stage: "error",
      errorCode: "mixedInstaller",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces backend-bound migration recovery before checking releases", async () => {
    migrationRecoveryStatusMock.mockResolvedValue({
      recoveryRequired: true,
      targetVersion: "9.9.9",
    });
    const { result } = renderHook(() => useUpdater({}));

    await waitFor(() => expect(result.current.state.stage).toBe("migrationReady"));
    expect(result.current.state).toEqual({
      stage: "migrationReady",
      version: "9.9.9",
      migrationRecovery: true,
    });
    expect(windowsInstallerKindMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads and opens the installer when update is available", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9"));

    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.startUpdate();
    });

    expect(result.current.state.stage).toBe("available");
    expect(result.current.state.version).toBe("9.9.9");

    await act(async () => {
      await result.current.startUpdate();
    });

    await waitFor(() => expect(result.current.state.stage).toBe("installing"));
    expect(result.current.state.progress?.totalBytes).toBe(100);
    expect(result.current.state.progress?.downloadedBytes).toBe(100);
    expect(downloadAndOpenReleaseAssetMock).toHaveBeenCalledWith(
      [expect.stringContaining("/releases/download/v9.9.9/")],
      expect.stringMatching(/\.(msi|dmg|AppImage)$/),
      expect.any(String),
      100,
      undefined,
    );
    expect(
      window.localStorage.getItem(STORAGE_KEY_PENDING_POST_UPDATE_VERSION),
    ).toBeNull();
  });

  it("downloads without opening and prepares a backend-authorized NSIS migration", async () => {
    windowsInstallerKindMock.mockResolvedValue("nsis");
    migrationCapabilityMock.mockResolvedValue({
      platformSupported: true,
      runtimeEnabled: true,
      remoteExecutionAllowed: false,
    });
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9", [
      {
        name: "ThreadFleet_9.9.9_x64-setup.exe",
        browser_download_url:
          "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_x64-setup.exe",
        size: 100,
        digest: `sha256:${"b".repeat(64)}`,
      },
      {
        name: "ThreadFleet_9.9.9_x64.msi",
        browser_download_url:
          "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_x64.msi",
        size: 200,
        digest: `sha256:${"a".repeat(64)}`,
      },
    ]));
    const { result } = renderHook(() =>
      useUpdater({ experimentalWindowsInstallerMigrationEnabled: true }),
    );

    await act(async () => {
      await result.current.startUpdate();
    });
    await act(async () => {
      await result.current.startUpdate();
    });

    await waitFor(() => expect(result.current.state.stage).toBe("migrationReady"));
    expect(downloadAndOpenReleaseAssetMock).not.toHaveBeenCalled();
    expect(downloadReleaseAssetMock).toHaveBeenCalledWith(
      [expect.stringContaining(".msi")],
      expect.stringMatching(/\.msi$/),
      expect.any(String),
      200,
      "a".repeat(64),
    );
    expect(prepareMigrationMock).toHaveBeenCalledWith({
      version: "9.9.9",
      artifactPath: "C:\\staging\\installer.msi",
      artifactSize: 200,
      artifactSha256: "a".repeat(64),
    });
  });

  it("keeps NSIS updates on EXE while the migration runtime gate is closed", async () => {
    windowsInstallerKindMock.mockResolvedValue("nsis");
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9", [
      {
        name: "ThreadFleet_9.9.9_x64-setup.exe",
        browser_download_url:
          "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_x64-setup.exe",
        size: 100,
      },
      {
        name: "ThreadFleet_9.9.9_x64.msi",
        browser_download_url:
          "https://github.com/wzxmer/ThreadFleet/releases/download/v9.9.9/ThreadFleet_9.9.9_x64.msi",
        size: 200,
      },
    ]));
    const { result } = renderHook(() =>
      useUpdater({ experimentalWindowsInstallerMigrationEnabled: true }),
    );

    await act(async () => {
      await result.current.startUpdate();
    });
    await act(async () => {
      await result.current.startUpdate();
    });

    await waitFor(() => expect(result.current.state.stage).toBe("installing"));
    expect(downloadAndOpenReleaseAssetMock).toHaveBeenCalledWith(
      [expect.stringContaining(".exe")],
      expect.stringMatching(/\.exe$/),
      expect.any(String),
      100,
      undefined,
    );
    expect(downloadReleaseAssetMock).not.toHaveBeenCalled();
  });

  it("updates download progress from backend progress events", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9"));
    let resolveDownload: ((value: { path: string }) => void) | null = null;
    downloadAndOpenReleaseAssetMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );

    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.startUpdate();
    });
    await act(async () => {
      void result.current.startUpdate();
    });

    const requestId = downloadAndOpenReleaseAssetMock.mock.calls[0]?.[2];
    expect(requestId).toEqual(expect.any(String));

    act(() => {
      progressListener?.({
        id: requestId as string,
        downloadedBytes: 25,
        totalBytes: 100,
      });
    });

    expect(result.current.state.progress).toEqual({
      downloadedBytes: 25,
      totalBytes: 100,
    });

    await act(async () => {
      resolveDownload?.({ path: "installer.msi" });
    });
  });

  it("waits for startup cleanup before downloading an installer", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9"));
    let resolveCleanup: (() => void) | null = null;
    cleanupDownloadedReleaseAssetsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.startUpdate();
    });

    await act(async () => {
      void result.current.startUpdate();
    });

    expect(downloadAndOpenReleaseAssetMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveCleanup?.();
    });

    await waitFor(() =>
      expect(downloadAndOpenReleaseAssetMock).toHaveBeenCalledTimes(1),
    );
  });

  it("resets to idle on dismiss", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9"));
    const { result } = renderHook(() => useUpdater({}));

    await act(async () => {
      await result.current.startUpdate();
    });

    await act(async () => {
      await result.current.dismiss();
    });

    expect(result.current.state.stage).toBe("idle");
  });

  it("surfaces download errors and keeps progress", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9"));
    downloadAndOpenReleaseAssetMock.mockRejectedValue(new Error("download failed"));
    const onDebug = vi.fn();
    const { result } = renderHook(() => useUpdater({ onDebug }));

    await act(async () => {
      await result.current.startUpdate();
    });

    await act(async () => {
      await result.current.startUpdate();
    });

    await waitFor(() => expect(result.current.state.stage).toBe("error"));
    expect(result.current.state.error).toBe("download failed");
    expect(result.current.state.progress?.downloadedBytes).toBe(0);
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        timestamp: expect.any(Number),
        label: "updater/error",
        source: "error",
        payload: "download failed",
      } satisfies Partial<DebugEntry>),
    );
  });

  it("does not run updater workflow when disabled", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse("9.9.9"));
    const { result } = renderHook(() => useUpdater({ enabled: false }));

    await act(async () => {
      await result.current.checkForUpdates();
      await result.current.startUpdate();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(downloadAndOpenReleaseAssetMock).not.toHaveBeenCalled();
    expect(result.current.state.stage).toBe("idle");
  });

  it("skips automatic startup checks when auto-check is disabled but still allows manual checks", async () => {
    fetchMock.mockResolvedValue(latestReleaseResponse(__APP_VERSION__));

    const { result } = renderHook(() =>
      useUpdater({ autoCheckOnMount: false }),
    );

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.stage).toBe("upToDate");
  });

  it("cleans stale downloaded installers on startup", async () => {
    renderHook(() => useUpdater({ autoCheckOnMount: false }));

    await waitFor(() =>
      expect(cleanupDownloadedReleaseAssetsMock).toHaveBeenCalledTimes(1),
    );
  });

  it("clears post-update marker without showing release notes", async () => {
    window.localStorage.setItem(
      STORAGE_KEY_PENDING_POST_UPDATE_VERSION,
      __APP_VERSION__,
    );

    const { result } = renderHook(() => useUpdater({}));

    await waitFor(() =>
      expect(
        window.localStorage.getItem(STORAGE_KEY_PENDING_POST_UPDATE_VERSION),
      ).toBeNull(),
    );

    expect(result.current.postUpdateNotice).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dismisses stale post-update marker without reopening a toast", async () => {
    window.localStorage.setItem(
      STORAGE_KEY_PENDING_POST_UPDATE_VERSION,
      __APP_VERSION__,
    );

    const { result } = renderHook(() => useUpdater({}));

    await waitFor(() =>
      expect(
        window.localStorage.getItem(STORAGE_KEY_PENDING_POST_UPDATE_VERSION),
      ).toBeNull(),
    );

    await act(async () => {
      result.current.dismissPostUpdateNotice();
    });

    expect(result.current.postUpdateNotice).toBeNull();
    expect(
      window.localStorage.getItem(STORAGE_KEY_PENDING_POST_UPDATE_VERSION),
    ).toBeNull();
    expect(result.current.postUpdateNotice).toBeNull();
  });

  it("clears stale post-update marker when version does not match current app", async () => {
    window.localStorage.setItem(
      STORAGE_KEY_PENDING_POST_UPDATE_VERSION,
      "0.0.1",
    );

    const { result } = renderHook(() => useUpdater({}));

    await waitFor(() =>
      expect(
        window.localStorage.getItem(STORAGE_KEY_PENDING_POST_UPDATE_VERSION),
      ).toBeNull(),
    );
    expect(result.current.postUpdateNotice).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
