import { describe, expect, it } from "vitest";
import { foldLedger } from "./fold";
import { fullProjection, buildCompactionProjection } from "./projection";
import { recallMemorySources } from "./recall";
import { livePoolObservations, livePoolReflections } from "./progress";
import { PinnedMemoryOverflowError, selectPriorObservations, selectPriorReflections, observationRenderedTokens } from "./render-summary";
import { selectDropCandidates, maxDropCountForPool } from "../agents/dropper/selection";
import type { Entry, Observation } from "./types";

const obs = (n: number, relevance: Observation["relevance"] = "high"): Observation => ({
  id: n.toString(16).padStart(12, "0"), content: `Important constraint ${n}: preserve evidence.`, relevance,
  timestamp: "2026-01-01 00:00", tokenCount: 10, sourceEntryIds: [`source-${n}`],
});
function record(n: number, relevance: Observation["relevance"] = "high"): Entry[] {
  return [{ type: "message", id: `source-${n}`, message: { role: "user", content: `Constraint ${n}`, timestamp: n } },
    { type: "custom", id: `record-${n}`, customType: "om.observations.recorded", data: { observations: [obs(n, relevance)], coversUpToId: `source-${n}` } }];
}
const policy = (action: string, id: string, replacementId?: string): Entry => ({ type: "custom", id: `policy-${action}-${id}`, customType: "om.memory.policy", data: { action, id, replacementId, reason: "Explicit project decision" } });

