import { describe, expect, it } from "vitest";
import { resolveRuntimeThemeAppearance } from "./runtimeThemeAppearance";

describe("resolveRuntimeThemeAppearance", () => {
  it("uses native dark conversation colors for dark mode", () => {
    const appearance = resolveRuntimeThemeAppearance("dark");

    expect(appearance.conversationAppearance.messageCanvasColor).toBe("#101419");
    expect(appearance.conversationAppearance.messageUserTextColor).toBe("#dfe5ea");
    expect(appearance.conversationAppearance.messageAssistantBubbleColor).toBe("#151a1f");
    expect(appearance.conversationAppearance.messageAssistantAccentColor).toBe("#68d0ad");
    expect(appearance.conversationAppearance.composerInputBackgroundColor).toBeUndefined();
  });

  it("uses the unified native light palette", () => {
    const appearance = resolveRuntimeThemeAppearance("light");

    expect(appearance.conversationAppearance.messageCanvasColor).toBe(
      "var(--cm-light-main-bg)",
    );
    expect(appearance.conversationAppearance.messageUserBubbleColor).toBe(
      "var(--cm-light-control-bg)",
    );
    expect(appearance.conversationAppearance.messageUserTextColor).toBe(
      "var(--cm-light-text-primary)",
    );
    expect(appearance.conversationAppearance.messageAssistantTextColor).toBe(
      "var(--cm-light-text-primary)",
    );
    expect(appearance.conversationAppearance.messageAssistantAccentColor).toBe(
      "var(--cm-light-accent)",
    );
    expect(appearance.conversationAppearance.composerInputBackgroundColor).toBe(
      "var(--cm-light-panel-bg)",
    );
  });
});
