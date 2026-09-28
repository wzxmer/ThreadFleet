// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkCodexCliUpdate, runCodexUpdate } from "@services/tauri";
import { useCodexCliUpdater } from "./useCodexCliUpdater";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(() => true),
}));

vi.mock("@services/tauri", () => ({
  checkCodexCliUpdate: vi.fn(),
  runCodexUpdate: vi.fn(),
}));

const checkMock = vi.mocked(checkCodexCliUpdate);
const updateMock = vi.mocked(runCodexUpdate);

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
    checkMock.mockResolvedValue(availableCheck);
    updateMock.mockResolvedValue({
      ok: true,
      method: "npm",
      package: "@openai/codex",
      beforeVersion: "0.144.0",
      afterVersion: "0.147.0",
      upgraded: true,
      output: "updated",
      details: null,
    });
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

  it("updates the existing installation only after confirmation", async () => {
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
    });

    await act(async () => {
      await result.current.startInstall();
    });

    expect(updateMock).toHaveBeenCalledWith("codex", null);
    expect(onUpdated).toHaveBeenCalledWith("0.147.0");
    expect(result.current.state.stage).toBe("updated");
  });

  it("reopens the prompt while the in-place update is running", async () => {
    let resolveInstall:
      | ((value: {
          ok: boolean;
          method: "npm";
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

    expect(result.current.state.stage).toBe("installing");

    act(() => {
      resolveInstall?.({
        ok: true,
        method: "npm",
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
