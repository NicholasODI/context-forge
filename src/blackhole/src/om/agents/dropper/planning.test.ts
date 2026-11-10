import { describe, expect, it } from "vitest";
import { dropEligibility, planDropperBatches, dropperContextSummary } from "./planning";
import { observationToDropperLine, reflectionToDropperLine } from "./coverage";
import { estimateStringTokens } from "../../tokens";
import type { Observation, Reflection } from "../../ledger/types";
const obs = (n: number): Observation => ({ id: n.toString().padStart(12, "0"), content: `Fact ${n}`, timestamp: "2026-11-01 00:00", relevance: "high", tokenCount: 2, sourceEntryIds: ["source"] });
const ref = (n: number, ids: string[]): Reflection => ({ id: (100 + n).toString().padStart(12, "0"), content: "Preserve the facts. ".repeat(20), tokenCount: 100, supportingObservationIds: ids });
describe("dropper proof-aware planning", () => {
  it("separates citation eligibility from protected and uncovered records", () => {
    const records = [obs(1), { ...obs(2), relevance: "critical" as const }, { ...obs(3), pinned: true }, obs(4)];
    const eligibility = dropEligibility(records, [ref(1, records.map(o => o.id).slice(0, 3))]);
    expect(eligibility.counts).toEqual({ total: 4, eligible: 1, protected: 2, uncovered: 1 });
    expect(eligibility.eligible.map(o => o.id)).toEqual([obs(1).id]);
    expect(eligibility.tokens.protected).toBeGreaterThan(0);
  });
  it("charges shared proof once and splits candidate/proof bundles jointly", () => {
    const records = [obs(1), obs(2)], reflection = ref(1, records.map(o => o.id));
    const observationCost = records.reduce((sum, o) => sum + estimateStringTokens(observationToDropperLine(o, "partial", [reflection])) + 1, 0);
    const together = observationCost + estimateStringTokens(reflectionToDropperLine(reflection)) + 1;
    const one = planDropperBatches(records, [reflection], together)!;
    expect(one).toHaveLength(1);
    expect(one[0].recordTokens).toBe(together);
    const split = planDropperBatches(records, [reflection], together - 1)!;
    expect(split).toHaveLength(2);
    expect(split.flatMap(b => b.observations.map(o => o.id))).toEqual(records.map(o => o.id));
    expect(split.every(b => b.reflections.length === 1 && b.recordTokens <= together - 1)).toBe(true);
  });
  it("includes every relevant proof and excludes unrelated reflections", () => {
    const records = [obs(1), obs(2)], refs = [ref(1, [obs(1).id]), ref(2, [obs(1).id]), ref(3, [obs(2).id]), ref(4, ["unrelated"])];
    const plan = planDropperBatches(records, refs, 10000)!;
    expect(plan[0].reflections.map(r => r.id)).toEqual(refs.slice(0, 3).map(r => r.id));
    expect(plan[0].observations).toHaveLength(2);
  });
  it("refuses a single oversized proof bundle rather than trimming evidence", () => {
    expect(planDropperBatches([obs(1)], [ref(1, [obs(1).id])], 10)).toBeUndefined();
    expect(planDropperBatches([], [], 10)).toEqual([]);
  });
  it("keeps an oversized read-only context entry out of the mandatory evidence budget", () => {
    const summary = dropperContextSummary([{ ...obs(1), content: "x".repeat(10000) }, obs(2)], 100);
    expect(summary).not.toContain(obs(1).id);
    expect(summary).toContain(obs(2).id);
    expect(estimateStringTokens(summary)).toBeLessThanOrEqual(100);
  });
});
