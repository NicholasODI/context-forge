import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Runtime } from "./runtime";
import { registerMemoryCommand } from "../commands/memory";
import { runDropper } from "./agents/dropper/agent";
import { runObserver } from "./agents/observer/agent";
import { anyStageDue, makeModelResolver, runObserverStage, runReflectorStage, runDropperStage } from "./consolidation";
import { serializeConversation } from "./serialize";
import { workerInputBudget, workerOutputAllowance, workerStaticPromptTokens, WORKER_TURN_HEADROOM_TOKENS } from "./prompt-budget";

const sandbox = vi.hoisted(() => ({ root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async original => ({
  ...await original<object>(), getAgentDir: () => sandbox.root,
}));
beforeEach(async () => { sandbox.root = await mkdtemp(join(tmpdir(), "forge-pipeline-test-")); });
afterEach(async () => { await rm(sandbox.root, { recursive: true, force: true }); });
const model = { provider: "mock", id: "local", api: "openai-completions", contextWindow: 131072, maxTokens: 32768, reasoning: false } as any;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const observation = { content: "Preserve the evidence", relevance: "high", sourceEntryIds: ["e1"] };

function response(batch?: unknown, error?: string, toolName = "record_observations") {
  const message = { role: "assistant", content: batch ? [{ type: "toolCall", id: "call", name: toolName, arguments: batch }] : [],
    api: model.api, provider: model.provider, model: model.id, usage, timestamp: 1,
    stopReason: error ? "error" : batch ? "toolUse" : "stop", ...(error ? { errorMessage: error } : {}) } as any;
  const stream = createAssistantMessageEventStream();
  stream.push(error ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message });
  stream.end(message);
  return stream;
}
function observerArgs(streamFn: Function) {
  return { model, apiKey: "", priorReflections: [], priorObservations: [], chunk: "[Source entry id: e1] Preserve evidence", allowedSourceEntryIds: ["e1", "e2"], maxTurns: 4, streamFn: streamFn as any };
}
function stage(reflector = false) {
  const entries: any[] = [{ type: "message", id: "e1", message: { role: "user", content: "Preserve important facts", timestamp: 1 } }];
  if (reflector) entries.push({ type: "custom", id: "obs", customType: "om.observations.recorded", data: {
    coversUpToId: "e1", observations: [{ ...observation, id: "000000000001", timestamp: "2026-01-01 00:00", tokenCount: 8 }],
  } });
  const runtime = new Runtime();
  runtime.config = { ...runtime.config, observeAfterTokens: reflector ? 1e9 : 1, reflectAfterTokens: 1 };
  runtime.startSession("synthetic");
  const stream = vi.fn(() => response());
  const ctx: any = { cwd: sandbox.root, hasUI: false, model, ui: { notify: vi.fn() },
    modelRegistry: { hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "" }), streamSimple: stream },
    sessionManager: { getBranch: () => entries, getSessionId: () => "synthetic" } };
  const generation = runtime.captureGeneration("synthetic");
  const pi: any = { appendEntry: vi.fn() };
  return { runtime, ctx, generation, stream, entries, pi, resolve: makeModelResolver(runtime, ctx, generation) };
}

