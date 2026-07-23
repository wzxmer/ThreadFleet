import type {
  AccessMode,
  AppMention,
  ComposerSendIntent,
  RateLimitSnapshot,
  ReviewTarget,
  ServiceTier,
} from "@/types";
import { clampThreadName } from "@threads/utils/threadNaming";
import { formatRelativeTime } from "@utils/time";

export type SendMessageOptions = {
  skipPromptExpansion?: boolean;
  skipRuntimePreflight?: boolean;
  model?: string | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: AccessMode;
  appMentions?: AppMention[];
  sendIntent?: ComposerSendIntent;
  replaceMessageId?: string;
  skipAutoCompact?: boolean;
};

type FastCommandAction = "toggle" | "on" | "off" | "status" | "invalid";

type ResolveSendMessageOptionsArgs = {
  options?: SendMessageOptions;
  defaults: {
    accessMode?: AccessMode;
    model?: string | null;
    effort?: string | null;
    serviceTier?: ServiceTier | null | undefined;
    collaborationMode?: Record<string, unknown> | null;
    steerEnabled: boolean;
    isProcessing: boolean;
    activeTurnId: string | null;
  };
};

export type ResolvedSendMessageOptions = {
  resolvedModel?: string | null;
  resolvedEffort?: string | null;
  resolvedServiceTier?: ServiceTier | null | undefined;
  sanitizedCollaborationMode: Record<string, unknown> | null;
  resolvedAccessMode?: AccessMode;
  appMentions: AppMention[];
  sendIntent: ComposerSendIntent;
  shouldSteer: boolean;
  requestMode: "start" | "steer";
};

export type TurnStartPayload = {
  model?: string | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: AccessMode;
  images?: string[];
  appMentions?: AppMention[];
};

export function buildReviewThreadTitle(target: ReviewTarget): string | null {
  if (target.type === "commit") {
    const shortSha = target.sha.trim().slice(0, 7);
    const title = target.title?.trim() ?? "";
    if (shortSha && title) {
      return clampThreadName(`Review ${shortSha}: ${title}`);
    }
    if (shortSha) {
      return clampThreadName(`Review ${shortSha}`);
    }
    return clampThreadName("Review Commit");
  }
  if (target.type === "baseBranch") {
    return clampThreadName(`Review ${target.branch}`);
  }
  if (target.type === "uncommittedChanges") {
    return "Review Working Tree";
  }
  return null;
}

export function isStaleSteerTurnError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("no active turn")) {
    return true;
  }
  return normalized.includes("active turn") && normalized.includes("not found");
}

export function isThreadNotFoundError(error: unknown): boolean {
  let message = "";
  if (typeof error === "string") {
    message = error;
  } else if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") {
      message = record.message;
    } else if (record.error && typeof record.error === "object") {
      const nestedError = record.error as Record<string, unknown>;
      if (typeof nestedError.message === "string") {
        message = nestedError.message;
      }
    }
  }
  return message.trim().toLowerCase().includes("thread not found");
}

export function parseFastCommand(text: string): FastCommandAction {
  const arg = text.replace(/^\/fast\b/i, "").trim().toLowerCase();
  if (!arg) {
    return "toggle";
  }
  if (arg === "on") {
    return "on";
  }
  if (arg === "off") {
    return "off";
  }
  if (arg === "status") {
    return "status";
  }
  return "invalid";
}

export function resolveSendMessageOptions({
  options,
  defaults,
}: ResolveSendMessageOptionsArgs): ResolvedSendMessageOptions {
  const resolvedModel =
    options?.model !== undefined ? options.model : defaults.model;
  const resolvedEffort =
    options?.effort !== undefined ? options.effort : defaults.effort;
  const resolvedServiceTier =
    options?.serviceTier !== undefined ? options.serviceTier : defaults.serviceTier;
  const resolvedCollaborationMode =
    options?.collaborationMode !== undefined
      ? options.collaborationMode
      : defaults.collaborationMode;
  const sanitizedCollaborationMode =
    resolvedCollaborationMode &&
    typeof resolvedCollaborationMode === "object" &&
    "settings" in resolvedCollaborationMode
      ? resolvedCollaborationMode
      : null;
  const resolvedAccessMode =
    options?.accessMode !== undefined ? options.accessMode : defaults.accessMode;
  const appMentions = options?.appMentions ?? [];
  const sendIntent = options?.sendIntent ?? "default";
  const canSteerCurrentTurn =
    defaults.isProcessing && defaults.steerEnabled && Boolean(defaults.activeTurnId);
  const shouldSteer =
    sendIntent === "steer"
      ? canSteerCurrentTurn
      : sendIntent === "queue"
        ? false
        : canSteerCurrentTurn;

  return {
    resolvedModel,
    resolvedEffort,
    resolvedServiceTier,
    sanitizedCollaborationMode,
    resolvedAccessMode,
    appMentions,
    sendIntent,
    shouldSteer,
    requestMode: shouldSteer ? "steer" : "start",
  };
}

export function buildTurnStartPayload({
  model,
  effort,
  serviceTier,
  collaborationMode,
  accessMode,
  images,
  appMentions,
}: {
  model?: string | null;
  effort?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: AccessMode;
  images: string[];
  appMentions: AppMention[];
}): TurnStartPayload {
  const payload: TurnStartPayload = {
    model,
    effort,
    collaborationMode,
    accessMode,
    images,
  };
  if (serviceTier !== undefined) {
    payload.serviceTier = serviceTier;
  }
  if (appMentions.length > 0) {
    payload.appMentions = appMentions;
  }
  return payload;
}

