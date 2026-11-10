import { describe, expect, it, vi } from "vitest";
import { buildCompactionProjection } from "./projection";
import { renderSummary } from "./render-summary";
import { memoryDiagnostics, observeMemoryContext, renderMemoryDiagnostics, OM_SELECTION } from "./diagnostics";
import { CONTINUITY_START, CONTINUITY_END } from "../../core/continuity";
import type { Entry, Observation } from "./types";
import { registerCompactionContextHook } from "../../hooks/compaction-context";
import { registerMemoryCommand } from "../../commands/memory";
import { Runtime } from "../runtime";

const o = (n: number): Observation => ({ id: n.toString(16).padStart(12, "0"), content: `Constraint ${n}: preserve source evidence`, relevance: "high", timestamp: "2026-11-01 00:00", sourceEntryIds: [`u${n}`], tokenCount: 10 });
function fixture() {
  const entries: Entry[] = [];
  for (let n = 1; n <= 5; n++) entries.push({ type: "message", id: `u${n}`, message: { role: "user", content: `Constraint ${n}` } },
    { type: "custom", id: `o${n}`, customType: "om.observations.recorded", data: { coversUpToId: `u${n}`, observations: [o(n)] } });
  entries.push({ type: "custom", id: "drop", customType: "om.observations.dropped", data: { coversUpToId: "u5", observationIds: [o(1).id] } },
    { type: "custom", id: "invalid", customType: "om.memory.policy", data: { action: "invalidate", id: o(2).id, reason: "Corrected" } });
  const config = { observationsPoolMaxTokens: 35, reflectionsPoolMaxTokens: 50, fullFoldAlways: true };
  const projection = buildCompactionProjection(entries, "", config);
  const summary = `${CONTINUITY_START}\nResume task\n${CONTINUITY_END}\n\n${renderSummary(projection.reflections, projection.observations)}`;
  entries.push({ type: "compaction", id: "c1", firstKeptEntryId: "", summary, details: { "om.folded": projection.details,
    [OM_SELECTION]: { version: 1, config, reviewedThrough: { reflector: { entryId: "u5", state: "empty", completedAt: "2026-11-01T00:01:00Z", reviewSignature: "a".repeat(64) } } } } });
  return { entries, summary, projection };
}
describe("memory use diagnostics", () => {
  it("separates a dropped observation from an included active reflection with the same hash", () => {
    const observation = { ...o(1), relevance: "critical" as const };
    const reflection = { id: observation.id, content: observation.content, supportingObservationIds: [observation.id], tokenCount: 10 };
    const entries: Entry[] = [{ type: "message", id: "source", message: { role: "user", content: observation.content } },
      { type: "custom", id: "obs", customType: "om.observations.recorded", data: { coversUpToId: "source", observations: [observation] } },
      { type: "custom", id: "ref", customType: "om.reflections.recorded", data: { coversUpToId: "source", reflections: [reflection] } },
      { type: "custom", id: "historical-drop", timestamp: "2026-11-01T00:00:00Z", customType: "om.observations.dropped", data: {
        coversUpToId: "source", observationIds: [observation.id], proofs: { [observation.id]: { reflectionIds: [reflection.id], reason: "Historical marker, inspect source" } },
      } }];
    const config = { observationsPoolMaxTokens: 200, reflectionsPoolMaxTokens: 200, fullFoldAlways: true };
    const projection = buildCompactionProjection(entries, "", config);
    const summary = renderSummary(projection.reflections, projection.observations);
    entries.push({ type: "compaction", id: "c1", firstKeptEntryId: "", summary, details: {
      "om.folded": projection.details, [OM_SELECTION]: { version: 1, config, reviewedThrough: {} },
    } });
    const observed = observeMemoryContext([{ role: "compactionSummary", summary }], entries, "A");
    const report = memoryDiagnostics(entries, observed, "A");
    expect(report.reconstruction).toBe("available");
    expect(report.rows.find(r => r.kind === "observation")).toMatchObject({ reason: "dropped", importance: "critical", currentActive: false, contextObserved: false,
      dropEntry: { id: "historical-drop", timestamp: "2026-11-01T00:00:00Z" } });
    expect(report.rows.find(r => r.kind === "reflection")).toMatchObject({ reason: "included", importance: "critical", currentActive: true, contextObserved: true });
    expect(report.counts).toMatchObject({ dropped: 1, included: 1 });
    expect(report.criticalDropMarkers).toBe(1);
    expect(renderMemoryDiagnostics(report, 0, 10, observation.id)).toContain("written 2026-11-01T00:00:00Z");
    expect(renderMemoryDiagnostics(report, 0, 10, observation.id)).toContain("replacement refs=");
  });
  it("counts and observes two selected record kinds independently even when their hashes match", () => {
    const observation = o(1);
    const reflection = { id: observation.id, content: observation.content, supportingObservationIds: [observation.id], tokenCount: 10 };
    const entries: Entry[] = [{ type: "message", id: "source", message: { role: "user", content: observation.content } },
      { type: "custom", id: "obs", customType: "om.observations.recorded", data: { coversUpToId: "source", observations: [observation] } },
      { type: "custom", id: "ref", customType: "om.reflections.recorded", data: { coversUpToId: "source", reflections: [reflection] } }];
    const config = { observationsPoolMaxTokens: 200, reflectionsPoolMaxTokens: 200, fullFoldAlways: true };
    const projection = buildCompactionProjection(entries, "", config);
    entries.push({ type: "compaction", id: "c1", firstKeptEntryId: "", details: {
      "om.folded": projection.details, [OM_SELECTION]: { version: 1, config, reviewedThrough: {} },
    } });
    const observed = observeMemoryContext([{ role: "compactionSummary", summary: renderSummary(projection.reflections, []) }], entries, "A");
    const report = memoryDiagnostics(entries, observed, "A");
    expect(report.reconstruction).toBe("available");
    expect(report.counts.included).toBe(2);
    expect(report.rows.find(r => r.kind === "observation")?.contextObserved).toBe(false);
    expect(report.rows.find(r => r.kind === "reflection")?.contextObserved).toBe(true);
  });
  it("explains included, budget, dropped, corrected and post-snapshot records", () => {
    const { entries } = fixture();
    entries.push({ type: "custom", id: "later", customType: "om.observations.recorded", data: { coversUpToId: "u5", observations: [o(6)] } });
    const report = memoryDiagnostics(entries);
    expect(report.reconstruction).toBe("available");
    expect(report.counts).toMatchObject({ included: 1, budget: 2, dropped: 1, "policy-inactive": 1, "after-snapshot": 1 });
    expect(report.rows.every(r => r.estimatedTokens > 0 && r.contextObserved === null)).toBe(true);
    expect(renderMemoryDiagnostics(report, 0, 2)).toContain("Next: /blackhole-memory diagnostics offset:2");
    expect(renderMemoryDiagnostics(report)).toContain("2026-11-01T00:01:00Z");
  });
  it("records hook observations and refuses evidence from another session/checkpoint", () => {
    const { entries, summary, projection } = fixture();
    const context = observeMemoryContext([{ role: "compactionSummary", summary }], entries, "A")!;
    expect(context.observationIds).toEqual(projection.observations.map(o => o.id));
    expect(context.continuityPresent).toBe(true);
    expect(memoryDiagnostics(entries, context, "A").rows.filter(r => r.contextObserved)).toHaveLength(1);
    expect(memoryDiagnostics(entries, context, "B").context).toBeNull();
    expect(memoryDiagnostics(entries, { ...context, compactionId: "old" }, "A").context).toBeNull();
    const missing = observeMemoryContext([{ role: "user", content: summary }], entries, "A");
    expect(missing).toBeUndefined(); // unknown host shape / quoted user text is not summary evidence
  });
  it("recognizes complete multiline records rather than counting only one-line memories", () => {
    const observation = { ...o(1), content: "Preserve the invariant:\nDo not delete source evidence." };
    const entries: Entry[] = [{ type: "compaction", id: "c1", firstKeptEntryId: "", details: {
      "om.folded": { type: "om.folded", version: 1, fullFold: true, observations: [observation], reflections: [] },
    } }];
    const context = observeMemoryContext([{ role: "compactionSummary", summary: renderSummary([], [observation]) }], entries, "A");
    expect(context?.observationIds).toEqual([observation.id]);
  });
  it("does not invent reasons for legacy snapshots or missing selection metadata", () => {
    const { entries } = fixture();
    delete (entries.at(-1)!.details as Record<string, unknown>)[OM_SELECTION];
    const report = memoryDiagnostics(entries);
    expect(report.reconstruction).toBe("legacy-or-unavailable");
    expect(report.counts.unknown).toBe(2);
    expect(report.counts.budget).toBe(0);
  });
  it("separates historical inclusion from a correction made after the snapshot", () => {
    const { entries, projection } = fixture();
    const selectedId = projection.observations[0].id;
    entries.push({ type: "custom", id: "late-correction", customType: "om.memory.policy", data: { action: "invalidate", id: selectedId, reason: "New evidence" } });
    expect(memoryDiagnostics(entries).rows.find(r => r.id === selectedId)).toMatchObject({ reason: "included", currentActive: false });
  });
  it("distinguishes history outside the cut from budget exclusions", () => {
    const { entries } = fixture();
    entries.pop();
    const config = { observationsPoolMaxTokens: 1000, reflectionsPoolMaxTokens: 1000, fullFoldAlways: true };
    const projection = buildCompactionProjection(entries, "u3", config);
    entries.push({ type: "compaction", id: "cut", firstKeptEntryId: "u3", details: {
      "om.folded": projection.details, [OM_SELECTION]: { version: 1, config, reviewedThrough: {} },
    } });
    const report = memoryDiagnostics(entries);
    expect(report.counts["outside-boundary"]).toBe(2);
    expect(report.counts.budget).toBe(0);
  });
  it("observes a real context-hook invocation, pages diagnostics, and tolerates a stale context", async () => {
    const { entries, summary } = fixture();
    const runtime = new Runtime();
    vi.spyOn(runtime, "ensureConfig").mockImplementation(() => {});
    const hooks = new Map<string, Function>();
    let command: any;
    const pi: any = { on: (name: string, handler: Function) => hooks.set(name, handler), registerCommand: (_name: string, definition: any) => { command = definition; } };
    const ctx: any = { cwd: "/synthetic", ui: { notify: vi.fn() }, sessionManager: { getBranch: () => entries, getSessionId: () => "synthetic" } };
    registerCompactionContextHook(pi, runtime);
    registerMemoryCommand(pi, runtime);
    hooks.get("context")!({ messages: [{ role: "compactionSummary", summary }] }, ctx);
    expect(runtime.lastMemoryContext?.observationIds).toHaveLength(1);
    await command.handler("diagnostics offset:1 limit:2", ctx);
    expect(ctx.ui.notify.mock.calls.at(-1)[0]).toContain("Records 2–3 of 5");
    expect(ctx.ui.notify.mock.calls.at(-1)[0]).toContain("not a provider-wire receipt");
    await command.handler(`diagnostics id:${o(1).id} limit:2`, ctx);
    expect(ctx.ui.notify.mock.calls.at(-1)[0]).toContain(`matching id:${o(1).id}`);
    expect(ctx.ui.notify.mock.calls.at(-1)[0]).toContain("drop marker: drop");
    await expect(command.handler("diagnostics limit:1000", ctx)).rejects.toThrow("1–25");
    ctx.sessionManager.getSessionId = () => { throw new Error("extension ctx is stale"); };
    expect(() => hooks.get("context")!({ messages: [{ role: "compactionSummary", summary }] }, ctx)).not.toThrow();
    expect(runtime.lastMemoryContext).toBeUndefined();
  });
});
