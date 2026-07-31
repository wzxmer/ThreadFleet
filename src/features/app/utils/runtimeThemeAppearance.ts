import type { AppSettings, ThemePreference } from "@/types";

export type ConversationAppearance = Pick<
  AppSettings,
  | "messageCanvasColor"
  | "messageUserBubbleColor"
  | "messageUserTextColor"
  | "messageAssistantBubbleColor"
  | "messageAssistantAccentColor"
  | "messageAssistantTextColor"
> & {
  composerInputBackgroundColor?: string;
};

const NATIVE_DARK_APPEARANCE: ConversationAppearance = {
  messageCanvasColor: "#101419",
  messageUserBubbleColor: "#20262c",
  messageUserTextColor: "#dfe5ea",
  messageAssistantBubbleColor: "#151a1f",
  messageAssistantAccentColor: "#68d0ad",
  messageAssistantTextColor: "#dfe5ea",
};

const NATIVE_LIGHT_APPEARANCE: ConversationAppearance = {
  messageCanvasColor: "var(--cm-light-main-bg)",
  messageUserBubbleColor: "var(--cm-light-control-bg)",
  messageUserTextColor: "#000",
  messageAssistantBubbleColor: "var(--cm-light-panel-bg)",
  messageAssistantAccentColor: "var(--cm-light-accent)",
  messageAssistantTextColor: "#000",
  composerInputBackgroundColor: "var(--cm-light-panel-bg)",
};

export function resolveRuntimeThemeAppearance(
  resolvedTheme: ThemePreference,
): {
  conversationAppearance: ConversationAppearance;
} {
  return {
    conversationAppearance:
      resolvedTheme === "dark" ? NATIVE_DARK_APPEARANCE : NATIVE_LIGHT_APPEARANCE,
  };
}
