import type { ManagedSessionDerivationPreview, SendMessageResult, WorkspaceInfo } from "@/types";
import type { ThreadDerivationMetadata } from "@threads/utils/threadStorage";

type Args = {
  destination: WorkspaceInfo;
  preview: ManagedSessionDerivationPreview;
  connectWorkspace: (workspace: WorkspaceInfo) => Promise<void>;
  startThreadForWorkspace: (workspaceId: string, options?: { activate?: boolean }) => Promise<string | null>;
  sendUserMessageToThread: (
    workspace: WorkspaceInfo,
    threadId: string,
    text: string,
    images?: string[],
    options?: { skipPromptExpansion?: boolean },
  ) => Promise<SendMessageResult>;
  persistDerivation: (
    workspaceId: string,
    threadId: string,
    metadata: ThreadDerivationMetadata,
  ) => void;
  startError: string;
  sendError: string;
  now?: () => number;
};

export async function deriveManagedSessionIntoWorkspace(args: Args): Promise<string> {
  if (!args.destination.connected) await args.connectWorkspace(args.destination);
  const threadId = await args.startThreadForWorkspace(args.destination.id, { activate: false });
  if (!threadId) throw new Error(args.startError);
  const result = await args.sendUserMessageToThread(
    args.destination,
    threadId,
    args.preview.handoffContent,
    [],
    { skipPromptExpansion: true },
  );
  if (result.status !== "sent") throw new Error(args.sendError);
  args.persistDerivation(args.destination.id, threadId, {
    derivationKind: "session",
    sourceSessionKey: args.preview.sourceSessionKey,
    sourceName: args.preview.sourceName,
    sourceTitle: args.preview.sourceSession.title,
    createdAt: (args.now ?? Date.now)(),
  });
  return threadId;
}

type NavigateToDerivedSessionArgs = {
  destination: WorkspaceInfo;
  threadId: string;
  isCompact: boolean;
  exitDiffView: () => void;
  selectWorkspace: (workspaceId: string) => void;
  setActiveThreadId: (threadId: string, workspaceId: string) => void;
  setActiveTab: (tab: "codex") => void;
  closeSessionManager: () => void;
};

export function navigateToDerivedSession(args: NavigateToDerivedSessionArgs): void {
  args.exitDiffView();
  args.selectWorkspace(args.destination.id);
  args.setActiveThreadId(args.threadId, args.destination.id);
  if (args.isCompact) args.setActiveTab("codex");
  args.closeSessionManager();
}
