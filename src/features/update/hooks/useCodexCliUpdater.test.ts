// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkCodexCliUpdate, installManagedCodex, runCodexUpdate } from "@services/tauri";
import { useCodexCliUpdater } from "./useCodexCliUpdater";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock("@services/tauri", () => ({
  checkCodexCliUpdate: vi.fn(),
  runCodexUpdate: vi.fn(),
  installManagedCodex: vi.fn(),
}));
vi.mock("@services/events", () => ({ subscribeReleaseAssetDownloadProgress: vi.fn(() => vi.fn()) }));

const checkMock = vi.mocked(checkCodexCliUpdate);
const updateMock = vi.mocked(runCodexUpdate);
const installMock = vi.mocked(installManagedCodex);

const availableCheck = {
  status: "available" as const,
  installed: true,
  currentVersion: "0.144.0",
  latestVersion: "0.147.0",
  platform: "windows-x86_64",
  source: "npm",
  package: null,
  reasonCode: null,
};

describe("useCodexCliUpdater", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    checkMock.mockResolvedValue(availableCheck);
    updateMock.mockResolvedValue({
      ok: true,
      method: "codex",
      package: "@openai/codex",
      beforeVersion: "0.144.0",
      afterVersion: "0.147.0",
      upgraded: true,
      output: "updated",
      details: null,
    });
  });

  it("automatically updates the current CLI when startup finds a newer version", async () => {
    vi.stubEnv("DEV", false);
    const onUpdated = vi.fn();
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: true,
        autoInstallOnMount: true,
        codexBin: "codex",
        onUpdated,
      }),
    );

    await waitFor(() => expect(result.current.state.stage).toBe("updated"));

    expect(checkMock).toHaveBeenCalledWith("codex");
    expect(updateMock).toHaveBeenCalledWith("codex", null);
    expect(onUpdated).toHaveBeenCalledWith("0.147.0");
    expect(result.current.promptOpen).toBe(false);
  });

  it("checks and prompts without installing", async () => {
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        codexBin: null,
        onUpdated: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.state.stage).toBe("available");
    expect(result.current.promptOpen).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("updates the current npm installation in place", async () => {
    const onUpdated = vi.fn();
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        codexBin: "codex",
        onUpdated,
      }),
    );

    await act(async () => {
      await result.current.checkForUpdates();
      await result.current.startInstall();
    });

    expect(updateMock).toHaveBeenCalledWith("codex", null);
    expect(onUpdated).toHaveBeenCalledWith("0.147.0");
    expect(result.current.state.update?.method).toBe("codex");
    expect(result.current.state.stage).toBe("updated");
  });

  it("reopens the prompt while the in-place update is running", async () => {
    let resolveInstall:
      | ((value: {
          ok: boolean;
          method: "codex";
          package: string;
          beforeVersion: string;
          afterVersion: string;
          upgraded: boolean;
          output: string;
          details: null;
        }) => void)
      | null = null;
    updateMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        codexBin: "codex",
        onUpdated: vi.fn(),
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
    await waitFor(() => expect(result.current.state.stage).toBe("installing"));
    expect(result.current.promptOpen).toBe(true);

    act(() => {
      resolveInstall?.({
        ok: true,
        method: "codex",
        package: "@openai/codex",
        beforeVersion: "0.144.0",
        afterVersion: "0.147.0",
        upgraded: true,
        output: "updated",
        details: null,
      });
    });
    await waitFor(() => expect(result.current.state.stage).toBe("updated"));
  });

  it("updates the TF-managed CLI and activates its path before reporting success", async () => {
    const packageInfo = {
      version: "0.160.1", fileName: "codex-package-x86_64-pc-windows-msvc.tar.gz",
      urls: ["https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-package-x86_64-pc-windows-msvc.tar.gz"],
      size: 123, sha256: "a".repeat(64),
    };
    checkMock.mockResolvedValue({ ...availableCheck, source: "managed", latestVersion: "0.160.1", package: packageInfo });
    const installed = { path: "C:/TF/managed-codex/0.160.1/bin/codex.exe", version: "0.160.1" };
    installMock.mockResolvedValue(installed);
    const onInstalled = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCodexCliUpdater({
      autoCheckOnMount: false, codexBin: "C:/TF/managed-codex/0.158.0/bin/codex.exe", onInstalled,
    }));
    await act(async () => { await result.current.checkAndUpdate(); });
    expect(installMock).toHaveBeenCalledWith(packageInfo.urls, packageInfo.fileName, expect.any(String), packageInfo.version, packageInfo.size, packageInfo.sha256);
    expect(onInstalled).toHaveBeenCalledWith(installed, "C:/TF/managed-codex/0.158.0/bin/codex.exe");
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.current.state.stage).toBe("updated");
    expect(result.current.state.installedVersion).toBe("0.160.1");
    expect(result.current.promptOpen).toBe(true);
  });

  it("updates a supported local CLI from a single check action", async () => {
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: "codex" }));
    await act(async () => { await result.current.checkAndUpdate(); });
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.stage).toBe("updated");
    expect(result.current.promptOpen).toBe(true);
  });

  it("does not claim success if the new CLI path cannot be saved", async () => {
    checkMock.mockResolvedValue({ ...availableCheck, source: "managed", package: {
      version: "0.147.0", fileName: "codex.tar.gz", urls: ["https://github.com/openai/codex/package.tar.gz"], size: 123, sha256: "a".repeat(64),
    } });
    installMock.mockResolvedValue({ path: "C:/TF/new/codex.exe", version: "0.147.0" });
    const onInstalled = vi.fn().mockRejectedValue(new Error("settings write failed"));
    const onUpdated = vi.fn();
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: "C:/TF/old/codex.exe", onInstalled, onUpdated }));
    await act(async () => { await result.current.checkForUpdates(); await result.current.startInstall(); });
    expect(result.current.state.stage).toBe("error");
    expect(result.current.state.error).toBe("settings write failed");
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("routes the settings update button through the managed installer", async () => {
    checkMock.mockResolvedValue({ ...availableCheck, source: "managed", package: {
      version: "0.147.0", fileName: "codex.tar.gz", urls: ["https://github.com/openai/codex/package.tar.gz"], size: 123, sha256: "a".repeat(64),
    } });
    installMock.mockResolvedValue({ path: "C:/TF/new/codex.exe", version: "0.147.0" });
    const onInstalled = vi.fn();
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: "C:/TF/old/codex.exe", onInstalled }));
    let updated;
    await act(async () => { updated = await result.current.updateFromSettings("C:/TF/old/codex.exe", null); });
    expect(updated).toMatchObject({ ok: true, method: "managed", afterVersion: "0.147.0" });
    expect(onInstalled).toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps explicit draft paths on the existing native update route", async () => {
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: "C:/TF/managed/codex.exe" }));
    await act(async () => { await result.current.updateFromSettings("C:/custom/codex.exe", "--profile custom"); });
    expect(updateMock).toHaveBeenCalledWith("C:/custom/codex.exe", "--profile custom");
    expect(checkMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
  });

  it("returns a successful unchanged result when settings update finds the latest CLI", async () => {
    checkMock.mockResolvedValue({ ...availableCheck, source: "managed", status: "upToDate" });
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: "codex" }));
    let updated;
    await act(async () => { updated = await result.current.updateFromSettings("codex", null); });
    expect(updated).toMatchObject({ ok: true, method: "managed", upgraded: false, afterVersion: availableCheck.currentVersion });
    expect(installMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("shows check failures and prevents installation from stale results", async () => {
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: null }));
    await act(async () => { await result.current.checkForUpdates(); });
    checkMock.mockRejectedValueOnce(new Error("version request timed out"));
    await act(async () => { await result.current.checkForUpdates(); await result.current.startInstall(); });
    expect(result.current.state.stage).toBe("error");
    expect(result.current.promptOpen).toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("shares overlapping update checks", async () => {
    let resolveCheck!: (value: typeof availableCheck) => void;
    checkMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCheck = resolve; }));
    const { result } = renderHook(() => useCodexCliUpdater({ autoCheckOnMount: false, codexBin: null }));
    await act(async () => {
      const first = result.current.checkForUpdates();
      const second = result.current.checkForUpdates();
      resolveCheck(availableCheck);
      await Promise.all([first, second]);
    });
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("refuses control-side installation for a remote host", async () => {
    const { result } = renderHook(() =>
      useCodexCliUpdater({
        autoCheckOnMount: false,
        installEnabled: false,
        codexBin: null,
        onUpdated: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.checkForUpdates();
      await result.current.startInstall();
    });
    expect(result.current.state.stage).toBe("available");
    expect(updateMock).not.toHaveBeenCalled();
  });
});
