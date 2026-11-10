import type { Observation, Reflection } from "../../ledger/types.js";
import { observationRenderedTokens, observationToSummaryLine } from "../../ledger/render-summary.js";
import { estimateStringTokens } from "../../tokens.js";
import { observationToDropperLine, reflectionToDropperLine, reflectionCoverageTierForCount } from "./coverage.js";

/** Proof availability is measured against the active ledger, not the summary. */
export function dropEligibility(observations: readonly Observation[], reflections: readonly Reflection[]) {
  const covered = new Set(reflections.flatMap(r => r.supportingObservationIds));
  const eligible: Observation[] = [], protectedRecords: Observation[] = [], uncovered: Observation[] = [];
  for (const o of observations) {
    if (o.pinned || o.relevance === "critical") protectedRecords.push(o);
    else if (!covered.has(o.id)) uncovered.push(o);
    else eligible.push(o);
  }
  const tokens = (records: Observation[]) => records.reduce((sum, o) => sum + observationRenderedTokens(o), 0);
  return { eligible, counts: { total: observations.length, eligible: eligible.length, protected: protectedRecords.length, uncovered: uncovered.length },
    tokens: { eligible: tokens(eligible), protected: tokens(protectedRecords), uncovered: tokens(uncovered) } };
}

export function relevantDropperReflections(observations: readonly Observation[], reflections: readonly Reflection[]): Reflection[] {
  const ids = new Set(observations.map(o => o.id));
  return reflections.filter(r => r.supportingObservationIds.some(id => ids.has(id)));
}

/** Optional read-only context must not crowd out the mandatory proof bundles. */
export function dropperContextSummary(observations: readonly Observation[], maxTokens: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const observation of observations) {
    const line = observationToSummaryLine(observation), cost = estimateStringTokens(line) + 1;
    if (used + cost > maxTokens) continue;
    lines.push(line); used += cost;
  }
  return lines.join("\n");
}

export interface DropperBatch { observations: Observation[]; reflections: Reflection[]; recordTokens: number }

/** Greedy joint budget: each candidate travels with ALL its available proofs.
 * No proof is silently trimmed to make a batch fit. Undefined means even one
 * candidate/proof bundle cannot fit; callers must leave coverage unchanged. */
export function planDropperBatches(observations: readonly Observation[], reflections: readonly Reflection[], maxRecordTokens: number): DropperBatch[] | undefined {
  if (!observations.length) return [];
  if (!Number.isFinite(maxRecordTokens) || maxRecordTokens <= 0) return undefined;
  const refsByObservation = new Map<string, Reflection[]>();
  const refCosts = new Map<string, number>();
  for (const r of reflections) {
    if (refCosts.has(r.id)) continue;
    refCosts.set(r.id, estimateStringTokens(reflectionToDropperLine(r)) + 1);
    for (const id of new Set(r.supportingObservationIds)) {
      const refs = refsByObservation.get(id) ?? [];
      refs.push(r); refsByObservation.set(id, refs);
    }
  }
  const batches: DropperBatch[] = [];
  let batch: Observation[] = [], included = new Map<string, Reflection>(), used = 0;
  const flush = () => {
    if (batch.length) batches.push({ observations: batch, reflections: [...included.values()], recordTokens: used });
    batch = []; included = new Map(); used = 0;
  };
  for (const observation of observations) {
    const refs = refsByObservation.get(observation.id) ?? [];
    const observationCost = estimateStringTokens(observationToDropperLine(observation, reflectionCoverageTierForCount(refs.length), refs)) + 1;
    const bundleCost = observationCost + refs.reduce((sum, r) => sum + refCosts.get(r.id)!, 0);
    if (bundleCost > maxRecordTokens) return undefined;
    const extra = () => observationCost + refs.filter(r => !included.has(r.id)).reduce((sum, r) => sum + refCosts.get(r.id)!, 0);
    if (used + extra() > maxRecordTokens) flush();
    used += extra(); batch.push(observation);
    for (const r of refs) included.set(r.id, r);
  }
  flush();
  return batches;
}
