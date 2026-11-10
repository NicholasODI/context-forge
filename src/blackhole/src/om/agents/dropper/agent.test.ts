import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { runDropper } from "./agent";

const model: any = { provider: "mock", id: "local", api: "openai-completions", contextWindow: 131072, maxTokens: 8192, reasoning: false };
const observation: any = { id: "000000000001", content: "Preserve source evidence. ".repeat(20), relevance: "high", timestamp: "2026-11-10 00:00", sourceEntryIds: ["source"], tokenCount: 100 };
const reflection = { id: "000000000002", content: observation.content, supportingObservationIds: [observation.id], tokenCount: 100 };
const proposal = (complete?: boolean) => ({ ids: [observation.id], replacements: { [observation.id]: [reflection.id] }, reason: "The reflection preserves this fact", ...(complete !== undefined ? { complete } : {}) });
function message(batch?: unknown, stopReason = batch ? "toolUse" : "stop") {
  return { role: "assistant", content: batch ? [{ type: "toolCall", id: "call", name: "drop_observations", arguments: batch }] : [],
    stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as any;
}
function response(batch?: unknown) {
  const stream = createAssistantMessageEventStream(), msg = message(batch);
  stream.push({ type: "done", reason: msg.stopReason, message: msg }); stream.end(msg);
  return stream;
}
const args = (streamFn: any) => ({ model, apiKey: "", observations: [observation], reflections: [reflection], budgetTokens: 50, targetTokens: 25, maxTurns: 4, streamFn });

describe("dropper explicit completion", () => {
  it("ends after one valid completed tool call, including at a one-turn cap", async () => {
    const stream = vi.fn(() => response(proposal(true)));
    const result = await runDropper({ ...args(stream), maxTurns: 1 });
    expect([...result!]).toEqual([observation.id]);
    expect(result?.proofs?.[observation.id].reflectionIds).toEqual([reflection.id]);
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("ends a completed no-safe-drops evaluation without another provider request", async () => {
    const stream = vi.fn(() => response({ ids: [], replacements: {}, reason: "Keep all candidates", complete: true }));
    expect(await runDropper(args(stream))).toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("allows partial proposals followed by an explicit empty close", async () => {
    let calls = 0;
    const stream = vi.fn(() => response(calls++ === 0 ? proposal(false) : { ids: [], replacements: {}, reason: "Evaluation finished", complete: true }));
    expect([...(await runDropper(args(stream)))!]).toEqual([observation.id]);
    expect(stream).toHaveBeenCalledTimes(2);
  });
  it.each(["pinned", "critical", "bad-reference"])("does not authorize a completion containing a %s proposal", async kind => {
    let calls = 0;
    const protectedObservation = { ...observation, id: "000000000003", ...(kind === "pinned" ? { pinned: true } : { relevance: "critical" }) };
    const batch = kind === "bad-reference" ? { ...proposal(true), replacements: { [observation.id]: ["missing-reflection"] } } : {
      ids: [protectedObservation.id], replacements: { [protectedObservation.id]: [reflection.id] }, reason: "Unsafe proposed drop", complete: true,
    };
    const stream = vi.fn(() => response(calls++ === 0 ? batch : undefined));
    expect(await runDropper({ ...args(stream), observations: [observation, protectedObservation] })).toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(2); // rejected batch cannot terminate the run
  });
  it.each(["toolUse", "error", "length", "aborted"])("still rejects an unsafe terminal %s outcome", async reason => {
    // Reproduce host endings directly, including an error after a valid close.
    const loop: any = (_prompts: unknown, context: any) => {
      const iterator = (async function* () {
        await context.tools[0].execute("call", proposal(reason === "toolUse" ? false : true));
        yield { type: "agent_end", messages: [message(undefined, reason)] };
      })();
      return Object.assign(iterator, { result: async () => [] });
    };
    await expect(runDropper({ ...args(vi.fn()), agentLoop: loop })).rejects.toThrow(reason === "toolUse" ? "Incomplete agent response (toolUse)" : reason === "error" ? "Unknown API error" : reason);
  });
});
