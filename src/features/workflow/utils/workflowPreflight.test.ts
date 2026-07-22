import { describe, expect, it } from "vitest";
import type { SkillOption } from "@/types";
import {
  buildWorkflowPreflightPreview,
  resolveWorkflowCapabilityProfile,
} from "./workflowPreflight";

const publicSkills: SkillOption[] = [
  { name: "diagnose", path: "/skills/diagnose" },
  { name: "writing-plans", path: "/skills/writing-plans" },
  { name: "visual-qa-loop", path: "/skills/visual-qa-loop" },
];

describe("workflow preflight", () => {
  it("triggers the same public skills for Codex and OpenCode providers", () => {
    const task = "排查这个失败，并制定执行方案";
    const codex = buildWorkflowPreflightPreview({
      task,
      skills: publicSkills,
      providerKind: "openai",
      model: "gpt-5-codex",
    });
    const opencode = buildWorkflowPreflightPreview({
      task,
      skills: publicSkills,
      providerKind: "opencode",
      model: "minimax-m3",
    });

    expect(codex.triggeredSkills.map((skill) => skill.skillName)).toEqual([
      "diagnose",
      "writing-plans",
    ]);
    expect(opencode.triggeredSkills.map((skill) => skill.skillName)).toEqual(
      codex.triggeredSkills.map((skill) => skill.skillName),
    );
    expect(opencode.triggerSummary).toBe("diagnose, writing-plans");
  });

  it("uses a provider override fallback without suppressing the trigger", () => {
    const preview = buildWorkflowPreflightPreview({
      task: "$visual-qa-loop 检查界面",
      skills: [
        {
          name: "visual-qa-loop",
          path: "/skills/visual-qa-loop",
          capabilityRequirements: ["vision"],
          providerOverrides: {
            opencode: { fallback: "Use DOM assertions." },
          },
        },
      ],
      providerKind: "opencode",
      model: "text-only-model",
    });

    expect(preview.triggeredSkills[0]).toMatchObject({
      skillName: "visual-qa-loop",
      compatibility: "fallback",
      missingCapabilities: ["vision"],
      fallback: "Use DOM assertions.",
    });
  });

  it("marks unmet capabilities as blocked when no fallback exists", () => {
    const preview = buildWorkflowPreflightPreview({
      task: "/skill custom-tool",
      skills: [
        {
          name: "custom-tool",
          path: "/skills/custom-tool",
          capabilityRequirements: ["vision"],
        },
      ],
      providerKind: "custom",
      model: "unknown",
    });

    expect(preview.triggeredSkills[0]?.compatibility).toBe("blocked");
  });

  it("keeps host file and shell capabilities independent from the model provider", () => {
    expect(resolveWorkflowCapabilityProfile("opencode")).toMatchObject({
      file_access: "supported",
      shell_access: "supported",
      tool_calling: "unknown",
    });
  });

  it("filters provider and model scoped skills without changing public triggers", () => {
    const preview = buildWorkflowPreflightPreview({
      task: "debug provider routing",
      skills: [
        { name: "diagnose", path: "/skills/diagnose" },
        {
          name: "opencode-check",
          path: "/skills/opencode-check",
          scope: "provider",
          providerKinds: ["opencode"],
          triggerKeywords: ["provider"],
        },
        {
          name: "gpt-check",
          path: "/skills/gpt-check",
          scope: "model",
          modelPatterns: ["gpt"],
          triggerKeywords: ["provider"],
        },
      ],
      providerKind: "opencode",
      model: "minimax-m3",
    });

    expect(preview.triggeredSkills.map((skill) => skill.skillName)).toEqual([
      "diagnose",
      "opencode-check",
    ]);
  });

  it("deduplicates repeated skill entries by normalized name", () => {
    const preview = buildWorkflowPreflightPreview({
      task: "debug this failure",
      skills: [
        { name: "diagnose", path: "/global/diagnose" },
        { name: "Diagnose", path: "/project/diagnose", priority: 10 },
      ],
      providerKind: "openai",
      model: "gpt-5",
    });

    expect(preview.triggeredSkills).toHaveLength(1);
    expect(preview.triggeredSkills[0]).toMatchObject({
      skillName: "Diagnose",
      priority: 10,
    });
  });

  it("does not trigger diagnose for generic BUG discussion or description overlap", () => {
    const preview = buildWorkflowPreflightPreview({
      task: "讨论当前 BUG 和知识机制是否需要优化",
      skills: [{
        name: "diagnose",
        path: "/skills/diagnose",
        description: "Diagnose hard bugs and performance regressions",
      }],
      providerKind: "openai",
      model: "gpt-5",
    });

    expect(preview.triggeredSkills).toEqual([]);
  });
});
