// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";
import { I18N_STRINGS } from "@/features/i18n/strings";
import { useManagedCodexActivation } from "./useManagedCodexActivation";

const automaticSettings = {
  backendMode: "local",
  codexBin: null,
  defaultAgentEngine: "codex",
  geminiBin: "/custom/gemini",
  appLanguage: "zh",
} as AppSettings;
const selectedManagedSettings = {
  ...automaticSettings,
  codexBin: "C:/TF/managed-codex/0.158.0/bin/codex.exe",
};
const installed = {
  path: "C:/TF/managed-codex/0.162.1/bin/codex.exe",
  version: "0.162.1",
};

afterEach(cleanup);

describe("managed Codex installation selection", () => {
  it("keeps automatic selection after a managed fallback update", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const setSettings = vi.fn();
    const { result } = renderHook(() => useManagedCodexActivation(automaticSettings, save, setSettings));

    await act(async () => { await result.current(installed, null); });

    expect(save).toHaveBeenCalledWith(automaticSettings);
    expect(setSettings).toHaveBeenCalledTimes(1);
    expect(setSettings.mock.calls[0][0](automaticSettings)).toEqual(automaticSettings);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(setSettings.mock.invocationCallOrder[0]);
  });

  it("activates the new managed version when the previous version was explicitly selected", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const setSettings = vi.fn();
    const { result } = renderHook(() => useManagedCodexActivation(selectedManagedSettings, save, setSettings));

    await act(async () => { await result.current(installed, selectedManagedSettings.codexBin); });

    const expected = { ...selectedManagedSettings, codexBin: installed.path };
    expect(save).toHaveBeenCalledWith(expected);
    expect(setSettings.mock.calls[0][0](selectedManagedSettings)).toEqual(expected);
  });

  it("rejects an old download result after the user switches to automatic mode", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const setSettings = vi.fn();
    const { result, rerender } = renderHook(
      ({ settings }: { settings: AppSettings }) => useManagedCodexActivation(settings, save, setSettings),
      { initialProps: { settings: selectedManagedSettings as AppSettings } },
    );

    rerender({ settings: automaticSettings });
    await expect(result.current(installed, selectedManagedSettings.codexBin)).rejects.toThrow(
      I18N_STRINGS.zh["codexUpdate.settingsChanged"],
    );

    expect(save).not.toHaveBeenCalled();
    expect(setSettings).not.toHaveBeenCalled();
  });
});
