// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedSession } from "@/types";

const { managerMock, fetchPreviewMock } = vi.hoisted(() => ({
  managerMock: { indexedSessions: [] as ManagedSession[], sessions: [] as ManagedSession[] },
  fetchPreviewMock: vi.fn(),
}));

vi.mock("../hooks/useSessionManager", () => ({
  useSessionManager: () => managerMock,
}));

vi.mock("@services/tauri", () => ({
  fetchManagedSessionPreview: fetchPreviewMock,
}));

import { SessionManagerProvider, useSessionManagerContext } from "./SessionManagerContext";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

beforeEach(() => {
  managerMock.indexedSessions = [];
  managerMock.sessions = [];
  fetchPreviewMock.mockReset();
});

const session: ManagedSession = {
  key: "source:thread",
  sourceId: "source",
  threadId: "thread",
  sourceKind: "codex",
  cwd: "D:\\Project\\B",
  title: "B session",
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
};

function Probe({ target = session }: { target?: ManagedSession }) {
  const context = useSessionManagerContext();
  return <>
    <button type="button" onClick={() => void context.resumeSession(target)}>resume</button>
    <button type="button" onClick={context.migrateToCurrentProject}>migrate</button>
    <span>{context.pendingResumeSession?.title ?? "none"}</span>
  </>;
}

function PreviewProbe() {
  const context = useSessionManagerContext();
  return <>
    {context.manager.sessions.map((candidate) => (
      <button key={candidate.key} type="button" onClick={() => context.focusSession(candidate)}>
        focus {candidate.title}
      </button>
    ))}
    <span>{context.focusedSession?.title ?? "no focus"}</span>
    {context.sessionPreview?.items.length
      ? context.sessionPreview.items.map((item) => <span key={`${item.role}:${item.text}`}>{item.text}</span>)
      : <span>no preview</span>}
    <button type="button" onClick={() => void context.loadEarlierSessionPreview()}>load earlier</button>
  </>;
}

