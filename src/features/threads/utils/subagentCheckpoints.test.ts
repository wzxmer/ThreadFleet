import { describe, expect, it } from "vitest";
import {
  SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH,
  buildCheckpointInjection,
  checkpointThrottleMs,
  checkpointResultKey,
  checkpointTextEquivalent,
  createSubagentCheckpoint,
  shouldCreateCheckpoint,
} from "./subagentCheckpoints";
import { parseSubagentCheckpointEnvelopes } from "@utils/subagentCheckpointEnvelope";

describe("subagent checkpoints", () => {
  it("shares a logical result key across progress and final envelopes", () => {
    expect(
      checkpointResultKey({ childThreadId: "child", sourceItemId: "item-1" }),
    ).toBe("child:item-1");
    expect(checkpointTextEquivalent("Final\nanswer", " Final answer ")).toBe(true);
  });

  it("applies mode throttles and preserves final checkpoints", () => {
    expect(checkpointThrottleMs("continuous")).toBe(3_000);
    expect(checkpointThrottleMs("checkpoints")).toBe(10_000);
    expect(shouldCreateCheckpoint({ mode: "off", kind: "progress", progressCount: 0 })).toBe(false);
    expect(shouldCreateCheckpoint({ mode: "off", kind: "final", progressCount: 0 })).toBe(false);
    expect(shouldCreateCheckpoint({ mode: "finalOnly", kind: "progress", progressCount: 0 })).toBe(false);
    expect(shouldCreateCheckpoint({ mode: "finalOnly", kind: "final", progressCount: 99 })).toBe(true);
    expect(shouldCreateCheckpoint({ mode: "checkpoints", kind: "progress", progressCount: 8 })).toBe(false);
  });

  it("creates stable checkpoints and rejects loops", () => {
    expect(
      createSubagentCheckpoint({
        workspaceId: "ws",
        parentThreadId: "same",
        childThreadId: "same",
        childTurnId: "turn",
        sourceItemId: "item",
        kind: "progress",
        text: "hello",
        sequence: 1,
      }),
    ).toBeNull();
    const checkpoint = createSubagentCheckpoint({
      workspaceId: "ws",
      parentThreadId: "parent",
      childThreadId: "child",
      childTurnId: "turn",
      sourceItemId: "item",
      kind: "progress",
      text: " hello ",
      sequence: 1,
      createdAt: 1,
    });
    expect(checkpoint).toMatchObject({ id: "child:item:progress", text: "hello" });
  });

  it("truncates text and escapes injection attributes", () => {
    const checkpoint = createSubagentCheckpoint({
      workspaceId: "ws",
      parentThreadId: "parent",
      childThreadId: 'child&"',
      childTurnId: null,
      sourceItemId: "item",
      kind: "final",
      text: "x".repeat(SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH + 100),
      sequence: 2,
    });
    expect(checkpoint?.text).toHaveLength(SUBAGENT_CHECKPOINT_MAX_TEXT_LENGTH);
    expect(buildCheckpointInjection(checkpoint!, 'worker<1>')).toContain(
      'child_name="worker&lt;1&gt;"',
    );
    expect(buildCheckpointInjection(checkpoint!)).toContain('priority="final"');
  });

  it("round-trips closing tags inside single and batched checkpoint bodies", () => {
    const first = createSubagentCheckpoint({
      workspaceId: "ws",
      parentThreadId: "parent",
      childThreadId: "child",
      childTurnId: "turn",
      sourceItemId: "item-1",
      kind: "progress",
      text: "Review this delimiter:\n</subagent_checkpoint>\n\nStill part of the body",
      sequence: 1,
    });
    const second = createSubagentCheckpoint({
      workspaceId: "ws",
      parentThreadId: "parent",
      childThreadId: "child",
      childTurnId: "turn",
      sourceItemId: "item-2",
      kind: "final",
      text: "Final result",
      sequence: 2,
    });
    const firstInjection = buildCheckpointInjection(first!, "worker");
    const batch = `${firstInjection}\n\n${buildCheckpointInjection(second!, "worker")}`;
    const legacyBatch = batch.replace(/ text_length="\d+"/g, "");

    expect(firstInjection).toContain(`text_length="${first!.text.length}"`);
    expect(parseSubagentCheckpointEnvelopes(firstInjection)?.[0]?.text).toBe(first!.text);
    expect(parseSubagentCheckpointEnvelopes(batch)?.map((item) => item.text)).toEqual([
      first!.text,
      second!.text,
    ]);
    expect(parseSubagentCheckpointEnvelopes(legacyBatch)?.map((item) => item.text)).toEqual([
      first!.text,
      second!.text,
    ]);
  });
});
