import { describe, expect, it } from "vitest";
import type { WorkflowHostPreflightPreview, WorkflowPreflightPreview } from "@/types";
import { compileWorkflowAdditionalContext } from "./workflowContext";

const preview: WorkflowPreflightPreview = {
  mode: "shadow",
  providerKind: "opencode",
  model: "test-model",
  taskLength: 12,
  capabilities: {
    tool_calling: "unknown",
    structured_output: "unknown",
    parallel_tools: "unknown",
    streaming: "supported",
    vision: "unknown",
    long_context: "unknown",
    file_access: "supported",
    shell_access: "supported",
  },
  triggeredSkills: [{
    skillName: "diagnose",
    scope: "public",
    reason: "keyword",
    matchedValue: "排查",
    compatibility: "compatible",
    missingCapabilities: [],
    fallback: null,
    priority: 10,
  }],
  triggerSummary: "diagnose",
  fallbackSummary: "",
  validationSuggestions: [],
  validationSummary: "",
};

const hostPreview: WorkflowHostPreflightPreview = {
  mode: "shadow",
  providerKind: "opencode",
  model: "test-model",
  taskLength: 12,
  rules: [],
  knowledgeCandidates: [],
  impacts: [],
  impactSummary: "capability-runtime",
  validationSuggestions: [],
  sourceErrors: [],
  knowledgeCacheHit: false,
  contextFragments: [
    { sourceId: "cm.rule.0", kind: "application", value: "project rules" },
    {
      sourceId: "cm.workflow.completion",
      kind: "application",
      value: "run validation and review changed diff",
    },
  ],
  completionPlan: {
    required: true,
    phase: "focused_validation",
    validations: [{
      id: "validation-1",
      kind: "command",
      instruction: "npm run typecheck",
      status: "pending",
      sourceAreas: ["project-baseline"],
    }],
    changedDiffReview: {
      required: true,
      status: "pending",
      scope: "task-owned-changed-diff",
    },
    knowledgeCapture: {
      status: "evaluate",
      category: "checkpoint",
      reason: "validated reusable conclusions only",
      submissionMode: "candidate-only-concurrency-safe",
    },
  },
};

describe("workflow context compilation", () => {
  it("combines host, public skill, and explicit agent context for OpenCode", () => {
    const result = compileWorkflowAdditionalContext({
      task: "排查失败 @reviewer",
      preview,
      hostPreview,
      skills: [{
        name: "diagnose",
        path: "/skills/diagnose",
        instructions: "diagnose systematically",
      }],
      agents: [{
        name: "reviewer",
        path: "/agents/reviewer.toml",
        developerInstructions: "review the changed diff",
      }],
    });

    expect(result.additionalContext["cm.rule.0"]?.value).toBe("project rules");
    expect(result.additionalContext["cm.workflow.completion"]?.value).toContain(
      "review changed diff",
    );
    expect(result.additionalContext["cm.skill.0"]?.value).toContain("diagnose systematically");
    expect(result.additionalContext["cm.agent.0"]?.value).toContain("review the changed diff");
    expect(result.includedSkills).toEqual(["diagnose"]);
    expect(result.selectedAgents).toEqual(["reviewer"]);
  });

  it("uses fallback instead of unsupported agent instructions", () => {
    const result = compileWorkflowAdditionalContext({
      task: "@vision-agent inspect",
      preview,
      hostPreview: null,
      skills: [],
      agents: [{
        name: "vision-agent",
        path: "/agents/vision.toml",
        capabilityRequirements: ["vision"],
        fallback: "use DOM assertions",
        developerInstructions: "inspect pixels",
      }],
    });

    expect(result.additionalContext["cm.agent.0"]?.value).toContain("use DOM assertions");
    expect(result.additionalContext["cm.agent.0"]?.value).not.toContain("inspect pixels");
  });

  it("deduplicates host content and reports the omitted source", () => {
    const result = compileWorkflowAdditionalContext({
      task: "inspect context",
      preview: { ...preview, triggeredSkills: [] },
      hostPreview: {
        ...hostPreview,
        contextFragments: [
          { sourceId: "cm.rule.0", kind: "application", value: "same rules\r\n" },
          { sourceId: "cm.rule.1", kind: "application", value: "same rules\n" },
        ],
      },
      skills: [],
      agents: [],
    });

    expect(Object.keys(result.additionalContext)).toEqual(["cm.rule.0"]);
    expect(result.omittedSources).toEqual([
      { sourceId: "cm.rule.1", reason: "duplicate_content" },
    ]);
    expect(result.contextSummary).toContain("omitted:1");
  });

  it("does not claim a skill was included when the context budget is exhausted", () => {
    const result = compileWorkflowAdditionalContext({
      task: "debug",
      preview,
      hostPreview: {
        ...hostPreview,
        contextFragments: Array.from({ length: 4 }, (_, index) => ({
          sourceId: `cm.host.${index}`,
          kind: "application" as const,
          value: String(index).repeat(12_000),
        })),
      },
      skills: [{
        name: "diagnose",
        path: "/skills/diagnose",
        instructions: "diagnose systematically",
      }],
      agents: [],
    });

    expect(result.includedSkills).toEqual([]);
    expect(result.additionalContext["cm.skill.0"]).toBeUndefined();
    expect(result.omittedSources).toContainEqual({
      sourceId: "cm.skill.0",
      reason: "budget",
    });
  });
});
