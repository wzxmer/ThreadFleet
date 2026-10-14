import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { addWorktree, archiveThread, discoverAgentClis, interruptTurn, listGeminiThreads, readThreadPage,
  respondToServerRequest, resumeThread, sendUserMessage, setThreadName, startThread } from "./tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ removeActive: vi.fn() }));

describe("agent runtime routing", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });

  it("keeps worktree payloads compatible and carries the selected engine", async () => {
    await addWorktree("ws", "feat/test", null);
    expect(invoke).toHaveBeenLastCalledWith("add_worktree", {
      parentId: "ws", branch: "feat/test", name: null, copyAgentsMd: true,
    });
    await addWorktree("ws", "feat/test", null, true, "gemini");
    expect(invoke).toHaveBeenLastCalledWith("add_worktree", {
      parentId: "ws", branch: "feat/test", name: null, copyAgentsMd: true, agentEngine: "gemini",
    });
  });

  it("keeps the Codex start contract and explicitly selects Gemini", async () => {
    await startThread("ws", "quality");
    expect(invoke).toHaveBeenLastCalledWith("start_thread", { workspaceId: "ws", tokenEfficiencyMode: "quality" });
    await startThread("ws", "quality", "gemini");
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "start", params: {} });
  });

  it("routes Gemini send without leaking Codex reasoning and collaboration", async () => {
    await sendUserMessage("ws", "gemini:one", "hello", { model: "gemini-model", effort: "high",
      serviceTier: "fast", collaborationMode: { mode: "plan" }, accessMode: "current", images: ["data:image/png;base64,YQ=="] });
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "send",
      params: { threadId: "gemini:one", text: "hello", model: "gemini-model", accessMode: "current", images: ["data:image/png;base64,YQ=="] } });
  });

  it("uses thread identity for resume and bounded history", async () => {
    await resumeThread("ws", "gemini:one");
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "resume", params: { threadId: "gemini:one" } });
    await readThreadPage("ws", "gemini:one", "cursor", 20, 1024);
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "read",
      params: { threadId: "gemini:one", cursor: "cursor", itemLimit: 20, byteLimit: 1024 } });
    await resumeThread("ws", "codex-one");
    expect(invoke).toHaveBeenLastCalledWith("resume_thread", { workspaceId: "ws", threadId: "codex-one" });
  });

  it("routes approval and cancellation to the owning engine", async () => {
    await respondToServerRequest("ws", "gemini:request", "decline");
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "respond",
      params: { requestId: "gemini:request", result: { decision: "decline" } } });
    await interruptTurn("ws", "gemini:one", "turn");
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "interrupt", params: { threadId: "gemini:one", turnId: "turn" } });
    await respondToServerRequest("ws", 7, "accept");
    expect(invoke).toHaveBeenLastCalledWith("respond_to_server_request", { workspaceId: "ws", requestId: 7, result: { decision: "accept" } });
  });

  it("lists persisted Gemini summaries and routes rename and archive", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ data: [{ id: "gemini:one" }], nextCursor: null });
    expect(await listGeminiThreads("ws")).toEqual([{ id: "gemini:one" }]);
    await setThreadName("ws", "gemini:one", "Title");
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "rename", params: { threadId: "gemini:one", name: "Title" } });
    await archiveThread("ws", "gemini:one");
    expect(invoke).toHaveBeenLastCalledWith("agent_runtime_request", { workspaceId: "ws", operation: "archive", params: { threadId: "gemini:one" } });
    await discoverAgentClis("gemini");
    expect(invoke).toHaveBeenLastCalledWith("discover_agent_clis", { engine: "gemini" });
  });
});