describe("retention and provenance", () => {
  it("ranks critical above newer high records", () => {
    expect(selectPriorObservations([obs(1, "critical"), obs(2)], 35).map(o => o.id)).toEqual([obs(1).id]);
  });
  it("prefers a task-relevant observation within an importance tier", () => {
    const related = { ...obs(1), content: "The observer runtime must preserve source coverage" };
    const unrelated = { ...obs(2), content: "The front-end stylesheet uses blue links" };
    expect(selectPriorObservations([related, unrelated], 35, "observer runtime source coverage")[0].id).toBe(related.id);
  });
  it("keeps a pinned constraint through 300 synthetic compactions and recalls its original evidence", () => {
    const entries = [...record(1, "critical"), policy("pin", obs(1).id)];
    for (let i = 2; i <= 301; i++) {
      entries.push(...record(i));
      const projection = buildCompactionProjection(entries, "", { observationsPoolMaxTokens: 200, reflectionsPoolMaxTokens: 100, fullFoldAlways: true });
      expect(projection.observations.some(o => o.id === obs(1).id && o.pinned)).toBe(true);
      entries.push({ type: "compaction", id: `compact-${i}`, firstKeptEntryId: "", details: { "om.folded": projection.details } });
    }
    expect(foldLedger(entries).observations).toHaveLength(301);
    expect(recallMemorySources(entries, obs(1).id).status).toBe("found");
  });
  it("honors a pin appended after the chosen raw-history cut", () => {
    const entries = [...record(1), ...record(2), policy("pin", obs(2).id)];
    const projection = buildCompactionProjection(entries, "source-1", { observationsPoolMaxTokens: 200, fullFoldAlways: true });
    expect(projection.observations.some(o => o.id === obs(2).id && o.pinned)).toBe(true);
  });
  it("surfaces pin overflow instead of silently dropping pins", () => {
    expect(() => selectPriorObservations([{ ...obs(1), pinned: true }], 1)).toThrow(PinnedMemoryOverflowError);
    expect(() => selectPriorReflections([{ id: "r", content: "A load-bearing rule", supportingObservationIds: [], tokenCount: 5, pinned: true }], 1)).toThrow(PinnedMemoryOverflowError);
  });
  it("supersedes facts without deleting history and transfers the pin", () => {
    const entries = [...record(1), ...record(2), policy("pin", obs(1).id), policy("supersede", obs(1).id, obs(2).id)];
    expect(fullProjection(entries).observations.map(o => o.id)).toEqual([obs(2).id]);
    expect(fullProjection(entries).observations[0].pinned).toBe(true);
    expect(foldLedger(entries).observations).toHaveLength(2);
    expect(recallMemorySources(entries, obs(1).id).status).toBe("found");
  });
  it("ignores invalid/self replacements and keeps invalidated records archived", () => {
    const entries = [...record(1), policy("supersede", obs(1).id, obs(1).id)];
    expect(fullProjection(entries).observations).toHaveLength(1);
    entries.push(policy("invalidate", obs(1).id));
    expect(fullProjection(entries).observations).toHaveLength(0);
    expect(foldLedger(entries).observationsById.has(obs(1).id)).toBe(true);
  });
  it("removes derived reflections after an explicit correction, preserving both source records", () => {
    const entries = [...record(1), ...record(2), {
      type: "custom", id: "reflections", customType: "om.reflections.recorded", data: { coversUpToId: "source-2", reflections: [
        { id: "000000000003", content: "The old fact distilled", supportingObservationIds: [obs(1).id], tokenCount: 8 },
      ] },
    }, policy("supersede", obs(1).id, obs(2).id)];
    expect(fullProjection(entries).reflections).toHaveLength(0);
    expect(foldLedger(entries).reflections).toHaveLength(1);
    expect(foldLedger(entries).observations).toHaveLength(2);
  });
  it("ranks reflections by supporting-fact importance instead of recency alone", () => {
    const entries = [...record(1, "critical"), ...record(2, "low"), {
      type: "custom", id: "reflections", customType: "om.reflections.recorded", data: { coversUpToId: "source-2", reflections: [
        { id: "000000000003", content: "Preserve the safety invariant", supportingObservationIds: [obs(1).id], tokenCount: 8 },
        { id: "000000000004", content: "A recent minor observation", supportingObservationIds: [obs(2).id], tokenCount: 8 },
      ] },
    }];
    expect(selectPriorReflections(fullProjection(entries).reflections, 20)[0].id).toBe("000000000003");
  });
  it("applies corrections after merging manual pending observations and reflections", () => {
    const entries = [...record(1), policy("invalidate", obs(2).id)];
    const pending = {
      observationBatches: [{ coversUpToId: "source-1", data: { observations: [obs(2)] } }],
      reflectionBatches: [{ coversUpToId: "source-1", data: { reflections: [{ id: "000000000003", content: "Old pending fact", supportingObservationIds: [obs(2).id], tokenCount: 8 }] } }],
    };
    expect(livePoolObservations(entries, pending).map(o => o.id)).toEqual([obs(1).id]);
    expect(livePoolReflections(entries, pending)).toHaveLength(0);
  });
});

describe("safe, token-targeted dropping", () => {
  it("never selects pinned/critical observations, even if the model proposes them", () => {
    const observations = [{ ...obs(1), pinned: true }, obs(2, "critical"), obs(3, "low")];
    const reflection = { id: "r", content: "Coverage", tokenCount: 4, supportingObservationIds: observations.map(o => o.id) };
    expect(selectDropCandidates(observations.map(o => o.id), observations, 3, [reflection])).toEqual([obs(3).id]);
  });
  it("vetoes drops without an available covering reflection", () => {
    expect(selectDropCandidates([obs(1).id], [obs(1)], 1, [])).toEqual([]);
  });
  it("does no pruning work below the real target and stops once the token target is met", () => {
    expect(maxDropCountForPool([obs(1)], 400, 1000, 0.1, 500)).toBe(0);
    const observations = [obs(1, "low"), obs(2, "low"), obs(3, "low")];
    const reflection = { id: "r", content: "Coverage", tokenCount: 4, supportingObservationIds: observations.map(o => o.id) };
    expect(selectDropCandidates(observations.map(o => o.id), observations, 3, [reflection], observationRenderedTokens(observations[0]))).toHaveLength(1);
  });
});
