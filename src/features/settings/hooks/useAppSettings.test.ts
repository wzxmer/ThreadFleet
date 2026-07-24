// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, CodexDoctorResult } from "@/types";
import { useAppSettings } from "./useAppSettings";
import {
  getAppSettings,
  runCodexDoctor,
  updateAppSettings,
} from "@services/tauri";
import { UI_SCALE_DEFAULT, UI_SCALE_MAX } from "@utils/uiScale";

vi.mock("@services/tauri", () => ({
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
  runCodexDoctor: vi.fn(),
}));

const getAppSettingsMock = vi.mocked(getAppSettings);
const updateAppSettingsMock = vi.mocked(updateAppSettings);
const runCodexDoctorMock = vi.mocked(runCodexDoctor);

describe("useAppSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads settings and normalizes theme + uiScale", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        uiScale: UI_SCALE_MAX + 1,
        theme: "nope" as unknown as AppSettings["theme"],
        backendMode: "remote",
        remoteBackendHost: "example:1234",
        personality: "unknown",
        uiFontFamily: "",
        codeFontFamily: "  ",
        codeFontSize: 25,
        toolOutputTokenLimit: 8000.9,
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.uiScale).toBe(UI_SCALE_MAX);
    expect(result.current.settings.theme).toBe("system");
    expect(result.current.settings.uiFontFamily).toContain("system-ui");
    expect(result.current.settings.codeFontFamily).toContain("ui-monospace");
    expect(result.current.settings.codeFontSize).toBe(18);
    expect(result.current.settings.personality).toBe("friendly");
    expect(result.current.settings.backendMode).toBe("remote");
    expect(result.current.settings.remoteBackendHost).toBe("example:1234");
    expect(result.current.settings.sessionSources).toEqual([]);
    expect(result.current.settings.toolOutputTokenLimit).toBe(8000);
  });

  it("preserves persisted session sources", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        sessionSources: [
          {
            id: "source-a",
            name: "Work",
            codexHomePath: "D:\\Profiles\\Work",
            enabled: true,
            isCurrent: false,
            isDefault: false,
            discoveredAt: 10,
            lastScanAt: null,
            status: "missing",
            error: null,
          },
        ],
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings.sessionSources).toHaveLength(1);
    expect(result.current.settings.sessionSources[0]?.name).toBe("Work");
  });

  it("restores persisted UI and code font sizes after startup", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        uiFontSize: 17,
        messageFontSize: 18,
        processFontSize: 15,
        codeFontSize: 15,
        showCodexUsage: false,
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.uiFontSize).toBe(17);
    expect(result.current.settings.messageFontSize).toBe(18);
    expect(result.current.settings.processFontSize).toBe(15);
    expect(result.current.settings.codeFontSize).toBe(15);
    expect(result.current.settings.showCodexUsage).toBe(false);
    expect(result.current.settings.workflowRuntimeMode).toBe("shadow");
  });

  it("defaults new display settings for legacy persisted data", async () => {
    getAppSettingsMock.mockResolvedValue(({} as unknown) as AppSettings);

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.uiFontSize).toBe(14);
    expect(result.current.settings.messageFontSize).toBe(14);
    expect(result.current.settings.workflowRuntimeMode).toBe("shadow");
    expect(result.current.settings.toolOutputTokenLimit).toBeNull();
    expect(result.current.settings.processFontSize).toBe(12);
    expect(result.current.settings.codeFontSize).toBe(13);
    expect(result.current.settings.showCodexUsage).toBe(true);
    expect(result.current.settings.uiCjkFontFamily).toContain("PingFang SC");
    expect(result.current.settings.uiCjkFontFamily).toContain(
      "Noto Sans SC Variable",
    );
    expect(result.current.settings.uiFontWeight).toBe(450);
    expect(result.current.settings.autoDeleteArchivedThreadsEnabled).toBe(false);
    expect(result.current.settings.autoDeleteArchivedThreadsDays).toBe(30);
    expect(result.current.settings.preserveSessionLibraryOnProviderSwitch).toBe(true);
    expect(result.current.settings.syncProviderProfileToLocalConfig).toBe(false);
  });

  it("preserves explicit provider continuity preferences", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        preserveSessionLibraryOnProviderSwitch: false,
        syncProviderProfileToLocalConfig: true,
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.preserveSessionLibraryOnProviderSwitch).toBe(false);
    expect(result.current.settings.syncProviderProfileToLocalConfig).toBe(true);
  });

  it("migrates the legacy PingFang shorthand to the bundled fallback chain", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        uiCjkFontFamily: '"苹方-简", "Microsoft YaHei UI", sans-serif',
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.settings.uiCjkFontFamily).toBe(
      '"PingFang SC", "Noto Sans SC Variable", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    );
  });

  it("migrates retired comfortable message reading style to native", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        messageReadingStyle: "comfortable",
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.messageReadingStyle).toBe("native");

    await act(async () => {
      await result.current.saveSettings({
        ...result.current.settings,
        messageReadingStyle: "codex" as unknown as AppSettings["messageReadingStyle"],
      });
    });

    expect(updateAppSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageReadingStyle: "bubble",
      }),
    );
  });

  it("keeps native message reading style", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        messageReadingStyle: "native",
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.messageReadingStyle).toBe("native");
  });

  it("normalizes codex key provider profile fields", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        activeCodexKeyProfileId: "work",
        codexKeyProfiles: [
          {
            id: "work",
            name: " Work ",
            providerKind: "deepseek",
            usageProtocol: "new-api",
            keyEnvVar: "LEGACY_KEY",
            key: " sk-test ",
            baseUrlEnvVar: "LEGACY_BASE",
            baseUrl: " https://api.deepseek.com/v1 ",
            model: " deepseek-chat ",
            contextWindow: 128000.8,
            maxOutputTokens: 8192.2,
            useGateway: true,
            supportsThinking: true,
            supportsReasoningEffort: true,
            lastModelRefreshAtMs: 1725000000000,
            cachedModels: [
              {
                id: " deepseek-chat ",
                name: " DeepSeek Chat ",
                contextWindow: 128000.8,
                supportedReasoningEfforts: [" high ", "xhigh"],
                defaultReasoningEffort: " xhigh ",
              },
              { id: " ", name: "ignored", contextWindow: -1 },
            ],
            groupName: " Discount ",
            groupMultiplier: 0.07,
          },
          {
            id: "empty",
            name: "Empty",
            key: " ",
          },
        ],
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.activeCodexKeyProfileId).toBe("work");
    expect(result.current.settings.codexKeyProfiles).toEqual([
      expect.objectContaining({
        id: "work",
        name: "Work",
        providerKind: "deepseek",
        usageProtocol: "new-api",
        key: "sk-test",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        useGateway: true,
        supportsThinking: true,
        supportsReasoningEffort: true,
        lastModelRefreshAtMs: 1725000000000,
        groupName: "Discount",
        cachedModels: [
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            contextWindow: 128000,
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "" },
              { reasoningEffort: "xhigh", description: "" },
            ],
            defaultReasoningEffort: "xhigh",
          },
        ],
      }),
    ]);
    expect(result.current.settings.codexKeyProfiles[0]).not.toHaveProperty("groupMultiplier");
  });

  it("keeps opencode profiles on the compatibility gateway", async () => {
    getAppSettingsMock.mockResolvedValue(
      ({
        activeCodexKeyProfileId: "opencode",
        codexKeyProfiles: [
          {
            id: "opencode",
            name: "OpenCode Zen",
            providerKind: "opencode",
            key: "sk-test",
            useGateway: false,
          },
        ],
      } as unknown) as AppSettings,
    );

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.codexKeyProfiles[0]).toEqual(
      expect.objectContaining({
        providerKind: "opencode",
        useGateway: true,
      }),
    );
  });

  it("keeps defaults when getAppSettings fails", async () => {
    getAppSettingsMock.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.settings.uiScale).toBe(UI_SCALE_DEFAULT);
    expect(result.current.settings.theme).toBe("system");
    expect(result.current.settings.uiFontFamily).toContain("system-ui");
    expect(result.current.settings.codeFontFamily).toContain("ui-monospace");
    expect(result.current.settings.backendMode).toBe("local");
    expect(result.current.settings.dictationModelId).toBe("base");
    expect(result.current.settings.interruptShortcut).toBeTruthy();
  });

  it("persists settings via updateAppSettings and updates local state", async () => {
    getAppSettingsMock.mockResolvedValue({} as AppSettings);
    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const next: AppSettings = {
      ...result.current.settings,
      codexArgs: "--profile dev",
      theme: "nope" as unknown as AppSettings["theme"],
      uiScale: 0.04,
      uiFontFamily: "",
      codeFontFamily: "  ",
      codeFontSize: 2,
      notificationSoundsEnabled: false,
    };
    const saved: AppSettings = {
      ...result.current.settings,
      codexArgs: "--profile dev",
      theme: "dark",
      uiScale: 2.4,
      uiFontFamily: "Avenir, sans-serif",
      codeFontFamily: "JetBrains Mono, monospace",
      codeFontSize: 13,
      notificationSoundsEnabled: false,
    };
    updateAppSettingsMock.mockResolvedValue(saved);

    let returned: AppSettings | undefined;
    await act(async () => {
      returned = await result.current.saveSettings(next);
    });

    expect(updateAppSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: "system",
        uiScale: 0.1,
        uiFontFamily: expect.stringContaining("system-ui"),
        codeFontFamily: expect.stringContaining("ui-monospace"),
        codeFontSize: 9,
        notificationSoundsEnabled: false,
      }),
    );
    expect(returned).toEqual(saved);
    expect(result.current.settings.theme).toBe("dark");
    expect(result.current.settings.uiScale).toBe(2.4);
  });

  it("surfaces doctor errors", async () => {
    getAppSettingsMock.mockResolvedValue({} as AppSettings);
    runCodexDoctorMock.mockRejectedValue(new Error("doctor fail"));
    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.doctor("/bin/codex", "--profile test")).rejects.toThrow(
      "doctor fail",
    );
    expect(runCodexDoctorMock).toHaveBeenCalledWith(
      "/bin/codex",
      "--profile test",
    );
  });

  it("returns doctor results", async () => {
    getAppSettingsMock.mockResolvedValue({} as AppSettings);
    const response: CodexDoctorResult = {
      ok: true,
      codexBin: "/bin/codex",
      version: "1.0.0",
      appServerOk: true,
      details: null,
      path: null,
      nodeOk: true,
      nodeVersion: "20.0.0",
      nodeDetails: null,
    };
    runCodexDoctorMock.mockResolvedValue(response);
    const { result } = renderHook(() => useAppSettings());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(result.current.doctor("/bin/codex", null)).resolves.toEqual(
      response,
    );
  });
});