describe("observer completion and bounded retries", () => {
  it("terminates a complete batch without another provider request", async () => {
    const stream = vi.fn(() => response({ complete: true, observations: [observation] }));
    const result = await runObserver(observerArgs(stream));
    expect(result.observations).toHaveLength(1);
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("accepts an explicit completed-empty review in one request", async () => {
    const stream = vi.fn(() => response({ complete: true, observations: [] }));
    expect((await runObserver(observerArgs(stream))).emptyReason?.kind).toBe("no_new_content");
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, { complete: false, observations: [] }, { complete: true, observations: [{ ...observation, sourceEntryIds: ["invented"] }] }])(
    "never advances source coverage for an incomplete protocol: %j", async batch => {
      const s = stage(); let calls = 0;
      s.ctx.modelRegistry.streamSimple = () => response(calls++ === 0 ? batch : undefined);
      expect(await runObserverStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve)).toBe("abort");
      expect(s.runtime.getCursor("observer")).toBeUndefined();
      expect(s.pi.appendEntry).not.toHaveBeenCalled();
      expect(calls).toBeLessThanOrEqual(2);
      expect(s.runtime.lastObserverError).toContain("did not complete coverage");
    },
  );
  it("keeps an honest cited prefix when a model stops after a partial batch", async () => {
    let calls = 0;
    const result = await runObserver(observerArgs(() => response(calls++ === 0 ? { complete: false, observations: [observation] } : undefined)));
    expect(result.partialCoverageId).toBe("e1");
    expect(result.observations).toHaveLength(1);
  });
  it("honors an empty final close after valid partials", async () => {
    let calls = 0;
    const result = await runObserver(observerArgs(() => response(calls++ === 0 ? { complete: false, observations: [observation] } : { complete: true, observations: [] })));
    expect(result.observations).toHaveLength(1);
    expect(result.partialCoverageId).toBeUndefined();
    expect(calls).toBe(2);
  });
  it("bounds identical transient session-model failures to two requests", async () => {
    const s = stage();
    s.stream.mockImplementation(() => response(undefined, "HTTP 503 unavailable"));
    await runObserverStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    expect(s.stream).toHaveBeenCalledTimes(2);
    expect(s.runtime.lastObserverError).toContain("HTTP 503 unavailable");
    expect(s.runtime.getCursor("observer")).toBeUndefined();
  });
  it("halves source chunks when a session model runs out of output budget", async () => {
    const s = stage();
    s.entries.push(...[2, 3, 4].map(i => ({ type: "message", id: `e${i}`, message: { role: "user", content: `Requirement ${i}`, timestamp: i } })));
    s.ctx.modelRegistry.streamSimple = (_m: unknown, context: any) => {
      const user = context.messages.findLast((m: any) => m.role === "user");
      const body = typeof user.content === "string" ? user.content : user.content.map((b: any) => b.text ?? "").join("\n");
      const ids = [...body.matchAll(/\[Source entry id: ([^\]]+)\]/g)].map(m => m[1]);
      if (ids.length > 1) {
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, timestamp: 1, stopReason: "length" } as any;
        stream.push({ type: "done", reason: "length", message }); stream.end(message); return stream;
      }
      return response({ complete: true, observations: [{ ...observation, sourceEntryIds: ids }] });
    };
    expect(await runObserverStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve)).toBe("continue");
    expect(s.runtime.getCursor("observer")?.entryId).toBe("e4");
    expect(s.pi.appendEntry).toHaveBeenCalledTimes(4);
  });
  it("shares configured output limits between preflight and dispatch", async () => {
    const s = stage(); s.runtime.config.workerOutputMaxTokens = 2048;
    await runObserverStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    const options = (s.stream.mock.calls as any)[0][2];
    expect(options.maxTokens).toBe(2048);
    expect(workerOutputAllowance(131072, model, 2048)).toBe(2048);
    expect(workerInputBudget(131072, model, 2048)).toBe(131072 - 2048 - 1024);
  });
  it("omits speculative thinking from worker input while preserving final text", () => {
    const text = serializeConversation([{ role: "assistant", timestamp: 1, content: [
      { type: "thinking", thinking: "Maybe the user wants to erase evidence" }, { type: "text", text: "Preserve all evidence" },
    ] }] as any);
    expect(text).toContain("Preserve all evidence");
    expect(text).not.toContain("erase evidence");
  });
});

