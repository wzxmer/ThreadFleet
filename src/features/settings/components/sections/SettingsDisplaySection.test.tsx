// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@/types";
import {
  DEFAULT_UI_CJK_FONT_FAMILY,
  DEFAULT_UI_LATIN_FONT_FAMILY,
  WINDOWS_UI_CJK_FONT_FAMILY,
} from "@utils/fonts";
import { SettingsDisplaySection } from "./SettingsDisplaySection";

vi.mock("@services/tauri", () => ({
  listSystemFonts: vi.fn(async () => []),
}));

describe("SettingsDisplaySection", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not expose removed conversation color presets", () => {
    render(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            usageShowRemaining: false,
            showMessageFilePath: true,
            threadTitleAutogenerationEnabled: false,
            uiFontFamily: "",
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={vi.fn(async () => {})}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    expect(screen.queryByText("配色方案")).toBeNull();
    expect(screen.queryByRole("radio", { name: /黑橙/ })).toBeNull();
  });

  it("applies font clarity presets", () => {
    const onUpdateAppSettings = vi.fn(async () => {});
    const onSetUiLatinFontDraft = vi.fn();
    const onSetUiCjkFontDraft = vi.fn();
    const onSetUiFontWeightDraft = vi.fn();

    render(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            usageShowRemaining: false,
            showMessageFilePath: true,
            chatHistoryScrollbackItems: 200,
            threadTitleAutogenerationEnabled: false,
            uiLatinFontFamily: "Arial, sans-serif",
            uiCjkFontFamily: "SimSun, serif",
            uiFontWeight: 450,
            messageFontWeight: 450,
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        uiLatinFontDraft="Arial, sans-serif"
        uiCjkFontDraft="SimSun, serif"
        uiFontWeightDraft={450}
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={onUpdateAppSettings}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetUiLatinFontDraft={onSetUiLatinFontDraft as any}
        onCommitUiLatinFont={vi.fn(async () => {})}
        onSetUiCjkFontDraft={onSetUiCjkFontDraft as any}
        onCommitUiCjkFont={vi.fn(async () => {})}
        onSetUiFontWeightDraft={onSetUiFontWeightDraft as any}
        onCommitUiFontWeight={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Windows 清晰/ }));

    expect(onSetUiLatinFontDraft).toHaveBeenCalledWith(
      DEFAULT_UI_LATIN_FONT_FAMILY,
    );
    expect(onSetUiCjkFontDraft).toHaveBeenCalledWith(WINDOWS_UI_CJK_FONT_FAMILY);
    expect(onSetUiFontWeightDraft).toHaveBeenCalledWith(500);
    expect(onUpdateAppSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
        uiCjkFontFamily: WINDOWS_UI_CJK_FONT_FAMILY,
        uiFontWeight: 500,
      }),
    );
  });

  it("keeps standard and Windows Clear font clarity presets distinct", () => {
    const onUpdateAppSettings = vi.fn(async () => {});

    const { rerender } = render(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            usageShowRemaining: false,
            showMessageFilePath: true,
            chatHistoryScrollbackItems: 200,
            threadTitleAutogenerationEnabled: false,
            uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
            uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
            uiFontWeight: 450,
            messageFontWeight: 450,
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        uiLatinFontDraft={DEFAULT_UI_LATIN_FONT_FAMILY}
        uiCjkFontDraft={DEFAULT_UI_CJK_FONT_FAMILY}
        uiFontWeightDraft={450}
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={onUpdateAppSettings}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("radio", { name: /标准/ }).getAttribute("aria-checked"),
    ).toBe("true");

    rerender(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            usageShowRemaining: false,
            showMessageFilePath: true,
            chatHistoryScrollbackItems: 200,
            threadTitleAutogenerationEnabled: false,
            uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
            uiCjkFontFamily: WINDOWS_UI_CJK_FONT_FAMILY,
            uiFontWeight: 500,
            messageFontWeight: 500,
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        uiLatinFontDraft={DEFAULT_UI_LATIN_FONT_FAMILY}
        uiCjkFontDraft={WINDOWS_UI_CJK_FONT_FAMILY}
        uiFontWeightDraft={500}
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={onUpdateAppSettings}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    expect(
      screen
        .getByRole("radio", { name: /Windows 清晰/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("exposes independent font size categories", () => {
    render(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            usageShowRemaining: false,
            showMessageFilePath: true,
            chatHistoryScrollbackItems: 200,
            threadTitleAutogenerationEnabled: false,
            uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
            uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
            uiFontWeight: 400,
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={vi.fn(async () => {})}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("UI 字号")).toBeTruthy();
    expect(screen.getByLabelText("会话字号")).toBeTruthy();
    expect(screen.getByLabelText("过程与状态字号")).toBeTruthy();
    expect(screen.getByLabelText("代码字号")).toBeTruthy();
    expect(screen.getByRole("button", { name: "全部恢复默认" })).toBeTruthy();
  });

  it("disables remaining-mode selection when usage is hidden", () => {
    render(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            showCodexUsage: false,
            usageShowRemaining: false,
            showMessageFilePath: true,
            uiLatinFontFamily: DEFAULT_UI_LATIN_FONT_FAMILY,
            uiCjkFontFamily: DEFAULT_UI_CJK_FONT_FAMILY,
            uiFontWeight: 400,
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={vi.fn(async () => {})}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    const remainingToggle = screen.getByRole("button", {
      name: "用量显示为剩余量",
    });
    expect(remainingToggle.hasAttribute("disabled")).toBe(true);
  });

  it("keeps notification test controls available", async () => {
    const onUpdateAppSettings = vi.fn(async () => {});

    render(
      <SettingsDisplaySection
        appSettings={
          ({
            theme: "light",
            usageShowRemaining: false,
            showMessageFilePath: true,
            chatHistoryScrollbackItems: 200,
            threadTitleAutogenerationEnabled: false,
            uiFontFamily: "",
            codeFontFamily: "",
            codeFontSize: 11,
            notificationSoundsEnabled: true,
            systemNotificationsEnabled: true,
          } as unknown) as AppSettings
        }
        reduceTransparency={false}
        scaleShortcutTitle=""
        scaleShortcutText=""
        scaleDraft="100%"
        codeFontDraft=""
        codeFontSizeDraft={11}
        onUpdateAppSettings={onUpdateAppSettings}
        onToggleTransparency={vi.fn()}
        onSetScaleDraft={vi.fn() as any}
        onCommitScale={vi.fn(async () => {})}
        onResetScale={vi.fn(async () => {})}
        onSetCodeFontDraft={vi.fn() as any}
        onCommitCodeFont={vi.fn(async () => {})}
        onSetCodeFontSizeDraft={vi.fn() as any}
        onCommitCodeFontSize={vi.fn(async () => {})}
        onTestNotificationSound={vi.fn()}
        onTestSystemNotification={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "测试声音" }));
    fireEvent.click(screen.getByRole("button", { name: "测试通知" }));
  });

});
