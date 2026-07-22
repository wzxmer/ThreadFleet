import type {
  CodexProviderKind,
  SkillOption,
  WorkflowCapabilityName,
  WorkflowCapabilityProfile,
  WorkflowPreflightPreview,
  WorkflowRuntimeMode,
  WorkflowSkillTrigger,
} from "@/types";

type BuiltinSkillRule = {
  keywords: string[];
  capabilityRequirements?: WorkflowCapabilityName[];
  fallback?: string;
};

const BUILTIN_SKILL_RULES: Record<string, BuiltinSkillRule> = {
  "app-ui-design": {
    keywords: ["desktop ui", "tauri", "electron", "桌面", "客户端", "窗口", "界面美化"],
  },
  brainstorming: {
    keywords: ["brainstorm", "方案设计", "架构方案", "思考方案", "讨论方案"],
  },
  "code-review": {
    keywords: ["code review", "review diff", "审查代码", "检查改动", "复盘检查", "代码审查"],
  },
  diagnose: {
    keywords: ["diagnose", "debug", "诊断", "调试", "排查"],
  },
  "frontend-design": {
    keywords: ["frontend ui", "web ui", "react ui", "vue ui", "网页", "前端", "css"],
  },
  "ui-regression-guardian": {
    keywords: ["ui regression", "样式回归", "视觉回归", "主题冲突", "hover", "focus", "selected"],
  },
  "visual-qa-loop": {
    keywords: ["visual qa", "截图验证", "视觉验证", "界面测试"],
    capabilityRequirements: ["vision"],
    fallback: "Use DOM assertions and request manual screenshot verification.",
  },
  "writing-plans": {
    keywords: ["implementation plan", "execution plan", "实施方案", "执行方案", "制定方案", "落地方案"],
  },
};

const KNOWN_PROVIDER_CAPABILITIES: Record<
  Exclude<CodexProviderKind, "custom">,
  Partial<WorkflowCapabilityProfile>
> = {
  openai: {
    tool_calling: "supported",
    structured_output: "supported",
    parallel_tools: "supported",
    vision: "unknown",
  },
  deepseek: {
    tool_calling: "unknown",
    structured_output: "supported",
    parallel_tools: "unknown",
    vision: "unknown",
  },
  openrouter: {
    tool_calling: "unknown",
    structured_output: "supported",
    parallel_tools: "unknown",
    vision: "unknown",
  },
  opencode: {
    tool_calling: "unknown",
    structured_output: "supported",
    parallel_tools: "unknown",
    vision: "unknown",
  },
};