it("persists validated replacement evidence when the dropper deactivates an observation", async () => {
  const s = stage(true);
  s.runtime.lastDropperError = "An older incomplete attempt";
  s.runtime.config.observationsPoolMaxTokens = 50;
  s.runtime.config.observationsPoolTargetTokens = 25;
  const item = s.entries[1].data.observations[0];
  item.content = "Preserve source evidence. ".repeat(15);
  s.entries.push({ type: "custom", id: "reflection-record", customType: "om.reflections.recorded", data: { coversUpToId: "e1", reflections: [
    { id: "000000000002", content: item.content.trim(), supportingObservationIds: [item.id], tokenCount: 100 },
  ] } });
  let calls = 0;
  s.ctx.modelRegistry.streamSimple = () => response(calls++ === 0 ? {
    complete: true, ids: [item.id], reason: "The provided reflection preserves the complete fact", replacements: { [item.id]: ["000000000002"] },
  } : undefined, undefined, "drop_observations");
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("continue");
  const [type, data] = s.pi.appendEntry.mock.calls[0];
  expect(type).toBe("om.observations.dropped");
  expect(data.proofs[item.id].reflectionIds).toEqual(["000000000002"]);
  expect(data.proofs[item.id].reason).toContain("preserves");
  expect(calls).toBe(1);
  expect(s.runtime.lastDropperError).toBeUndefined();
});

it("vetoes a drop whose claimed replacement does not cite the observation", async () => {
  const item = { ...observation, id: "000000000001", content: "Preserve all source evidence. ".repeat(15), timestamp: "2026-01-01 00:00", tokenCount: 100 } as any;
  let calls = 0;
  const result = await runDropper({ model, apiKey: "", observations: [item], budgetTokens: 50, targetTokens: 25,
    reflections: [
      { id: "000000000002", content: "A valid available replacement", supportingObservationIds: [item.id], tokenCount: 8 },
      { id: "000000000003", content: "An unrelated reflection", supportingObservationIds: ["unrelated"], tokenCount: 8 },
    ],
    streamFn: () => response(calls++ === 0 ? { ids: [item.id], reason: "The model claimed equivalence", replacements: { [item.id]: ["000000000003"] } } : undefined, undefined, "drop_observations"),
  });
  expect(result).toBeUndefined();
  expect(calls).toBe(2);
});

it("shows completed-empty review progress and the effective pruning target in status", async () => {
  const s = stage(true);
  await runReflectorStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
  vi.spyOn(s.runtime, "ensureConfig").mockImplementation(() => {});
  let handler: any;
  registerMemoryCommand({ registerCommand: (_name: string, definition: any) => { handler = definition.handler; } } as any, s.runtime);
  await handler("status", s.ctx);
  const text = s.ctx.ui.notify.mock.calls.at(-1)[0];
  expect(text).toContain("Reflector:      ~0 tokens");
  expect(text).toContain("eligible above target");
  expect(text).toContain("Drop eligibility: 0 citation-eligible");
  expect(text).toContain("1 uncovered");
  expect(s.stream).toHaveBeenCalledTimes(1); // status never launches another worker
});

describe("successful empty reflection review watermark", () => {
  it("does not rerun unchanged observations, including after cursor reload", async () => {
    const s = stage(true);
    await runReflectorStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    expect(anyStageDue(s.entries, s.runtime)).toBe(false);
    s.runtime.saveCursorsToPending("synthetic");
    const restored = new Runtime(); restored.config = s.runtime.config; restored.loadCursorsFromPending("synthetic");
    expect(anyStageDue(s.entries, restored)).toBe(false);
    await runReflectorStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    expect(s.stream).toHaveBeenCalledTimes(1);
    expect(s.runtime.getCursor("reflector")?.reviewSignature).toHaveLength(64);
  });
  it("rearms when new observation input arrives and is due", async () => {
    const s = stage(true);
    await runReflectorStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    s.entries.push({ type: "message", id: "e2", message: { role: "user", content: "A changed requirement", timestamp: 2 } },
      { type: "custom", id: "obs2", customType: "om.observations.recorded", data: { coversUpToId: "e2", observations: [{ ...observation, id: "000000000002", content: "Changed requirement", sourceEntryIds: ["e2"], timestamp: "2026-01-02 00:00", tokenCount: 8 }] } });
    expect(anyStageDue(s.entries, s.runtime)).toBe(true);
    await runReflectorStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    expect(s.stream).toHaveBeenCalledTimes(2);
  });
  it("does not trust a review cursor whose branch anchor disappeared", async () => {
    const s = stage(true);
    await runReflectorStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve);
    s.runtime.cursors.reflector!.entryId = "missing-after-fork";
    expect(anyStageDue(s.entries, s.runtime)).toBe(true);
  });
});

