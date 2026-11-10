import type { Entry, Observation, Reflection } from "./types.js";

export const OM_MEMORY_POLICY = "om.memory.policy";
export interface MemoryPolicy {
  action: "pin" | "unpin" | "invalidate" | "supersede";
  id: string;
  reason: string;
  replacementId?: string;
}

/** Policy events never erase source records. Malformed or cyclic replacements fail closed. */
export function applyMemoryPolicies(entries: Entry[], observations: Observation[], reflections: Reflection[], end = entries.length - 1) {
  const all = new Map<string, Observation | Reflection>([...observations, ...reflections].map(r => [r.id, { ...r }]));
  const inactive = new Set<string>();
  for (let i = 0; i <= end; i++) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== OM_MEMORY_POLICY || !entry.data || typeof entry.data !== "object") continue;
    const p = entry.data as MemoryPolicy;
    const record = all.get(p.id);
    if (!record || inactive.has(p.id) || typeof p.reason !== "string" || !p.reason.trim()) continue;
    if (p.action === "pin") record.pinned = true;
    else if (p.action === "unpin") record.pinned = false;
    else if (p.action === "invalidate") inactive.add(p.id);
    else if (p.action === "supersede" && p.replacementId !== p.id && p.replacementId && all.has(p.replacementId) && !inactive.has(p.replacementId)) {
      const replacement = all.get(p.replacementId)!;
      if (record.pinned) replacement.pinned = true;
      inactive.add(p.id);
    }
  }
  // A distilled statement must not outlive an explicit correction of its
  // evidence. Ordinary drop tombstones are different: their replacement
  // reflection remains the active representation of the archived fact.
  for (const reflection of reflections) {
    if (reflection.supportingObservationIds.some(id => inactive.has(id))) inactive.add(reflection.id);
  }
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  const activeObservations = observations.filter(r => !inactive.has(r.id)).map(r => all.get(r.id) as Observation);
  const activeReflections = reflections.filter(r => !inactive.has(r.id)).map(r => {
    const reflection = all.get(r.id) as Reflection;
    const support = reflection.supportingObservationIds.map(id => all.get(id)).filter((v): v is Observation => !!v && "relevance" in v);
    const relevance = support.reduce<Observation["relevance"]>((best, o) => rank[o.relevance] > rank[best] ? o.relevance : best, "low");
    return { ...reflection, relevance };
  });
  return { observations: activeObservations, reflections: activeReflections, inactive };
}
