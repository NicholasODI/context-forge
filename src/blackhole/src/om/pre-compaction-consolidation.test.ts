import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Runtime } from "./runtime.ts";
import { consolidateBeforeCompaction } from "./consolidation.ts";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../hooks/before-compact.ts";
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
  consolidateBeforeCompaction?: boolean;
  consolidatorModel?: { provider: string; id: string };
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

  const runtime = new Runtime();
  runtime.applyLoadedConfig({
    ...runtime.config,
    // Very high normal thresholds so ordinary consolidation would NOT trigger
    observeAfterTokens: 999_999,
    reflectAfterTokens: 999_999,
    observationsPoolMaxTokens: opts?.observationsPoolMaxTokens ?? 60,
    observationsPoolTargetTokens: opts?.observationsPoolTargetTokens ?? 10,
    dropperPoolFullnessThreshold: 0.9,
    consolidateBeforeCompaction: opts?.consolidateBeforeCompaction ?? true,
  });
  if (opts?.consolidatorModel) {
    runtime.setForgeOverrides({
      consolidatorModel: opts.consolidatorModel,
      consolidateBeforeCompaction: opts?.consolidateBeforeCompaction ?? true,
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
  it("skips when consolidateBeforeCompaction is disabled", async () => {
    const h = makeHarness({ consolidateBeforeCompaction: false });
    const res = await consolidateBeforeCompaction(h.pi, h.runtime, h.ctx);
    expect(res).toEqual({ outcome: "skipped", reason: "disabled" });
    expect(h.streamSimple).not.toHaveBeenCalled();
  });

  it("fully consolidates remaining below-threshold tokens across Observer, Reflector, and Dropper using the separate consolidator model", async () => {
    const h = makeHarness({
      consolidateBeforeCompaction: true,
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
    const h = makeHarness({ consolidateBeforeCompaction: true });
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
      consolidateBeforeCompaction: true,
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

  it("preserves forge consolidator model overrides across applyLoadedConfig reloads", () => {
    const runtime = new Runtime();
    runtime.setForgeOverrides({
      consolidatorModel: { provider: "openai", id: "gpt-5-mini" },
      consolidateBeforeCompaction: true,
    });
    runtime.applyLoadedConfig({
      ...runtime.config,
      model: { provider: "anthropic", id: "claude-haiku-4-5", thinking: "low" },
      consolidateBeforeCompaction: false,
    });
    expect(runtime.config.model).toEqual({
      provider: "openai",
      id: "gpt-5-mini",
      thinking: "low",
    });
    expect(runtime.config.consolidateBeforeCompaction).toBe(true);

    // Clearing consolidatorModel override restores the blackhole config model
    runtime.setForgeOverrides({
      consolidatorModel: undefined,
      consolidateBeforeCompaction: false,
    });
    expect(runtime.config.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
      thinking: "low",
    });
    expect(runtime.config.consolidateBeforeCompaction).toBe(false);
  });
});
