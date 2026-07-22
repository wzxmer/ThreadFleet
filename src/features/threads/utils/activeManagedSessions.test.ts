import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@/types";
import {
  cancelSessionTask,
  fetchManagedSessionsPage,
  scanManagedSessions,
} from "@services/tauri";
import {
  clearActiveManagedSessionsCache,
  isSidebarManagedSessionCandidate,
  listActiveManagedSessionsCached,
  managedSessionToThreadRecord,
} from "./activeManagedSessions";

vi.mock("@services/tauri", () => ({
  cancelSessionTask: vi.fn(),
  fetchManagedSessionsPage: vi.fn(),
  scanManagedSessions: vi.fn(),
}));

const session = (overrides: Partial<ManagedSession> = {}): ManagedSession => ({
  key: "source-a:thread-a",
  sourceId: "source-a",
  threadId: "thread-a",
  sourceKind: "vscode",
  cwd: "/tmp/project",
  title: "Recovered thread",
  preview: null,
  createdAt: 100,
  updatedAt: 200,
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
});

describe("activeManagedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveManagedSessionsCache();
    vi.mocked(cancelSessionTask).mockResolvedValue(undefined);
    vi.mocked(scanManagedSessions).mockResolvedValue({
      requestId: "scan",
      totalSessions: 1,
      diagnosticCount: 0,
      cancelled: false,
      sourceSnapshots: [],
    });
    vi.mocked(fetchManagedSessionsPage).mockResolvedValue({
      requestId: "scan",
      items: [session()],
      diagnostics: [],
      total: 1,
      nextOffset: null,
    });
  });

  it("scans only active sessions and reuses the bounded cache", async () => {
    const first = listActiveManagedSessionsCached("source-a");
    const second = listActiveManagedSessionsCached("source-a");

    await expect(first).resolves.toEqual([session()]);
    await expect(second).resolves.toEqual([session()]);
    expect(scanManagedSessions).toHaveBeenCalledTimes(1);
    expect(scanManagedSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIds: ["source-a"],
        includeArchived: false,
      }),
    );
    expect(cancelSessionTask).toHaveBeenCalledTimes(1);
  });

  it("keeps exact normal and linked subagent sessions only", () => {
    expect(isSidebarManagedSessionCandidate(session())).toBe(true);
    expect(
      isSidebarManagedSessionCandidate(
        session({ isSubagent: true, parentThreadId: "thread-parent" }),
      ),
    ).toBe(false);
    expect(
      isSidebarManagedSessionCandidate(
        session({
          isSubagent: true,
          parentThreadId: "thread-parent",
          sourceKind: "subAgentThreadSpawn",
        }),
      ),
    ).toBe(true);
    expect(
      isSidebarManagedSessionCandidate(
        session({ isSubagent: true, sourceKind: "subAgentReview" }),
      ),
    ).toBe(true);
    expect(
      isSidebarManagedSessionCandidate(
        session({ isSubagent: true, sourceKind: "subAgentCompact" }),
      ),
    ).toBe(true);
    expect(isSidebarManagedSessionCandidate(session({ isSubagent: true }))).toBe(false);
    expect(
      isSidebarManagedSessionCandidate(session({ fileConfidence: "ambiguous" })),
    ).toBe(false);
    expect(isSidebarManagedSessionCandidate(session({ isArchived: true }))).toBe(false);
  });

  it("converts managed metadata into a thread/list-compatible record", () => {
    expect(
      managedSessionToThreadRecord(
        session({
          parentThreadId: "thread-parent",
          isSubagent: true,
          subagentNickname: "Tesla",
          subagentRole: "explorer",
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        id: "thread-a",
        title: "Recovered thread",
        updatedAt: 200,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "thread-parent",
              agent_nickname: "Tesla",
              agent_role: "explorer",
            },
          },
        },
      }),
    );
  });
});
