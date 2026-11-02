// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CodexDoctorResult } from "@/types";
import { installManagedCodex, checkWindowsUiUpdate } from "@services/tauri";
import { useWindowsUiUpdater } from "@/features/update/hooks/useWindowsUiUpdater";
import { useCodexInstallation } from "./useCodexInstallation";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@services/tauri", () => ({
  getManagedCodexPlatform: vi.fn().mockResolvedValue("windows-x86_64"),
  installManagedCodex: vi.fn(),
  checkWindowsUiUpdate: vi.fn().mockResolvedValue({ status: "upToDate" }),
  installWindowsUiUpdate: vi.fn(),
}));
vi.mock("@services/events", () => ({ subscribeReleaseAssetDownloadProgress: vi.fn(() => vi.fn()) }));
vi.mock("@/features/codex/utils/managedCodex", () => ({
  fetchManagedCodexPackage: vi.fn().mockResolvedValue({
    urls: ["https://example.com/codex.tar.gz"], fileName: "codex.tar.gz",
    version: "0.162.1", size: 123, sha256: "a".repeat(64),
  }),
}));

const missingError = "codex CLI was not found. Install it or select its executable path in settings.";
const installed = { path: "C:/TF/managed-codex/0.162.1/bin/codex.exe", version: "0.162.1" };
const options = () => ({
  enabled: true, codexBin: null, codexArgs: null,
  doctor: vi.fn<() => Promise<CodexDoctorResult>>().mockRejectedValue(new Error(missingError)),
  onInstalled: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(installManagedCodex).mockResolvedValue(installed);
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("Codex first installation", () => {
  it("holds startup checks while local CLI discovery is pending", async () => {
    vi.stubEnv("DEV", false);
    const config = options();
    let finish!: (result: CodexDoctorResult) => void;
    config.doctor.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => {
      const installation = useCodexInstallation(config);
      useWindowsUiUpdater({ autoCheckOnMount: installation.startupReady });
      return installation;
    });
    expect(result.current.startupReady).toBe(false);
    expect(checkWindowsUiUpdate).not.toHaveBeenCalled();
    await act(async () => finish({ version: "0.162.1" } as CodexDoctorResult));
    await waitFor(() => expect(checkWindowsUiUpdate).toHaveBeenCalledTimes(1));
    expect(result.current.promptOpen).toBe(false);
  });

  it("offers installation when the doctor returns no CLI version", async () => {
    const config = options();
    config.doctor.mockResolvedValue({ version: null } as CodexDoctorResult);
    const { result } = renderHook(() => useCodexInstallation(config));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    expect(result.current.startupReady).toBe(false);
  });

  it.each([
    missingError,
    "Codex CLI not found. Install Codex and ensure `codex` is on your PATH.",
  ])("offers installation for the backend discovery error: %s", async (message) => {
    const config = options();
    config.doctor.mockRejectedValue(new Error(message));
    const { result } = renderHook(() => useCodexInstallation(config));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    expect(result.current.startupReady).toBe(false);
  });

  it("queues the MCP startup notice until the CLI installation is saved", async () => {
    vi.stubEnv("DEV", false);
    const config = options();
    let finishSave!: () => void;
    config.onInstalled.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const { result } = renderHook(() => {
      const installation = useCodexInstallation(config);
      useWindowsUiUpdater({ autoCheckOnMount: installation.startupReady });
      return installation;
    });
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    expect(checkWindowsUiUpdate).not.toHaveBeenCalled();
    act(() => { void result.current.install(); });
    await waitFor(() => expect(config.onInstalled).toHaveBeenCalledWith(installed, null));
    expect(result.current.stage).toBe("downloading");
    expect(checkWindowsUiUpdate).not.toHaveBeenCalled();
    act(() => result.current.dismiss());
    expect(result.current.promptOpen).toBe(true);
    await act(async () => finishSave());
    await waitFor(() => expect(checkWindowsUiUpdate).toHaveBeenCalledTimes(1));
    expect(result.current.promptOpen).toBe(false);
  });

  it("keeps the install prompt retryable when activation fails", async () => {
    const config = options();
    config.onInstalled.mockRejectedValueOnce(new Error("settings write failed"));
    const { result } = renderHook(() => useCodexInstallation(config));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    await act(async () => result.current.install());
    expect(result.current.error).toBe("settings write failed");
    expect(result.current.stage).toBe("error");
    expect(result.current.startupReady).toBe(false);
    await act(async () => result.current.install());
    expect(result.current.promptOpen).toBe(false);
  });

  it("allows later startup checks after choosing later", async () => {
    const config = options();
    const { result } = renderHook(() => useCodexInstallation(config));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.startupReady).toBe(true);
    expect(installManagedCodex).not.toHaveBeenCalled();
  });

  it("does not offer installation for an unrelated doctor failure", async () => {
    const config = options();
    config.doctor.mockRejectedValue(new Error("Codex CLI failed to start: access denied"));
    const { result } = renderHook(() => useCodexInstallation(config));
    await waitFor(() => expect(result.current.startupReady).toBe(true));
    expect(result.current.promptOpen).toBe(false);
  });

  it("skips local installation when disabled for remote or mobile runtime", async () => {
    const config = { ...options(), enabled: false };
    const { result } = renderHook(() => useCodexInstallation(config));
    await act(async () => result.current.install());
    expect(config.doctor).not.toHaveBeenCalled();
    expect(installManagedCodex).not.toHaveBeenCalled();
    expect(result.current.startupReady).toBe(true);
  });

  it("ignores an old missing result after switching away from local Codex", async () => {
    const config = options();
    let fail!: (error: Error) => void;
    config.doctor.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { result, rerender } = renderHook(({ enabled }) => useCodexInstallation({ ...config, enabled }), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    await act(async () => fail(new Error(missingError)));
    expect(result.current.promptOpen).toBe(false);
    expect(result.current.startupReady).toBe(true);
  });

  it("still offers installation under StrictMode effect replay", async () => {
    const config = options();
    const { result } = renderHook(() => useCodexInstallation(config), { wrapper: StrictMode });
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
  });
});