function normalized(value: string) {
  return value.trim().toLocaleLowerCase();
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function includesPhrase(task: string, phrase: string) {
  return task.includes(normalized(phrase));
}

function explicitSkillMatch(task: string, skillName: string) {
  const name = normalized(skillName);
  return [`$${name}`, `/skill ${name}`, `/skills ${name}`].find((value) =>
    task.includes(value),
  );
}

function matchingModelOverride(skill: SkillOption, model: string | null) {
  if (!model || !skill.modelOverrides) {
    return null;
  }
  const normalizedModel = normalized(model);
  return (
    Object.entries(skill.modelOverrides).find(([pattern]) =>
      normalizedModel.includes(normalized(pattern)),
    )?.[1] ?? null
  );
}

function skillMatchesScope(
  skill: SkillOption,
  providerKind: CodexProviderKind,
  model: string | null,
) {
  const scope = skill.scope ?? "public";
  if (scope === "public") {
    return true;
  }
  if (scope === "provider") {
    return (
      skill.providerKinds?.includes(providerKind) ??
      Boolean(skill.providerOverrides?.[providerKind])
    );
  }
  if (!model) {
    return false;
  }
  const normalizedModel = normalized(model);
  const patterns = [
    ...(skill.modelPatterns ?? []),
    ...Object.keys(skill.modelOverrides ?? {}),
  ];
  return patterns.some((pattern) => normalizedModel.includes(normalized(pattern)));
}

export function resolveWorkflowCapabilityProfile(
  providerKind: CodexProviderKind,
): WorkflowCapabilityProfile {
  const base: WorkflowCapabilityProfile = {
    tool_calling: "unknown",
    structured_output: "unknown",
    parallel_tools: "unknown",
    streaming: "supported",
    vision: "unknown",
    long_context: "unknown",
    file_access: "supported",
    shell_access: "supported",
  };
  return {
    ...base,
    ...(providerKind === "custom" ? {} : KNOWN_PROVIDER_CAPABILITIES[providerKind]),
  };
}

function resolveTrigger(
  task: string,
  skill: SkillOption,
): Pick<WorkflowSkillTrigger, "reason" | "matchedValue"> | null {
  const explicit = explicitSkillMatch(task, skill.name);
  if (explicit) {
    return { reason: "explicit", matchedValue: explicit };
  }
  const builtin = BUILTIN_SKILL_RULES[normalized(skill.name)];
  const keyword = [...(skill.triggerKeywords ?? []), ...(builtin?.keywords ?? [])].find(
    (value) => includesPhrase(task, value),
  );
  if (keyword) {
    return { reason: "keyword", matchedValue: keyword };
  }
  return null;
}

function buildSkillTrigger({
  task,
  skill,
  providerKind,
  model,
  capabilities,
}: {
  task: string;
  skill: SkillOption;
  providerKind: CodexProviderKind;
  model: string | null;
  capabilities: WorkflowCapabilityProfile;
}): WorkflowSkillTrigger | null {
  if (!skillMatchesScope(skill, providerKind, model)) {
    return null;
  }
  const trigger = resolveTrigger(task, skill);
  if (!trigger) {
    return null;
  }
  const builtin = BUILTIN_SKILL_RULES[normalized(skill.name)];
  const providerOverride = skill.providerOverrides?.[providerKind] ?? null;
  const modelOverride = matchingModelOverride(skill, model);
  const capabilityRequirements = unique([
    ...(skill.capabilityRequirements ?? builtin?.capabilityRequirements ?? []),
    ...(providerOverride?.capabilityRequirements ?? []),
    ...(modelOverride?.capabilityRequirements ?? []),
  ]);
  const missingCapabilities = capabilityRequirements.filter(
    (capability) => capabilities[capability] !== "supported",
  );
  const fallback =
    modelOverride?.fallback ??
    providerOverride?.fallback ??
    skill.fallback ??
    builtin?.fallback ??
    null;
  return {
    skillName: skill.name,
    scope: skill.scope ?? "public",
    ...trigger,
    compatibility:
      missingCapabilities.length === 0
        ? "compatible"
        : fallback
          ? "fallback"
          : "blocked",
    missingCapabilities,
    fallback,
    priority: skill.priority ?? 0,
  };
}

function validationSuggestions(task: string) {
  const suggestions = ["npm run typecheck"];
  if (/\b(test|react|typescript|frontend|ui)\b|测试|前端|界面|组件/u.test(task)) {
    suggestions.push("npm run test");
  }
  if (/\b(rust|tauri|daemon|backend)\b|后端|守护进程/u.test(task)) {
    suggestions.push("cd src-tauri && cargo check");
  }
  return suggestions;
}

export function buildWorkflowPreflightPreview({
  task,
  skills,
  providerKind,
  model,
  mode = "active",
}: {
  task: string;
  skills: SkillOption[];
  providerKind: CodexProviderKind;
  model: string | null;
  mode?: Exclude<WorkflowRuntimeMode, "off">;
}): WorkflowPreflightPreview {
  const normalizedTask = normalized(task);
  const capabilities = resolveWorkflowCapabilityProfile(providerKind);
  const triggeredByName = new Map<string, WorkflowSkillTrigger>();
  skills.forEach((skill) => {
    const trigger = buildSkillTrigger({
      task: normalizedTask,
      skill,
      providerKind,
      model,
      capabilities,
    });
    if (!trigger) {
      return;
    }
    const key = normalized(trigger.skillName);
    const current = triggeredByName.get(key);
    if (!current || trigger.priority > current.priority) {
      triggeredByName.set(key, trigger);
    }
  });
  const triggeredSkills = [...triggeredByName.values()].sort(
    (left, right) => right.priority - left.priority || left.skillName.localeCompare(right.skillName),
  );
  const suggestions = validationSuggestions(normalizedTask);
  return {
    mode,
    providerKind,
    model,
    taskLength: task.length,
    capabilities,
    triggeredSkills,
    triggerSummary: triggeredSkills.map((skill) => skill.skillName).join(", "),
    fallbackSummary: triggeredSkills
      .filter((skill) => skill.compatibility !== "compatible")
      .map((skill) => `${skill.skillName}:${skill.compatibility}`)
      .join(", "),
    validationSuggestions: suggestions,
    validationSummary: suggestions.join(", "),
  };
}
