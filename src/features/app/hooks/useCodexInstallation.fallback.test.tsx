// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { CodexDoctorResult } from "@/types";
import { useCodexInstallation } from "./useCodexInstallation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@services/events", () => ({ subscribeReleaseAssetDownloadProgress: vi.fn(() => vi.fn()) }));

const officialPackage = {
  version: "0.166.0",
  fileName: "codex-package-x86_64-pc-windows-msvc.tar.gz",
  urls: ["https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-pc-windows-msvc.tar.gz"],
  size: 123,
  sha256: "a".repeat(64),
};
const installed = { path: "C:/TF/managed-codex/0.166.0/bin/codex.exe", version: "0.166.0" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch (github.com)")));
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "managed_codex_platform") return "windows-x86_64";
    if (command === "get_official_codex_package") return officialPackage;
    if (command === "install_managed_codex") return installed;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("first CLI installation with failed TF manifest", () => {
  it("installs and activates the official complete package through real IPC wrappers", async () => {
    const onInstalled = vi.fn().mockResolvedValue(undefined);
    const doctor = vi.fn<() => Promise<CodexDoctorResult>>()
      .mockRejectedValue(new Error("codex CLI was not found"));
    const { result } = renderHook(() => useCodexInstallation({
      enabled: true, codexBin: null, codexArgs: null,
      doctor,
      onInstalled,
    }));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    await act(async () => result.current.install());

    expect(invoke).toHaveBeenCalledWith("get_official_codex_package");
    expect(invoke).toHaveBeenCalledWith("install_managed_codex", {
      urls: officialPackage.urls, fileName: officialPackage.fileName,
      requestId: expect.any(String), version: officialPackage.version,
      expectedSize: officialPackage.size, expectedSha256: officialPackage.sha256,
    });
    expect(onInstalled).toHaveBeenCalledWith(installed, null);
    expect(result.current.promptOpen).toBe(false);
    expect(result.current.startupReady).toBe(true);
  });

  it("keeps installation retryable when both TF and official sources fail", async () => {
    const onInstalled = vi.fn().mockResolvedValue(undefined);
    const doctor = vi.fn<() => Promise<CodexDoctorResult>>()
      .mockRejectedValue(new Error("codex CLI was not found"));
    const originalInvoke = vi.mocked(invoke).getMockImplementation()!;
    let failOfficial = true;
    vi.mocked(invoke).mockImplementation(async (command, args, options) => {
      if (command === "get_official_codex_package" && failOfficial) {
        throw new Error("Official release timed out");
      }
      return originalInvoke(command, args, options);
    });
    const { result } = renderHook(() => useCodexInstallation({
      enabled: true, codexBin: null, codexArgs: null, doctor, onInstalled,
    }));
    await waitFor(() => expect(result.current.promptOpen).toBe(true));
    await act(async () => result.current.install());
    expect(result.current.stage).toBe("error");
    expect(result.current.error).toMatch(/ThreadFleet:.*Failed to fetch.*OpenAI:.*timed out/);
    expect(result.current.promptOpen).toBe(true);
    expect(result.current.startupReady).toBe(false);
    expect(onInstalled).not.toHaveBeenCalled();
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "install_managed_codex"))
      .toBe(false);

    failOfficial = false;
    await act(async () => result.current.install());
    expect(onInstalled).toHaveBeenCalledWith(installed, null);
    expect(result.current.promptOpen).toBe(false);
  });
});
