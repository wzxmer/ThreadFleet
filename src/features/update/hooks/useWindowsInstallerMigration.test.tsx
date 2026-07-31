// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeWindowsInstallerMigration } from "@services/tauri";
import { useWindowsInstallerMigration } from "./useWindowsInstallerMigration";

vi.mock("@services/tauri", () => ({
  executeWindowsInstallerMigration: vi.fn(),
}));

const executeMock = vi.mocked(executeWindowsInstallerMigration);
describe("useWindowsInstallerMigration", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("maps a verified completion and reboot requirement", async () => {
    executeMock.mockResolvedValue({
      status: "completed",
      diagnosticCode: "completed",
      transactionId: "55555555-5555-4555-8555-555555555555",
      rebootRequired: true,
    });
    const { result } = renderHook(() => useWindowsInstallerMigration());

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.state.phase).toBe("completed");
    expect(result.current.state.result?.rebootRequired).toBe(true);
  });

  it("resumes an interrupted transaction through backend-held authorization", async () => {
    executeMock
      .mockResolvedValueOnce({
        status: "interrupted",
        diagnosticCode: "interrupted",
        rebootRequired: false,
        message: "resume required",
      })
      .mockResolvedValueOnce({
        status: "completed",
        diagnosticCode: "completed",
        rebootRequired: false,
      });
    const { result } = renderHook(() => useWindowsInstallerMigration());

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.canResume).toBe(true);

    await act(async () => {
      await result.current.execute();
    });
    await waitFor(() => expect(result.current.state.phase).toBe("completed"));
    expect(executeMock).toHaveBeenNthCalledWith(1);
    expect(executeMock).toHaveBeenNthCalledWith(2);
  });

  it("keeps blocked and failed outcomes distinct", async () => {
    executeMock.mockResolvedValue({
      status: "blocked",
      diagnosticCode: "ownershipBlocked",
      rebootRequired: false,
      message: "ownership is mixed",
    });
    const { result } = renderHook(() => useWindowsInstallerMigration());

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.state.phase).toBe("blocked");
    expect(result.current.state.error).toBeNull();

    act(() => result.current.reset());
    executeMock.mockRejectedValueOnce(new Error("bridge failed"));
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.state.phase).toBe("error");
    expect(result.current.state.error).toBe("bridge failed");
  });
});