function normalizeReset(value?: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function resetLabel(value?: number | null): string | null {
  const resetAt = normalizeReset(value);
  return resetAt ? formatRelativeTime(resetAt) : null;
}

function getCollaborationModeId(
  collaborationMode?: Record<string, unknown> | null,
): string {
  if (
    !collaborationMode ||
    typeof collaborationMode !== "object" ||
    !("settings" in collaborationMode) ||
    !collaborationMode.settings ||
    typeof collaborationMode.settings !== "object" ||
    !("id" in collaborationMode.settings)
  ) {
    return "";
  }
  return String(collaborationMode.settings.id ?? "");
}

export function buildStatusLines({
  model,
  serviceTier,
  effort,
  accessMode,
  collaborationMode,
  rateLimits,
}: {
  model?: string | null;
  serviceTier?: ServiceTier | null | undefined;
  effort?: string | null;
  accessMode?: AccessMode;
  collaborationMode?: Record<string, unknown> | null;
  rateLimits: RateLimitSnapshot | null;
}): string[] {
  const lines = [
    "Session status:",
    `- Model: ${model ?? "default"}`,
    `- Fast mode: ${serviceTier === "fast" ? "on" : "off"}`,
    `- Reasoning effort: ${effort ?? "default"}`,
    `- Access: ${accessMode ?? "current"}`,
    `- Collaboration: ${getCollaborationModeId(collaborationMode) || "off"}`,
  ];

  const primaryUsed = rateLimits?.primary?.usedPercent;
  const secondaryUsed = rateLimits?.secondary?.usedPercent;

  if (typeof primaryUsed === "number") {
    const reset = resetLabel(rateLimits?.primary?.resetsAt);
    lines.push(
      `- Session usage: ${Math.round(primaryUsed)}%${
        reset ? ` (resets ${reset})` : ""
      }`,
    );
  }
  if (typeof secondaryUsed === "number") {
    const reset = resetLabel(rateLimits?.secondary?.resetsAt);
    lines.push(
      `- Weekly usage: ${Math.round(secondaryUsed)}%${
        reset ? ` (resets ${reset})` : ""
      }`,
    );
  }

  const credits = rateLimits?.credits ?? null;
  if (credits?.hasCredits) {
    if (credits.unlimited) {
      lines.push("- Credits: unlimited");
    } else if (credits.balance) {
      lines.push(`- Credits: ${credits.balance}`);
    }
  }

  return lines;
}

export function buildMcpStatusLines(
  data: Array<Record<string, unknown>>,
): string[] {
  const lines: string[] = ["MCP tools:"];
  if (data.length === 0) {
    lines.push("- No MCP servers configured.");
    return lines;
  }

  const servers = [...data].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")),
  );
  for (const server of servers) {
    const name = String(server.name ?? "unknown");
    const authStatus = server.authStatus ?? server.auth_status ?? null;
    const authLabel =
      typeof authStatus === "string"
        ? authStatus
        : authStatus && typeof authStatus === "object" && "status" in authStatus
          ? String((authStatus as { status?: unknown }).status ?? "")
          : "";
    lines.push(`- ${name}${authLabel ? ` (auth: ${authLabel})` : ""}`);

    const toolsRecord =
      server.tools && typeof server.tools === "object"
        ? (server.tools as Record<string, unknown>)
        : {};
    const prefix = `mcp__${name}__`;
    const toolNames = Object.keys(toolsRecord)
      .map((toolName) =>
        toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName,
      )
      .sort((a, b) => a.localeCompare(b));
    lines.push(
      toolNames.length > 0
        ? `  tools: ${toolNames.join(", ")}`
        : "  tools: none",
    );

    const resources = Array.isArray(server.resources) ? server.resources.length : 0;
    const templates = Array.isArray(server.resourceTemplates)
      ? server.resourceTemplates.length
      : Array.isArray(server.resource_templates)
        ? server.resource_templates.length
        : 0;
    if (resources > 0 || templates > 0) {
      lines.push(`  resources: ${resources}, templates: ${templates}`);
    }
  }

  return lines;
}

export function buildAppsLines(data: Array<Record<string, unknown>>): string[] {
  const lines: string[] = ["Apps:"];
  if (data.length === 0) {
    lines.push("- No apps available.");
    return lines;
  }

  const apps = [...data].sort((a, b) =>
    String(a.name ?? "").localeCompare(String(b.name ?? "")),
  );
  for (const app of apps) {
    const name = String(app.name ?? app.id ?? "unknown");
    const appId = String(app.id ?? "");
    const isAccessible = Boolean(app.isAccessible ?? app.is_accessible ?? false);
    const status = isAccessible ? "connected" : "can be installed";
    const description =
      typeof app.description === "string" && app.description.trim().length > 0
        ? app.description.trim()
        : "";
    lines.push(
      `- ${name}${appId ? ` (${appId})` : ""} — ${status}${description ? `: ${description}` : ""}`,
    );

    const installUrl =
      typeof app.installUrl === "string"
        ? app.installUrl
        : typeof app.install_url === "string"
          ? app.install_url
          : "";
    if (!isAccessible && installUrl) {
      lines.push(`  install: ${installUrl}`);
    }
  }

  return lines;
}
