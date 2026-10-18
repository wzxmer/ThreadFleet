import type {
  CodexProviderKind,
  SkillOption,
  WorkflowAgentOption,
  WorkflowCapabilityName,
  WorkflowContextCompilation,
  WorkflowHostPreflightPreview,
  WorkflowPreflightPreview,
} from "@/types";
import { matchesWorkflowTrigger } from "./workflowTriggerMatching";

const MAX_CONTEXT_CHARS = 48_000;
const MAX_ENTRY_CHARS = 12_000;

function normalized(value: string) {
  return value.trim().toLocaleLowerCase();
}

function modelMatches(patterns: string[] | undefined, model: string | null) {
  if (!patterns?.length || !model) {
    return false;
  }
  const normalizedModel = normalized(model);
  return patterns.some((pattern) =>
    normalizedModel.includes(normalized(pattern)),
  );
}

function agentApplies(
  agent: WorkflowAgentOption,
  providerKind: CodexProviderKind,
  model: string | null,
) {
  if (agent.scope === "provider") {
    return agent.providerKinds?.includes(providerKind) ?? false;
  }
  if (agent.scope === "model") {
    return modelMatches(agent.modelPatterns, model);
  }
  return true;
}

function agentTriggered(task: string, agent: WorkflowAgentOption) {
  const name = normalized(agent.name);
  if (
    matchesWorkflowTrigger(task, `$${name}`) ||
    matchesWorkflowTrigger(task, `@${name}`) ||
    matchesWorkflowTrigger(task, `/agent ${name}`)
  ) {
    return true;
  }
  return (
    agent.triggerKeywords?.some((keyword) =>
      matchesWorkflowTrigger(task, keyword),
    ) ?? false
  );
}

function missingCapabilities(
  requirements: WorkflowCapabilityName[] | undefined,
  preview: WorkflowPreflightPreview,
) {
  return (requirements ?? []).filter(
    (capability) => preview.capabilities[capability] !== "supported",
  );
}

function addContextEntry(
  compilation: WorkflowContextCompilation,
  sourceId: string,
  kind: "application" | "untrusted",
  value: string,
  usedChars: { value: number },
  seenContent: Set<string>,
) {
  const normalizedContent = value.replace(/\r\n/g, "\n").trim();
  if (!normalizedContent) {
    compilation.omittedSources.push({ sourceId, reason: "empty" });
    return false;
  }
  if (sourceId in compilation.additionalContext) {
    compilation.omittedSources.push({ sourceId, reason: "duplicate_source" });
    return false;
  }
  if (seenContent.has(normalizedContent)) {
    compilation.omittedSources.push({ sourceId, reason: "duplicate_content" });
    return false;
  }
  if (usedChars.value >= MAX_CONTEXT_CHARS) {
    compilation.omittedSources.push({ sourceId, reason: "budget" });
    return false;
  }
  const remaining = MAX_CONTEXT_CHARS - usedChars.value;
  const limited = [...value]
    .slice(0, Math.min(remaining, MAX_ENTRY_CHARS))
    .join("");
  if (!limited) {
    compilation.omittedSources.push({ sourceId, reason: "budget" });
    return false;
  }
  compilation.additionalContext[sourceId] = { kind, value: limited };
  usedChars.value += [...limited].length;
  seenContent.add(normalizedContent);
  if ([...limited].length < [...value].length) {
    compilation.truncatedSources.push(sourceId);
  }
  return true;
}

export function compileWorkflowAdditionalContext({
  task,
  preview,
  hostPreview,
  skills,
  agents,
}: {
  task: string;
  preview: WorkflowPreflightPreview;
  hostPreview: WorkflowHostPreflightPreview | null;
  skills: SkillOption[];
  agents: WorkflowAgentOption[];
}): WorkflowContextCompilation {
  const compilation: WorkflowContextCompilation = {
    additionalContext: {},
    selectedAgents: [],
    includedSkills: [],
    blockedSkills: [],
    omittedSources: [],
    truncatedSources: [],
    contextSummary: "",
  };
  const usedChars = { value: 0 };
  const seenContent = new Set<string>();
  hostPreview?.contextFragments.forEach((fragment) => {
    addContextEntry(
      compilation,
      fragment.sourceId,
      fragment.kind,
      fragment.value,
      usedChars,
      seenContent,
    );
  });

  const skillsByName = new Map(
    skills.map((skill) => [normalized(skill.name), skill] as const),
  );
  preview.triggeredSkills.forEach((trigger, index) => {
    // Keyword matches are discovery hints. Only explicit requests inject a skill body.
    if (trigger.reason !== "explicit") {
      return;
    }
    const skill = skillsByName.get(normalized(trigger.skillName));
    if (!skill || trigger.compatibility === "blocked") {
      compilation.blockedSkills.push(trigger.skillName);
      return;
    }
    const instructions =
      trigger.compatibility === "fallback"
        ? trigger.fallback
        : skill.instructions;
    if (!instructions) {
      compilation.blockedSkills.push(trigger.skillName);
      return;
    }
    const included = addContextEntry(
      compilation,
      `cm.skill.${index}`,
      skill.trustLevel === "untrusted" ? "untrusted" : "application",
      `CM skill: ${skill.name}\nSource: ${skill.path}\n${instructions}`,
      usedChars,
      seenContent,
    );
    if (included) {
      compilation.includedSkills.push(trigger.skillName);
    }
  });

  const normalizedTask = normalized(task);
  agents
    .filter((agent) => agentApplies(agent, preview.providerKind, preview.model))
    .filter((agent) => agentTriggered(normalizedTask, agent))
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .forEach((agent, index) => {
      const missing = missingCapabilities(
        agent.capabilityRequirements,
        preview,
      );
      const instructions =
        missing.length > 0 ? agent.fallback : agent.developerInstructions;
      if (!instructions) {
        return;
      }
      const included = addContextEntry(
        compilation,
        `cm.agent.${index}`,
        agent.trustLevel === "untrusted" ? "untrusted" : "application",
        `CM agent: ${agent.name}\nSource: ${agent.path}\n${instructions}`,
        usedChars,
        seenContent,
      );
      if (included) {
        compilation.selectedAgents.push(agent.name);
      }
    });

  compilation.contextSummary = [
    `host:${hostPreview?.contextFragments.length ?? 0}`,
    `skills:${compilation.includedSkills.join(",") || "none"}`,
    `agents:${compilation.selectedAgents.join(",") || "none"}`,
    `blocked:${compilation.blockedSkills.join(",") || "none"}`,
    `omitted:${compilation.omittedSources.length}`,
    `truncated:${compilation.truncatedSources.length}`,
  ].join("; ");
  return compilation;
}
