import type { SessionSourceSnapshot } from "@/types";

export type ThreadListRuntimeContext = {
  sourceId: string | null;
  runtimeGeneration: number;
};

export type ThreadListRefreshReason =
  | "initial_restore"
  | "workspace_focus"
  | "workspace_poll"
  | "manual_refresh"
  | "sort_change"
  | "app_server_runtime_refresh"
  | "remote_event_gap"
  | "unknown";

export type ThreadListContinuityState = {
  sourceId: string | null;
  runtimeGeneration: number;
  listGeneration: number;
  requestId: string;
  requestSequence: number;
  paginationComplete: boolean;
  verifiedSnapshot: SessionSourceSnapshot | null;
  staleThreadIds: string[];
};

export type ThreadListVerifiedCache = {
  sourceId: string | null;
  verifiedSnapshot: SessionSourceSnapshot | null;
};