it("rearms an empty pressure review when a new replacement reflection becomes available", async () => {
  const s = stage(true);
  s.runtime.config = { ...s.runtime.config, observeAfterTokens: 1e9, reflectAfterTokens: 1e9, observationsPoolMaxTokens: 50, observationsPoolTargetTokens: 25 };
  const item = s.entries[1].data.observations[0];
  item.content = "Preserve source evidence. ".repeat(20);
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("continue");
  expect(s.stream).not.toHaveBeenCalled(); // no replacement evidence, no model request
  expect(anyStageDue(s.entries, s.runtime)).toBe(false);
  s.entries.push({ type: "custom", id: "new-replacement", customType: "om.reflections.recorded", data: { coversUpToId: "e1", reflections: [
    { id: "000000000002", content: item.content, supportingObservationIds: [item.id], tokenCount: 100 },
  ] } });
  expect(anyStageDue(s.entries, s.runtime)).toBe(true); // observation ids did not change
});

it("aborts repeated rejected dropper proposals without recording drops or advancing coverage", async () => {
  const s = stage(true);
  s.runtime.config = { ...s.runtime.config, observationsPoolMaxTokens: 50, observationsPoolTargetTokens: 25, agentMaxTurns: 16 };
  const item = s.entries[1].data.observations[0];
  item.content = "Preserve source evidence. ".repeat(20);
  s.entries.push({ type: "custom", id: "replacement", customType: "om.reflections.recorded", data: { coversUpToId: "e1", reflections: [
    { id: "000000000002", content: item.content, supportingObservationIds: [item.id], tokenCount: 100 },
  ] } });
  const stream = vi.fn(() => response({ ids: ["000000000002"], replacements: {}, reason: "Wrong ID namespace", complete: "True" }, undefined, "drop_observations"));
  s.ctx.modelRegistry.streamSimple = stream;
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("abort");
  expect(stream).toHaveBeenCalledTimes(2);
  expect(s.pi.appendEntry).not.toHaveBeenCalled();
  expect(s.runtime.getCursor("dropper")).toBeUndefined();
  expect(s.runtime.lastDropperError).toContain("no progress in two consecutive tool calls");
});

it("uses ledger replacement evidence even when it exceeds the main summary reflection cap", async () => {
  const s = stage(true);
  s.runtime.config = { ...s.runtime.config, observationsPoolMaxTokens: 50, observationsPoolTargetTokens: 25, reflectionsPoolMaxTokens: 1 };
  const item = s.entries[1].data.observations[0];
  item.content = "Preserve source evidence. ".repeat(20);
  s.entries.push({ type: "custom", id: "replacement", customType: "om.reflections.recorded", data: { coversUpToId: "e1", reflections: [
    { id: "000000000002", content: item.content, supportingObservationIds: [item.id], tokenCount: 100 },
  ] } });
  const stream = vi.fn((_model, context) => {
    expect(JSON.stringify(context)).toContain("000000000002] [REFLECTION");
    return response({ ids: [item.id], replacements: { [item.id]: ["000000000002"] }, reason: "Provided complete replacement", complete: true }, undefined, "drop_observations");
  });
  s.ctx.modelRegistry.streamSimple = stream;
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("continue");
  expect(stream).toHaveBeenCalledTimes(1);
  expect(s.pi.appendEntry).toHaveBeenCalledWith("om.observations.dropped", expect.objectContaining({ observationIds: [item.id] }));
});

