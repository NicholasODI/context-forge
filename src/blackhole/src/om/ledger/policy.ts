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
  // Content hashes are stable within each kind, but may be shared across kinds.
  // Never let a reflection overwrite an observation's fields (or vice versa).
  const observationById = new Map(observations.map(r => [r.id, { ...r }]));
  const reflectionById = new Map(reflections.map(r => [r.id, { ...r }]));
  const recordsForId = (id: string): Array<Observation | Reflection> => {
    const records: Array<Observation | Reflection> = [];
    const o = observationById.get(id), r = reflectionById.get(id);
    if (o) records.push(o);
    if (r) records.push(r);
    return records;
  };
  // Existing policy events are ID-scoped and apply to both matching kinds.
  // Preserve that behavior without aliasing their record objects.
  const explicitlyInactive = new Set<string>();
  for (let i = 0; i <= end; i++) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== OM_MEMORY_POLICY || !entry.data || typeof entry.data !== "object") continue;
    const p = entry.data as MemoryPolicy;
    const records = recordsForId(p.id);
    if (!records.length || explicitlyInactive.has(p.id) || typeof p.reason !== "string" || !p.reason.trim()) continue;
    if (p.action === "pin" || p.action === "unpin") {
      for (const record of records) record.pinned = p.action === "pin";
    } else if (p.action === "invalidate") explicitlyInactive.add(p.id);
    else if (p.action === "supersede" && p.replacementId !== p.id && p.replacementId &&
        recordsForId(p.replacementId).length && !explicitlyInactive.has(p.replacementId)) {
      if (records.some(r => r.pinned)) for (const replacement of recordsForId(p.replacementId)) replacement.pinned = true;
      explicitlyInactive.add(p.id);
    }
  }
  const inactiveObservationIds = new Set([...observationById.keys()].filter(id => explicitlyInactive.has(id)));
  const inactiveReflectionIds = new Set([...reflectionById.keys()].filter(id => explicitlyInactive.has(id)));
  // Derived invalidation belongs to the reflection namespace only. A different
  // observation with the same content hash must not be invalidated by accident.
  for (const reflection of reflections) {
    if (reflection.supportingObservationIds.some(id => inactiveObservationIds.has(id))) inactiveReflectionIds.add(reflection.id);
  }
  const rank = { low: 0, medium: 1, high: 2, critical: 3 };
  const activeObservations = observations.filter(r => !inactiveObservationIds.has(r.id)).map(r => observationById.get(r.id)!);
  const activeReflections = reflections.filter(r => !inactiveReflectionIds.has(r.id)).map(r => {
    const reflection = reflectionById.get(r.id)!;
    const relevance = reflection.supportingObservationIds.reduce<Observation["relevance"]>((best, id) => {
      const support = observationById.get(id);
      return support && rank[support.relevance] > rank[best] ? support.relevance : best;
    }, "low");
    return { ...reflection, relevance };
  });
  return { observations: activeObservations, reflections: activeReflections,
    inactiveObservationIds, inactiveReflectionIds };
}
