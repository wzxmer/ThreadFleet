import type { ManagedSession } from "@/types";

export type SessionManagerDateField = "updatedAt" | "createdAt" | "archivedAt";
export type SessionManagerDatePreset = "all" | "today" | "yesterday" | "last7" | "last30" | "thisWeek" | "thisMonth" | "custom" | "unknown";
export type SessionManagerStorageFilter = "all" | "local" | "archived";
export type SessionManagerTypeFilter = "all" | "main" | "subagent";
export type SessionManagerProjectMode = "all" | "current" | "missing" | "selected";
export type SessionManagerSortField = SessionManagerDateField;
export type SessionManagerSortDirection = "asc" | "desc";

export type SessionManagerFilterState = {
  query: string;
  dateField: SessionManagerDateField;
  datePreset: SessionManagerDatePreset;
  customDateStart: string;
  customDateEnd: string;
  storage: SessionManagerStorageFilter;
  sourceId: string;
  sessionType: SessionManagerTypeFilter;
  projectMode: SessionManagerProjectMode;
  projectPaths: string[];
  currentProjectPath: string | null;
  sourceKind: string;
  fileStatus: string;
  fileConfidence: string;
  subagentQuery: string;
  sortField: SessionManagerSortField;
  sortDirection: SessionManagerSortDirection;
};

export type SessionManagerStats = {
  total: number;
  local: number;
  archived: number;
  missingProjects: number;
  today: number;
  projects: Array<{ path: string; count: number }>;
  sources: Array<{ sourceId: string; count: number }>;
  recentActivity: Array<{ date: string; count: number }>;
};

export function normalizeSessionProjectPath(path: string | null | undefined) {
  return (path ?? "").trim().replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function addLocalDays(timestamp: number, days: number) {
  const value = new Date(timestamp);
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days).getTime();
}

function parseLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function formatLocalDateKey(timestamp: number) {
  const value = new Date(timestamp);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateRange(filters: SessionManagerFilterState, nowMs: number) {
  const today = startOfLocalDay(new Date(nowMs));
  if (filters.datePreset === "all" || filters.datePreset === "unknown") return null;
  if (filters.datePreset === "today") return { start: today, end: addLocalDays(today, 1) };
  if (filters.datePreset === "yesterday") return { start: addLocalDays(today, -1), end: today };
  if (filters.datePreset === "last7") return { start: addLocalDays(today, -6), end: addLocalDays(today, 1) };
  if (filters.datePreset === "last30") return { start: addLocalDays(today, -29), end: addLocalDays(today, 1) };
  if (filters.datePreset === "thisWeek") {
    const weekday = new Date(today).getDay();
    const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
    return { start: addLocalDays(today, -daysSinceMonday), end: addLocalDays(today, 1) };
  }
  if (filters.datePreset === "thisMonth") {
    const value = new Date(today);
    return { start: new Date(value.getFullYear(), value.getMonth(), 1).getTime(), end: addLocalDays(today, 1) };
  }
  const start = parseLocalDate(filters.customDateStart);
  const endDate = parseLocalDate(filters.customDateEnd);
  return { start, end: endDate == null ? null : addLocalDays(endDate, 1) };
}

function matchesDate(session: ManagedSession, filters: SessionManagerFilterState, nowMs: number) {
  const timestamp = session[filters.dateField];
  if (filters.datePreset === "unknown") return timestamp == null;
  if (filters.datePreset === "all") return true;
  const range = getDateRange(filters, nowMs);
  if (!range) return true;
  if (range.start == null && range.end == null) return true;
  if (timestamp == null) return false;
  if (range.start != null && timestamp < range.start) return false;
  if (range.end != null && timestamp >= range.end) return false;
  return true;
}

function compareNullableNumbers(left: number | null, right: number | null, direction: SessionManagerSortDirection) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
}

