import type {
  ComposerSubmission,
  ComposerSubmissionSource,
} from "@/types";

const DEFAULT_REGISTRY_CAPACITY = 256;

export type SubmissionIdRegistry = {
  ids: Set<string>;
  order: string[];
};

export function createSubmissionIdRegistry(): SubmissionIdRegistry {
  return { ids: new Set<string>(), order: [] };
}

export function claimSubmissionId(
  registry: SubmissionIdRegistry,
  submissionId: string,
  capacity = DEFAULT_REGISTRY_CAPACITY,
): boolean {
  if (registry.ids.has(submissionId)) {
    return false;
  }
  registry.ids.add(submissionId);
  registry.order.push(submissionId);
  while (registry.order.length > capacity) {
    const expiredId = registry.order.shift();
    if (expiredId) {
      registry.ids.delete(expiredId);
    }
  }
  return true;
}

export function createComposerSubmission(
  source: ComposerSubmissionSource,
  draftGeneration: number,
): ComposerSubmission {
  const uniquePart =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id: `composer-${uniquePart}`,
    source,
    draftGeneration,
  };
}
