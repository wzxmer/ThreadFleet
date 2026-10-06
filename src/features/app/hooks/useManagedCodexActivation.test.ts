// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";
import { useManagedCodexActivation } from "./useManagedCodexActivation";

const original = { backendMode: "local", codexBin: "C:/TF/old/codex.exe", appLanguage: "zh" } as AppSettings;
const installed = { path: "C:/TF/new/codex.exe", version: "0.160.1" };

describe("useManagedCodexActivation", () => {
  it("saves the actual installed path before updating frontend settings", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const setSettings = vi.fn();
    const { result } = renderHook(() => useManagedCodexActivation(original, save, setSettings));
    await act(async () => { await result.current(installed, original.codexBin); });
    expect(save).toHaveBeenCalledWith({ ...original, codexBin: installed.path });
    expect(setSettings.mock.calls[0][0](original)).toEqual({ ...original, codexBin: installed.path });
  });

  it("keeps the previous frontend path when persistence fails", async () => {
    const save = vi.fn().mockRejectedValue(new Error("cannot save"));
    const setSettings = vi.fn();
    const { result } = renderHook(() => useManagedCodexActivation(original, save, setSettings));
    await expect(result.current(installed, original.codexBin)).rejects.toThrow("cannot save");
    expect(setSettings).not.toHaveBeenCalled();
  });

  it("does not overwrite a path changed while the package was downloading", async () => {
    const save = vi.fn();
    const setSettings = vi.fn();
    const { result, rerender } = renderHook(({ settings }) => useManagedCodexActivation(settings, save, setSettings), { initialProps: { settings: original } });
    rerender({ settings: { ...original, codexBin: "C:/custom/codex.exe" } });
    await expect(result.current(installed, original.codexBin)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
