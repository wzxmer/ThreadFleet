// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/features/i18n/I18nProvider";
import type { SessionSource } from "@/types";
import { SessionManagerOverview } from "./SessionManagerOverview";

const source: SessionSource = { id: "source-a", name: "Primary", codexHomePath: "C:/Users/test/.codex", enabled: true, isCurrent: true, isDefault: true, discoveredAt: 1, lastScanAt: null, status: "ready", error: null };

describe("SessionManagerOverview", () => {
  it("renders the filtered metadata summary without session content", () => {
    render(<I18nProvider preference="system"><SessionManagerOverview sources={[source]} stats={{ total: 5, today: 2, local: 3, archived: 2, missingProjects: 1, projects: [{ path: "C:/projects/alpha", count: 4 }], sources: [{ sourceId: "source-a", count: 5 }], recentActivity: [{ date: "2026-07-16", count: 0 }, { date: "2026-07-17", count: 1 }, { date: "2026-07-18", count: 0 }, { date: "2026-07-19", count: 1 }, { date: "2026-07-20", count: 0 }, { date: "2026-07-21", count: 1 }, { date: "2026-07-22", count: 2 }] }} /></I18nProvider>);
    expect(screen.getByText("Used today").parentElement?.textContent).toContain("2");
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("Primary")).toBeTruthy();
    expect(screen.queryByText("Conversation")).toBeNull();
  });
});
