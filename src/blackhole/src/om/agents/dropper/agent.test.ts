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
  it.each(["True", "true"])("accepts the observed local-model completion spelling %s in one request", async complete => {
    const stream = vi.fn(() => response({ ids: [], replacements: {}, reason: "Keep all candidates", complete }));
    expect(await runDropper(args(stream))).toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it.each(["False", "false"])("never treats %s as a truthy completion", async complete => {
    let calls = 0;
    const stream = vi.fn(() => response(calls++ === 0 ? { ...proposal(), complete } : { ids: [], replacements: {}, reason: "Finished", complete: "True" }));
    expect([...(await runDropper(args(stream)))!]).toEqual([observation.id]);
    expect(stream).toHaveBeenCalledTimes(2);
  });
  it("exposes authoritative replacement links and explains namespace rejections so the model can repair them", async () => {
    const contexts: string[] = [];
    const stream = vi.fn((_model, context) => {
      contexts.push(JSON.stringify(context));
      return response(contexts.length === 1 ? { ids: [reflection.id], replacements: {}, reason: "Wrong namespace", complete: "True" } : { ids: [], replacements: {}, reason: "Keep rejected entries", complete: "True" });
    });
    expect(await runDropper(args(stream))).toBeUndefined();
    expect(contexts[0]).toContain(`[allowed replacement refs: ${reflection.id}]`);
    expect(contexts[0]).toContain("[REFLECTION; replacement only, never a drop id]");
    expect(contexts[1]).toContain("not_candidate");
    expect(contexts[1]).toContain(reflection.id);
    expect(stream).toHaveBeenCalledTimes(2);
  });
  it("explains a mistyped replacement key without silently queueing a drop", async () => {
    let calls = 0;
    let feedback = "";
    const stream = vi.fn((_model, context) => {
      if (calls++) feedback = JSON.stringify(context);
      return response(calls === 1 ? { ...proposal(true), replacements: { mistyped_key: [reflection.id] } } : { ids: [], replacements: {}, reason: "Keep rejected entry", complete: true });
    });
    expect(await runDropper(args(stream))).toBeUndefined();
    expect(feedback).toContain("missing_replacements");
    expect(feedback).toContain("allowedReplacementIds");
  });
  it("stops two repeated rejected calls instead of consuming the full worker turn allowance", async () => {
    const stream = vi.fn(() => response({ ids: [reflection.id], replacements: {}, reason: "Repeated wrong namespace", complete: "True" }));
    await expect(runDropper({ ...args(stream), maxTurns: 16 })).rejects.toThrow("no progress in two consecutive tool calls");
    expect(stream).toHaveBeenCalledTimes(2);
  });
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
