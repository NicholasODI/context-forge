import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Runtime } from "./runtime.ts";
import {
  OBSERVER_DRAIN_MAX_BATCHES,
  consolidateBeforeCompaction,
  registerConsolidationTrigger,
  remainingUnobservedTokens,
  triggerConsolidation,
} from "./consolidation.ts";
import { registerCompactionTrigger } from "./compaction-trigger.ts";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../hooks/before-compact.ts";
import type { ConsolidateBeforeCompactionMode } from "../core/unified-config.ts";
import {
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  foldLedger,
} from "./ledger/index.ts";

const sandbox = vi.hoisted(() => ({ root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original<object>()),
  getAgentDir: () => sandbox.root,
}));

beforeEach(async () => {
  sandbox.root = await mkdtemp(join(tmpdir(), "forge-precompact-test-"));
});
afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

const sessionModel = {
  provider: "main-provider",
  id: "main-coding-model",
  api: "openai-completions",
  contextWindow: 200_000,
  maxTokens: 32_768,
  reasoning: false,
} as any;

const consolidatorModel = {
  provider: "consolidator-provider",
  id: "fast-consolidator",
  api: "openai-completions",
  contextWindow: 131_072,
  maxTokens: 16_384,
  reasoning: false,
} as any;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolResponse(targetModel: any, toolName: string, args: unknown) {
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${toolName}`, name: toolName, arguments: args }],
    api: targetModel.api,
    provider: targetModel.provider,
    model: targetModel.id,
    usage,
    timestamp: Date.now(),
    stopReason: "toolUse",
  } as any;
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "toolUse", message });
  stream.end(message);
  return stream;
}

function makeHarness(opts?: {
  consolidateBeforeCompaction?: ConsolidateBeforeCompactionMode;
  consolidatorModel?: { provider: string; id: string };
  observeAfterTokens?: number;
  observationsPoolMaxTokens?: number;
  observationsPoolTargetTokens?: number;
}) {
  const entries: any[] = [
    {
      type: "message",
      id: "e1",
      message: { role: "user", content: "Investigate API retry backoff in src/client.ts", timestamp: 1 },
    },
    {
      type: "message",
      id: "e2",
      message: { role: "assistant", content: "Found exponential backoff bug in src/client.ts line 42.", timestamp: 2 },
    },
    {
      type: "message",
      id: "e3",
      message: { role: "user", content: "Fix it and keep jitter enabled", timestamp: 3 },
    },
    {
      type: "message",
      id: "e4",
      message: { role: "assistant", content: "Fixed backoff jitter and verified unit tests pass.", timestamp: 4 },
    },
  ];

  const mode = opts?.consolidateBeforeCompaction ?? "flush";
  const runtime = new Runtime();
  runtime.applyLoadedConfig({
    ...runtime.config,
    // Very high normal thresholds so ordinary consolidation would NOT trigger
    observeAfterTokens: opts?.observeAfterTokens ?? 999_999,
    reflectAfterTokens: 999_999,
    observationsPoolMaxTokens: opts?.observationsPoolMaxTokens ?? 60,
    observationsPoolTargetTokens: opts?.observationsPoolTargetTokens ?? 10,
    dropperPoolFullnessThreshold: 0.9,
    consolidateBeforeCompaction: mode,
  });
  if (opts?.consolidatorModel) {
    runtime.setForgeOverrides({
      consolidatorModel: opts.consolidatorModel,
      consolidateBeforeCompaction: mode,
    });
  }
  runtime.startSession("precompact-session");

  let nextId = 100;
  const pi: any = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({
        type: "custom",
        id: `c${++nextId}`,
        customType,
        data,
      });
    }),
    on: vi.fn(),
  };

  const modelsUsed: Array<{ stage: string; model: string }> = [];
  let recordedObsId: string | undefined;
  let recordedReflectionId: string | undefined;

  const streamSimple = vi.fn((calledModel: any, _context: any) => {
    const modelId = `${calledModel.provider}/${calledModel.id}`;
    const stage = runtime.consolidationPhase ?? "unknown";
    modelsUsed.push({ stage, model: modelId });

    if (stage === "observer") {
      return toolResponse(calledModel, "record_observations", {
        complete: true,
        observations: [
          {
            content: "Exponential backoff bug in src/client.ts line 42 was fixed with jitter preserved",
            relevance: "medium",
            sourceEntryIds: ["e1", "e2", "e3", "e4"],
          },
          {
            content: "Unit tests for src/client.ts backoff behavior now pass after the jitter fix",
            relevance: "low",
            sourceEntryIds: ["e4"],
          },
        ],
      });
    }
    if (stage === "reflector") {
      const folded = foldLedger(entries);
      const obsIds = folded.activeObservations.map((o) => o.id);
      recordedObsId = obsIds[obsIds.length - 1];
      return toolResponse(calledModel, "record_reflections", {
        complete: true,
        reflections: [
          {
            content:
              "src/client.ts exponential backoff jitter fix completed and verified with passing unit tests; all retry logic requirements satisfied.",
            supportingObservationIds: obsIds,
          },
        ],
      });
    }
    if (stage === "dropper") {
      const folded = foldLedger(entries);
      recordedReflectionId = folded.activeReflections[0]?.id;
      const dropTarget = recordedObsId ?? folded.activeObservations[0]?.id;
      return toolResponse(calledModel, "drop_observations", {
        complete: true,
        ids: dropTarget && recordedReflectionId ? [dropTarget] : [],
        replacements:
          dropTarget && recordedReflectionId
            ? { [dropTarget]: [recordedReflectionId] }
            : {},
        reason: "Fully superseded by verified reflection",
      });
    }
    throw new Error(`Unexpected stage: ${stage}`);
  });

  const ctx: any = {
    cwd: sandbox.root,
    hasUI: false,
    model: sessionModel,
    ui: { notify: vi.fn() },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === consolidatorModel.provider && id === consolidatorModel.id
          ? consolidatorModel
          : provider === sessionModel.provider && id === sessionModel.id
            ? sessionModel
            : undefined,
      getAvailable: () => [sessionModel, consolidatorModel],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      streamSimple,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => "precompact-session",
    },
  };

  return { entries, runtime, pi, ctx, modelsUsed, streamSimple };
}

describe("pre-compaction full consolidation & separate consolidator model", () => {
  it("skips when consolidateBeforeCompaction is off", async () => {
    const h = makeHarness({ consolidateBeforeCompaction: "off" });
    const res = await consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    expect(res).toEqual({ outcome: "skipped", reason: "disabled" });
    expect(h.streamSimple).not.toHaveBeenCalled();
  });

  it("bypasses automatic background triggers in 'only' mode while still allowing manual and pre-compaction consolidation", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: "only",
      observeAfterTokens: 1, // well below branch token count so normal trigger would fire
      consolidatorModel: {
        provider: consolidatorModel.provider,
        id: consolidatorModel.id,
      },
    });
    const handlers: Record<string, (event: any, ctx: any) => void> = {};
    h.pi.on.mockImplementation((name: string, fn: any) => {
      handlers[name] = fn;
    });
    registerConsolidationTrigger(h.pi, h.runtime, {
      observationalMemory: true,
      vccCompaction: true,
    });

    // Automatic background triggers are bypassed in "only" mode
    handlers.agent_start?.({}, h.ctx);
    handlers.turn_end?.({}, h.ctx);
    await Promise.resolve();
    expect(h.runtime.consolidationInFlight).toBe(false);
    expect(h.streamSimple).not.toHaveBeenCalled();

    // Explicit manual /blackhole-consolidate still launches and fully consolidates all stages
    const manual = triggerConsolidation(h.pi, h.runtime, h.ctx);
    expect(manual.outcome).toBe("launched");
    await h.runtime.consolidationPromise;
    expect(h.modelsUsed.map((m) => m.stage)).toEqual(["observer", "reflector", "dropper"]);
    expect(remainingUnobservedTokens(h.entries, h.runtime)).toBe(0);

    // Pre-compaction consolidation afterwards sees the tip was already fully consolidated
    const pre = await consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    expect(pre).toEqual({ outcome: "skipped", reason: "already_consolidated" });
    expect(h.streamSimple).toHaveBeenCalledTimes(3);
  });

  it("/blackhole-consolidate drains an entire multi-chunk backlog (> OBSERVER_DRAIN_MAX_BATCHES) down to 0 remaining tokens", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: "only",
      consolidatorModel: {
        provider: consolidatorModel.provider,
        id: consolidatorModel.id,
      },
    });
    // Replace branch with 12 chunks (~200 tokens each) and cap observerChunkMaxTokens to 250
    // so each observer batch processes at most 1 chunk — well beyond the default 3+1=4 batch cap.
    h.entries.length = 0;
    for (let i = 1; i <= 12; i++) {
      h.entries.push({
        type: "message",
        id: `big-${i}`,
        message: {
          role: i % 2 === 1 ? "user" : "assistant",
          content: `Chunk ${i} evidence: ` + `fact_${i} `.repeat(120),
          timestamp: i,
        },
      });
    }
    h.runtime.applyLoadedConfig({
      ...h.runtime.config,
      observeAfterTokens: 999_999,
      reflectAfterTokens: 999_999,
      observerChunkMaxTokens: 250,
      observationsPoolMaxTokens: 500,
      observationsPoolTargetTokens: 100,
      consolidateBeforeCompaction: "only",
    });

    const observedChunks: string[][] = [];
    const baseStream = h.ctx.modelRegistry.streamSimple;
    h.ctx.modelRegistry.streamSimple = vi.fn((calledModel: any, context: any) => {
      if (h.runtime.consolidationPhase === "observer") {
        const userMsg = context.messages.findLast((m: any) => m.role === "user");
        const body =
          typeof userMsg.content === "string"
            ? userMsg.content
            : userMsg.content.map((b: any) => b.text ?? "").join("\n");
        const ids = [...body.matchAll(/\[Source entry id: ([^\]]+)\]/g)].map((m) => m[1]);
        observedChunks.push(ids);
        h.modelsUsed.push({
          stage: "observer",
          model: `${calledModel.provider}/${calledModel.id}`,
        });
        return toolResponse(calledModel, "record_observations", {
          complete: true,
          observations: ids.map((id) => ({
            content: `Observed durable fact from ${id} with details`,
            relevance: "medium",
            sourceEntryIds: [id],
          })),
        });
      }
      return baseStream(calledModel, context);
    });

    const manual = triggerConsolidation(h.pi, h.runtime, h.ctx);
    expect(manual.outcome).toBe("launched");
    await h.runtime.consolidationPromise;

    // Every single one of the 12 chunks was drained well past the default 3+1=4 batch cap!
    expect(observedChunks.length).toBeGreaterThan(OBSERVER_DRAIN_MAX_BATCHES + 1);
    expect(observedChunks.flat()).toEqual(Array.from({ length: 12 }, (_, i) => `big-${i + 1}`));
    expect(h.runtime.getCursor("observer")?.entryId).toBe("big-12");
    expect(remainingUnobservedTokens(h.entries, h.runtime)).toBe(0);
    // Reflector and Dropper also ran after the full observer drain
    expect(h.modelsUsed.some((m) => m.stage === "reflector")).toBe(true);
    expect(h.modelsUsed.some((m) => m.stage === "dropper")).toBe(true);
  });

  it("pre-compaction consolidation drains all remaining chunks across an unrenderable leading entry before unblocking requests", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: "only",
      consolidatorModel: {
        provider: consolidatorModel.provider,
        id: consolidatorModel.id,
      },
    });
    h.entries.length = 0;
    // Empty/unrenderable leading entry right before oversized chunks
    h.entries.push({
      type: "message",
      id: "empty-0",
      message: { role: "assistant", content: "", timestamp: 0 },
    });
    for (let i = 1; i <= 8; i++) {
      h.entries.push({
        type: "message",
        id: `pre-${i}`,
        message: {
          role: i % 2 === 1 ? "user" : "assistant",
          content: `Pre-compact chunk ${i}: ` + `detail_${i} `.repeat(120),
          timestamp: i,
        },
      });
    }
    h.runtime.applyLoadedConfig({
      ...h.runtime.config,
      compactAfterTokens: 1,
      observeAfterTokens: 999_999,
      reflectAfterTokens: 999_999,
      observerChunkMaxTokens: 250,
      observationsPoolMaxTokens: 500,
      observationsPoolTargetTokens: 100,
      midRunCompaction: "off",
      consolidateBeforeCompaction: "only",
    });
    h.ctx.isIdle = () => true;
    h.ctx.compact = vi.fn();

    let releaseLastChunk!: () => void;
    const lastChunkGate = new Promise<void>((resolve) => {
      releaseLastChunk = resolve;
    });
    const observedIds: string[] = [];
    const baseStream = h.ctx.modelRegistry.streamSimple;
    h.ctx.modelRegistry.streamSimple = vi.fn((calledModel: any, context: any) => {
      if (h.runtime.consolidationPhase === "observer") {
        const userMsg = context.messages.findLast((m: any) => m.role === "user");
        const body =
          typeof userMsg.content === "string"
            ? userMsg.content
            : userMsg.content.map((b: any) => b.text ?? "").join("\n");
        const ids = [...body.matchAll(/\[Source entry id: ([^\]]+)\]/g)].map((m) => m[1]);
        observedIds.push(...ids);
        h.modelsUsed.push({
          stage: "observer",
          model: `${calledModel.provider}/${calledModel.id}`,
        });
        if (ids.includes("pre-8")) {
          const stream = createAssistantMessageEventStream();
          void lastChunkGate.then(() => {
            const message = {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-last",
                  name: "record_observations",
                  arguments: {
                    complete: true,
                    observations: ids.map((id) => ({
                      content: `Observed final chunk ${id}`,
                      relevance: "medium",
                      sourceEntryIds: [id],
                    })),
                  },
                },
              ],
              api: calledModel.api,
              provider: calledModel.provider,
              model: calledModel.id,
              usage,
              timestamp: Date.now(),
              stopReason: "toolUse",
            } as any;
            stream.push({ type: "done", reason: "toolUse", message });
            stream.end(message);
          });
          return stream;
        }
        return toolResponse(calledModel, "record_observations", {
          complete: true,
          observations: ids.map((id) => ({
            content: `Observed chunk ${id}`,
            relevance: "medium",
            sourceEntryIds: [id],
          })),
        });
      }
      return baseStream(calledModel, context);
    });

    const handlers: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
    h.pi.on.mockImplementation((name: string, fn: any) => {
      handlers[name] = fn;
    });
    registerCompactionTrigger(h.pi, h.runtime);

    let agentEndDone = false;
    const agentEndP = Promise.resolve(handlers.agent_end?.({ messages: [] }, h.ctx)).then(() => {
      agentEndDone = true;
    });

    // Wait until chunks 1..7 have processed and chunk 8 is gated
    await new Promise((r) => setTimeout(r, 40));
    expect(agentEndDone).toBe(false);
    expect(observedIds).toContain("pre-8");

    // Request gate stays blocked until chunk 8 + Reflector + Dropper complete
    let nextRequestUnblocked = false;
    const nextRequestP = Promise.resolve(
      handlers.before_provider_request?.({ payload: {} }, h.ctx),
    ).then(() => {
      nextRequestUnblocked = true;
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(nextRequestUnblocked).toBe(false);

    releaseLastChunk();
    await Promise.all([agentEndP, nextRequestP]);

    expect(agentEndDone).toBe(true);
    expect(nextRequestUnblocked).toBe(true);
    expect(observedIds).toEqual(Array.from({ length: 8 }, (_, i) => `pre-${i + 1}`));
    expect(remainingUnobservedTokens(h.entries, h.runtime)).toBe(0);
    expect(h.runtime.getCursor("observer")?.entryId).toBe("pre-8");
    expect(h.modelsUsed.some((m) => m.stage === "reflector")).toBe(true);
    expect(h.modelsUsed.some((m) => m.stage === "dropper")).toBe(true);
  });

  it("fully consolidates remaining below-threshold tokens across Observer, Reflector, and Dropper using the separate consolidator model", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: "flush",
      consolidatorModel: {
        provider: consolidatorModel.provider,
        id: consolidatorModel.id,
      },
    });

    const res = await consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    expect(res).toEqual({ outcome: "ran" });

    // All three stages ran in order using the separate consolidator model
    expect(h.modelsUsed).toEqual([
      { stage: "observer", model: "consolidator-provider/fast-consolidator" },
      { stage: "reflector", model: "consolidator-provider/fast-consolidator" },
      { stage: "dropper", model: "consolidator-provider/fast-consolidator" },
    ]);

    // All three OM entry types were appended to the branch
    const appendedTypes = h.pi.appendEntry.mock.calls.map((call: unknown[]) => call[0]);
    expect(appendedTypes).toContain(OM_OBSERVATIONS_RECORDED);
    expect(appendedTypes).toContain(OM_REFLECTIONS_RECORDED);
    expect(appendedTypes).toContain(OM_OBSERVATIONS_DROPPED);

    // Immediate second call for the same branch tip is an idempotent no-op
    const second = await consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    expect(second).toEqual({ outcome: "skipped", reason: "already_consolidated" });
    expect(h.streamSimple).toHaveBeenCalledTimes(3);

    // Adding a new source entry re-arms pre-compaction consolidation
    h.entries.push({
      type: "message",
      id: "e5",
      message: { role: "user", content: "Also document retry limits", timestamp: 5 },
    });
    const third = await consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    expect(third).toEqual({ outcome: "ran" });
    expect(h.streamSimple.mock.calls.length).toBeGreaterThan(3);
  });

  it("awaits an in-flight consolidation run before running pre-compaction consolidation", async () => {
    const h = makeHarness({ consolidateBeforeCompaction: "flush" });
    let releaseInFlight!: () => void;
    let inFlightDone = false;
    h.runtime.consolidationInFlight = true;
    h.runtime.consolidationPromise = new Promise<void>((resolve) => {
      releaseInFlight = () => {
        inFlightDone = true;
        h.runtime.consolidationInFlight = false;
        h.runtime.consolidationPromise = null;
        resolve();
      };
    });

    const prePromise = consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    await Promise.resolve();
    expect(h.streamSimple).not.toHaveBeenCalled();

    releaseInFlight();
    const res = await prePromise;
    expect(inFlightDone).toBe(true);
    expect(res).toEqual({ outcome: "ran" });
    expect(h.streamSimple).toHaveBeenCalled();
  });

  it("before-compact hook consolidates remaining tokens and includes fresh tip-covered OM entries in the compaction summary", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: "only",
      consolidatorModel: {
        provider: consolidatorModel.provider,
        id: consolidatorModel.id,
      },
    });

    let beforeCompactHandler: ((event: any, ctx: any) => Promise<any>) | undefined;
    h.pi.on.mockImplementation((eventName: string, fn: any) => {
      if (eventName === "session_before_compact") beforeCompactHandler = fn;
    });
    registerBeforeCompactHook(h.pi, h.runtime);
    expect(beforeCompactHandler).toBeDefined();

    // Snapshot branchEntries BEFORE consolidation (just like OMP host does)
    const snapshotBefore = [...h.entries];
    const result = await beforeCompactHandler!(
      {
        preparation: {
          firstKeptEntryId: "e3",
          tokensBefore: 1200,
          fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
        },
        branchEntries: snapshotBefore,
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
      },
      h.ctx,
    );

    expect(result?.compaction).toBeDefined();
    // Summary includes freshly consolidated observation + reflection even though coversUpToId ("e4") > firstKeptEntryId ("e3")
    expect(result.compaction.summary).toContain("exponential backoff");
    expect(result.compaction.summary).toContain("src/client.ts");
    // Dropper ran and pruned one of the two observations
    const omDetails = result.compaction.details?.["om.folded"];
    expect(omDetails?.reflections?.length).toBe(1);
    expect(omDetails?.observations?.length).toBe(1);
  });

  it("blocks agent_end, before_agent_start, and before_provider_request synchronously until pre-compaction consolidation finishes", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: "only",
      consolidatorModel: {
        provider: consolidatorModel.provider,
        id: consolidatorModel.id,
      },
    });
    h.runtime.applyLoadedConfig({
      ...h.runtime.config,
      compactAfterTokens: 1, // trigger immediately on agent_end
      midRunCompaction: "off",
      consolidateBeforeCompaction: "only",
    });

    const workingMessages: Array<string | undefined> = [];
    h.ctx.hasUI = true;
    h.ctx.ui = {
      notify: vi.fn(),
      setWorkingMessage: vi.fn((msg?: string) => workingMessages.push(msg)),
    };
    h.ctx.isIdle = () => true;
    const compactCalls: number[] = [];
    h.ctx.compact = vi.fn(() => {
      compactCalls.push(h.modelsUsed.length);
    });

    // Gate the observer stream so we can prove agent_end + request hooks stay blocked while it runs
    let releaseObserver!: () => void;
    const observerGate = new Promise<void>((resolve) => {
      releaseObserver = resolve;
    });
    const baseStream = h.ctx.modelRegistry.streamSimple;
    h.ctx.modelRegistry.streamSimple = vi.fn((calledModel: any, context: any) => {
      if (h.runtime.consolidationPhase === "observer") {
        const stream = createAssistantMessageEventStream();
        void observerGate.then(() => {
          const message = {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-obs",
                name: "record_observations",
                arguments: {
                  complete: true,
                  observations: [
                    {
                      content: "Exponential backoff bug in src/client.ts line 42 was fixed with jitter preserved",
                      relevance: "medium",
                      sourceEntryIds: ["e1", "e2", "e3", "e4"],
                    },
                    {
                      content: "Unit tests for src/client.ts backoff behavior now pass after the jitter fix",
                      relevance: "low",
                      sourceEntryIds: ["e4"],
                    },
                  ],
                },
              },
            ],
            api: calledModel.api,
            provider: calledModel.provider,
            model: calledModel.id,
            usage,
            timestamp: Date.now(),
            stopReason: "toolUse",
          } as any;
          h.modelsUsed.push({
            stage: "observer",
            model: `${calledModel.provider}/${calledModel.id}`,
          });
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
        });
        return stream;
      }
      return baseStream(calledModel, context);
    });

    const handlers: Record<string, (event: any, ctx: any) => Promise<void> | void> = {};
    h.pi.on.mockImplementation((name: string, fn: any) => {
      handlers[name] = fn;
    });
    registerCompactionTrigger(h.pi, h.runtime);

    let agentEndSettled = false;
    const agentEndPromise = Promise.resolve(
      handlers.agent_end?.({ messages: [] }, h.ctx),
    ).then(() => {
      agentEndSettled = true;
    });

    // Give microtasks a chance to enter observer stage
    await new Promise((r) => setTimeout(r, 20));
    expect(agentEndSettled).toBe(false);
    expect(h.runtime.preCompactionConsolidationPromise).not.toBeNull();
    expect(workingMessages[0]).toContain("Consolidating memory before compaction");

    // Outgoing request hooks must also block while pre-compaction consolidation is running
    let beforeAgentSettled = false;
    let beforeProviderSettled = false;
    const beforeAgentPromise = Promise.resolve(handlers.before_agent_start?.({}, h.ctx)).then(
      () => {
        beforeAgentSettled = true;
      },
    );
    const beforeProviderPromise = Promise.resolve(
      handlers.before_provider_request?.({ payload: {} }, h.ctx),
    ).then(() => {
      beforeProviderSettled = true;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(beforeAgentSettled).toBe(false);
    expect(beforeProviderSettled).toBe(false);
    expect(h.ctx.compact).not.toHaveBeenCalled();

    // Release observer — full Observer → Reflector → Dropper completes before agent_end / hooks resolve
    releaseObserver();
    await Promise.all([agentEndPromise, beforeAgentPromise, beforeProviderPromise]);

    expect(agentEndSettled).toBe(true);
    expect(beforeAgentSettled).toBe(true);
    expect(beforeProviderSettled).toBe(true);
    expect(h.runtime.preCompactionConsolidationPromise).toBeNull();
    expect(h.modelsUsed.map((m) => m.stage)).toEqual(["observer", "reflector", "dropper"]);
    expect(workingMessages.at(-1)).toBeUndefined();

    // Let deferred idle-wait microtask invoke ctx.compact() and confirm consolidation was already done
    await new Promise((r) => setTimeout(r, 25));
    expect(compactCalls).toEqual([3]);
  });

  it("preserves forge consolidator model overrides across applyLoadedConfig reloads", () => {
    const runtime = new Runtime();
    runtime.setForgeOverrides({
      consolidatorModel: { provider: "openai", id: "gpt-5-mini" },
      consolidateBeforeCompaction: "only",
    });
    runtime.applyLoadedConfig({
      ...runtime.config,
      model: { provider: "anthropic", id: "claude-haiku-4-5", thinking: "low" },
      consolidateBeforeCompaction: "off",
    });
    expect(runtime.config.model).toEqual({
      provider: "openai",
      id: "gpt-5-mini",
      thinking: "low",
    });
    expect(runtime.config.consolidateBeforeCompaction).toBe("only");

    // Clearing consolidatorModel override restores the blackhole config model
    runtime.setForgeOverrides({
      consolidatorModel: undefined,
      consolidateBeforeCompaction: "off",
    });
    expect(runtime.config.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
      thinking: "low",
    });
    expect(runtime.config.consolidateBeforeCompaction).toBe("off");
  });
});