export function filterAndSortManagedSessions(
  sessions: ManagedSession[],
  filters: SessionManagerFilterState,
  nowMs = Date.now(),
) {
  const normalizedQuery = filters.query.trim().toLowerCase();
  const normalizedCurrentProject = normalizeSessionProjectPath(filters.currentProjectPath);
  const selectedProjects = new Set(filters.projectPaths.map(normalizeSessionProjectPath));
  const normalizedSubagentQuery = filters.subagentQuery.trim().toLowerCase();
  return sessions
    .filter((session) => {
      if (filters.storage === "local" && session.isArchived) return false;
      if (filters.storage === "archived" && !session.isArchived) return false;
      if (filters.sourceId !== "all" && session.sourceId !== filters.sourceId) return false;
      if (filters.sessionType === "main" && session.isSubagent) return false;
      if (filters.sessionType === "subagent" && !session.isSubagent) return false;
      if (filters.projectMode === "current" && normalizeSessionProjectPath(session.cwd) !== normalizedCurrentProject) return false;
      if (filters.projectMode === "missing" && session.projectExists) return false;
      if (filters.projectMode === "selected" && !selectedProjects.has(normalizeSessionProjectPath(session.cwd))) return false;
      if (filters.sourceKind !== "all" && session.sourceKind !== filters.sourceKind) return false;
      if (filters.fileStatus !== "all" && session.fileStatus !== filters.fileStatus) return false;
      if (filters.fileConfidence !== "all" && session.fileConfidence !== filters.fileConfidence) return false;
      if (normalizedSubagentQuery && ![session.subagentNickname ?? "", session.subagentRole ?? ""].some((value) => value.toLowerCase().includes(normalizedSubagentQuery))) return false;
      if (!matchesDate(session, filters, nowMs)) return false;
      if (normalizedQuery && ![
        session.title,
        session.threadId,
        session.cwd ?? "",
        session.sourceKind ?? "",
        session.subagentNickname ?? "",
        session.subagentRole ?? "",
      ].some((value) => value.toLowerCase().includes(normalizedQuery))) return false;
      return true;
    })
    .sort((left, right) => (
      compareNullableNumbers(left[filters.sortField], right[filters.sortField], filters.sortDirection)
      || left.title.localeCompare(right.title)
      || left.key.localeCompare(right.key)
    ));
}

export function buildSessionManagerStats(sessions: ManagedSession[], nowMs = Date.now()): SessionManagerStats {
  const today = startOfLocalDay(new Date(nowMs));
  const tomorrow = addLocalDays(today, 1);
  const projectCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const activityCounts = new Map<string, number>();
  for (let day = 6; day >= 0; day -= 1) activityCounts.set(formatLocalDateKey(addLocalDays(today, -day)), 0);
  sessions.forEach((session) => {
    const project = session.cwd?.trim();
    if (project) projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    sourceCounts.set(session.sourceId, (sourceCounts.get(session.sourceId) ?? 0) + 1);
    if (session.updatedAt != null) {
      const key = formatLocalDateKey(session.updatedAt);
      if (activityCounts.has(key)) activityCounts.set(key, (activityCounts.get(key) ?? 0) + 1);
    }
  });
  const byCountThenName = <T extends { count: number }>(name: (value: T) => string) => (left: T, right: T) => right.count - left.count || name(left).localeCompare(name(right));
  return {
    total: sessions.length,
    local: sessions.filter((session) => !session.isArchived).length,
    archived: sessions.filter((session) => session.isArchived).length,
    missingProjects: sessions.filter((session) => !session.projectExists).length,
    today: sessions.filter((session) => session.updatedAt != null && session.updatedAt >= today && session.updatedAt < tomorrow).length,
    projects: Array.from(projectCounts, ([path, count]) => ({ path, count })).sort(byCountThenName((value) => value.path)),
    sources: Array.from(sourceCounts, ([sourceId, count]) => ({ sourceId, count })).sort(byCountThenName((value) => value.sourceId)),
    recentActivity: Array.from(activityCounts, ([date, count]) => ({ date, count })),
  };
}

export function getSessionProjectOptions(sessions: ManagedSession[]) {
  const paths = new Map<string, string>();
  sessions.forEach((session) => {
    const normalized = normalizeSessionProjectPath(session.cwd);
    if (normalized && session.cwd) paths.set(normalized, session.cwd);
  });
  return Array.from(paths.values()).sort((left, right) => left.localeCompare(right));
}