describe("SessionManagerProvider", () => {
  it("loads the latest content page only after explicitly focusing one session", async () => {
    managerMock.indexedSessions = [session];
    managerMock.sessions = [session];
    fetchPreviewMock.mockResolvedValue({
      openingMessage: "opening",
      items: [{ role: "assistant", text: "latest result" }],
      nextCursor: 120,
      incomplete: false,
    });

    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={vi.fn()} onDeriveSession={vi.fn()}><PreviewProbe /></SessionManagerProvider>);

    expect(screen.getByText("no focus")).toBeTruthy();
    expect(fetchPreviewMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "focus B session" }));

    expect(await screen.findByText("latest result")).toBeTruthy();
    expect(fetchPreviewMock).toHaveBeenCalledWith({
      sourceId: "source",
      threadId: "thread",
      limit: 40,
    });
  });

  it("ignores latest-page responses from a previously focused session", async () => {
    const second = { ...session, key: "source:thread-2", threadId: "thread-2", title: "C session" };
    managerMock.indexedSessions = [session, second];
    managerMock.sessions = [session, second];
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    fetchPreviewMock.mockImplementation(({ threadId }: { threadId: string }) => new Promise((resolve) => {
      if (threadId === session.threadId) resolveFirst = resolve;
      else resolveSecond = resolve;
    }));

    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={vi.fn()} onDeriveSession={vi.fn()}><PreviewProbe /></SessionManagerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "focus B session" }));
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalledWith({ sourceId: "source", threadId: "thread", limit: 40 }));
    fireEvent.click(screen.getByRole("button", { name: "focus C session" }));
    await waitFor(() => expect(fetchPreviewMock).toHaveBeenCalledWith({ sourceId: "source", threadId: "thread-2", limit: 40 }));
    await act(async () => {
      resolveSecond?.({ openingMessage: "second", items: [{ role: "assistant", text: "second result" }], nextCursor: null, incomplete: false });
    });

    expect(await screen.findByText("second result")).toBeTruthy();

    await act(async () => {
      resolveFirst?.({ openingMessage: "first", items: [{ role: "assistant", text: "stale result" }], nextCursor: null, incomplete: false });
    });
    expect(screen.queryByText("stale result")).toBeNull();
    expect(screen.getByText("second result")).toBeTruthy();
  });

  it("clears the previous preview synchronously when focus changes", async () => {
    const second = { ...session, key: "source:thread-2", threadId: "thread-2", title: "C session" };
    managerMock.indexedSessions = [session, second];
    managerMock.sessions = [session, second];
    let resolveSecond: ((value: unknown) => void) | undefined;
    fetchPreviewMock
      .mockResolvedValueOnce({
        openingMessage: null,
        items: [{ role: "assistant", text: "first result" }],
        nextCursor: null,
        incomplete: false,
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve;
      }));

    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={vi.fn()} onDeriveSession={vi.fn()}><PreviewProbe /></SessionManagerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "focus B session" }));
    expect(await screen.findByText("first result")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "focus C session" }));
    expect(screen.queryByText("first result")).toBeNull();
    expect(screen.getByText("no preview")).toBeTruthy();

    await act(async () => {
      resolveSecond?.({ openingMessage: null, items: [], nextCursor: null, incomplete: false });
    });
  });

  it("starts only the final latest-page request during rapid selection", async () => {
    vi.useFakeTimers();
    const second = { ...session, key: "source:thread-2", threadId: "thread-2", title: "C session" };
    managerMock.indexedSessions = [session, second];
    managerMock.sessions = [session, second];
    fetchPreviewMock.mockResolvedValue({ openingMessage: null, items: [], nextCursor: null, incomplete: false });

    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={vi.fn()} onDeriveSession={vi.fn()}><PreviewProbe /></SessionManagerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "focus B session" }));
    fireEvent.click(screen.getByRole("button", { name: "focus C session" }));
    await act(async () => vi.advanceTimersByTime(80));

    expect(fetchPreviewMock).toHaveBeenCalledTimes(1);
    expect(fetchPreviewMock).toHaveBeenCalledWith({ sourceId: "source", threadId: "thread-2", limit: 40 });
  });

  it("prepends older pages and preserves the next cursor", async () => {
    managerMock.indexedSessions = [session];
    managerMock.sessions = [session];
    fetchPreviewMock
      .mockResolvedValueOnce({
        openingMessage: "opening",
        items: [{ role: "assistant", text: "latest result" }],
        nextCursor: 120,
        incomplete: false,
      })
      .mockResolvedValueOnce({
        openingMessage: null,
        items: [{ role: "user", text: "older request" }],
        nextCursor: 40,
        incomplete: false,
      });

    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={vi.fn()} onDeriveSession={vi.fn()}><PreviewProbe /></SessionManagerProvider>);
    fireEvent.click(screen.getByRole("button", { name: "focus B session" }));
    expect(await screen.findByText("latest result")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "load earlier" }));

    expect(await screen.findByText("older request")).toBeTruthy();
    expect(screen.getByText("latest result")).toBeTruthy();
    expect(fetchPreviewMock).toHaveBeenLastCalledWith({
      sourceId: "source",
      threadId: "thread",
      limit: 40,
      cursor: 120,
    });
  });

  it("resumes directly when the current project matches", async () => {
    const onResumeSession = vi.fn(async () => false);
    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={onResumeSession} onDeriveSession={vi.fn()} currentWorkspace={{ name: "B", path: "d:/project/b/" }}><Probe /></SessionManagerProvider>);

    fireEvent.click(screen.getByRole("button", { name: "resume" }));

    await waitFor(() => expect(onResumeSession).toHaveBeenCalledWith(session));
    expect(screen.getByText("none")).toBeTruthy();
  });

  it("offers migration when the current project differs", async () => {
    const onResumeSession = vi.fn(async () => false);
    const onDeriveSession = vi.fn();
    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={onResumeSession} onDeriveSession={onDeriveSession} currentWorkspace={{ name: "A", path: "D:\\Project\\A" }}><Probe /></SessionManagerProvider>);

    fireEvent.click(screen.getByRole("button", { name: "resume" }));

    expect(await screen.findByText("B session")).toBeTruthy();
    expect(onResumeSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "migrate" }));
    expect(onDeriveSession).toHaveBeenCalledWith(session);
  });

  it("resumes a missing-project session directly in its temporary mount", async () => {
    const missingSession = { ...session, projectExists: false };
    const onResumeSession = vi.fn(async () => false);
    render(<SessionManagerProvider active onActiveChange={vi.fn()} onResumeSession={onResumeSession} onDeriveSession={vi.fn()} currentWorkspace={{ name: "A", path: "D:\\Project\\A" }}><Probe target={missingSession} /></SessionManagerProvider>);

    fireEvent.click(screen.getByRole("button", { name: "resume" }));

    await waitFor(() => expect(onResumeSession).toHaveBeenCalledWith(missingSession));
    expect(screen.getByText("none")).toBeTruthy();
  });
});