function batchedDropperStage() {
  const s = stage(true);
  s.runtime.config = { ...s.runtime.config, observationsPoolMaxTokens: 50, observationsPoolTargetTokens: 25, reflectionsPoolMaxTokens: 1,
    dropperInputMaxTokens: workerStaticPromptTokens("dropper") + WORKER_TURN_HEADROOM_TOKENS + 2400 };
  const observations = Array.from({ length: 6 }, (_, n) => ({ ...s.entries[1].data.observations[0],
    id: (100 + n).toString(16).padStart(12, "0"), content: `Candidate ${n}. ` + "x ".repeat(1200) }));
  s.entries[1].data.observations = observations;
  const reflections = observations.map((o, n) => ({ id: (200 + n).toString(16).padStart(12, "0"), content: o.content, supportingObservationIds: [o.id], tokenCount: 600 }));
  s.entries.push({ type: "custom", id: "replacements", customType: "om.reflections.recorded", data: { coversUpToId: "e1", reflections } });
  const evaluate = (context: any) => {
    const text = JSON.stringify(context);
    const ids = [...text.matchAll(/\[([a-f0-9]{12})\] \[OBSERVATION; candidate\]/g)].map(m => m[1]);
    const providedRefs = [...text.matchAll(/\[([a-f0-9]{12})\] \[REFLECTION; replacement only, never a drop id\]/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(observations.length);
    expect(new Set(providedRefs)).toEqual(new Set(reflections.filter(r => r.supportingObservationIds.some(id => ids.includes(id))).map(r => r.id)));
    return { ids, replacements: Object.fromEntries(ids.map(id => [id, reflections.filter(r => r.supportingObservationIds.includes(id)).map(r => r.id)])),
      reason: "Each provided replacement preserves the candidate", complete: true };
  };
  return { ...s, evaluate, observations };
}

it("batches complete proof bundles under the worker cap and commits the global selection once", async () => {
  const s = batchedDropperStage(), seen: string[] = [];
  const stream = vi.fn((_model, context) => {
    const proposal = s.evaluate(context); seen.push(...proposal.ids);
    return response(proposal, undefined, "drop_observations");
  });
  s.ctx.modelRegistry.streamSimple = stream;
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("continue");
  expect(stream.mock.calls.length).toBeGreaterThan(1);
  expect(seen).toEqual(s.observations.map(o => o.id));
  expect(s.pi.appendEntry).toHaveBeenCalledTimes(1);
  const data = s.pi.appendEntry.mock.calls[0][1];
  expect(data.observationIds).toHaveLength(3); // original per-run half-pool cap
  expect(Object.keys(data.proofs)).toHaveLength(3);
});

it("does not commit a partial prune when a later evidence batch fails", async () => {
  const s = batchedDropperStage();
  const stream = vi.fn((_model, context) => stream.mock.calls.length === 1
    ? response(s.evaluate(context), undefined, "drop_observations") : response(undefined, "HTTP 503 unavailable"));
  s.ctx.modelRegistry.streamSimple = stream;
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("abort");
  expect(stream).toHaveBeenCalledTimes(2);
  expect(s.pi.appendEntry).not.toHaveBeenCalled();
  expect(s.runtime.getCursor("dropper")).toBeUndefined();
});

it("defers an oversized candidate/proof bundle without trimming evidence or advancing coverage", async () => {
  const s = stage(true);
  s.runtime.config = { ...s.runtime.config, observationsPoolMaxTokens: 50, observationsPoolTargetTokens: 25,
    dropperInputMaxTokens: workerStaticPromptTokens("dropper") + WORKER_TURN_HEADROOM_TOKENS + 400 };
  const item = s.entries[1].data.observations[0];
  item.content = "Source evidence. ".repeat(20);
  s.entries.push({ type: "custom", id: "huge-proof", customType: "om.reflections.recorded", data: { coversUpToId: "e1", reflections: [
    { id: "000000000002", content: "Very long proof text. ".repeat(2000), supportingObservationIds: [item.id], tokenCount: 10000 },
  ] } });
  expect(await runDropperStage(s.pi, s.runtime, s.ctx, s.generation, s.resolve, [], undefined)).toBe("abort");
  expect(s.stream).not.toHaveBeenCalled();
  expect(s.pi.appendEntry).not.toHaveBeenCalled();
  expect(s.runtime.getCursor("dropper")).toBeUndefined();
  expect(s.runtime.lastDropperError).toContain("replacement evidence cannot fit");
});
