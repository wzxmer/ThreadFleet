import { describe, expect, it } from "vitest";
import type { ManagedSession } from "@/types";
import {
  buildSessionManagerStats,
  filterAndSortManagedSessions,
  type SessionManagerFilterState,
} from "./sessionManagerFilters";

function session(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    key: "source-a:thread-a",
    sourceId: "source-a",
    threadId: "thread-a",
    sourceKind: "cli",
    cwd: "C:/projects/alpha",
    title: "Alpha",
    preview: null,
    createdAt: null,
    updatedAt: null,
    archivedAt: null,
    isArchived: false,
    parentThreadId: null,
    isSubagent: false,
    subagentNickname: null,
    subagentRole: null,
    projectExists: true,
    fileStatus: "mapped",
    fileConfidence: "exact",
    ...overrides,
  };
}

const baseFilters: SessionManagerFilterState = {
  query: "",
  dateField: "updatedAt",
  datePreset: "all",
  customDateStart: "",
  customDateEnd: "",
  storage: "all",
  sourceId: "all",
  sessionType: "all",
  projectMode: "all",
  projectPaths: [],
  currentProjectPath: null,
  sourceKind: "all",
  fileStatus: "all",
  fileConfidence: "all",
  subagentQuery: "",
  sortField: "updatedAt",
  sortDirection: "desc",
};

describe("session manager filters", () => {
  it("uses local calendar-day boundaries for today, yesterday, and inclusive custom ranges", () => {
    const now = new Date(2026, 6, 22, 15, 30).getTime();
    const items = [
      session({ key: "today", updatedAt: new Date(2026, 6, 22, 0, 0).getTime() }),
      session({ key: "yesterday", updatedAt: new Date(2026, 6, 21, 23, 59).getTime() }),
      session({ key: "older", updatedAt: new Date(2026, 6, 20, 12, 0).getTime() }),
      session({ key: "unknown", updatedAt: null }),
    ];

    expect(filterAndSortManagedSessions(items, { ...baseFilters, datePreset: "today" }, now).map((item) => item.key)).toEqual(["today"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, datePreset: "yesterday" }, now).map((item) => item.key)).toEqual(["yesterday"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, datePreset: "custom", customDateStart: "2026-07-20", customDateEnd: "2026-07-21" }, now).map((item) => item.key)).toEqual(["yesterday", "older"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, datePreset: "custom" }, now).map((item) => item.key)).toEqual(["today", "yesterday", "older", "unknown"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, datePreset: "unknown" }, now).map((item) => item.key)).toEqual(["unknown"]);
  });

  it("filters independently by storage, project, source metadata, and session type", () => {
    const items = [
      session({ key: "local-main", cwd: "C:/projects/alpha" }),
      session({ key: "archived", isArchived: true, archivedAt: 2 }),
      session({ key: "subagent", isSubagent: true, subagentNickname: "reviewer", subagentRole: "review" }),
      session({ key: "missing", cwd: "C:/projects/missing", projectExists: false, fileStatus: "missing", fileConfidence: "none" }),
    ];

    expect(filterAndSortManagedSessions(items, { ...baseFilters, storage: "archived" }).map((item) => item.key)).toEqual(["archived"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, projectMode: "missing" }).map((item) => item.key)).toEqual(["missing"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, sessionType: "subagent", subagentQuery: "review" }).map((item) => item.key)).toEqual(["subagent"]);
    expect(filterAndSortManagedSessions(items, { ...baseFilters, fileStatus: "missing", fileConfidence: "none" }).map((item) => item.key)).toEqual(["missing"]);
  });

  it("builds summary counts from the same filtered collection", () => {
    const items = [
      session({ key: "local", updatedAt: new Date(2026, 6, 22, 9).getTime() }),
      session({ key: "archive", isArchived: true, archivedAt: 2, updatedAt: new Date(2026, 6, 21, 9).getTime() }),
      session({ key: "missing", projectExists: false, cwd: "C:/projects/missing" }),
    ];

    expect(buildSessionManagerStats(items)).toMatchObject({ total: 3, local: 2, archived: 1, missingProjects: 1 });
  });
});
