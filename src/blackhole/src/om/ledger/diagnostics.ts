import { foldLedger } from "./fold.js";
import { applyMemoryPolicies } from "./policy.js";
import { buildCompactionProjection, type CompactionProjectionConfig } from "./projection.js";
import { observationRenderedTokens, observationToSummaryLine, reflectionToSummaryLine } from "./render-summary.js";
import { isMemoryDetails, isObservationsDroppedEntry, type Entry, type Observation, type Reflection } from "./types.js";
import { estimateStringTokens } from "../tokens.js";
import { CONTINUITY_START } from "../../core/continuity.js";
import type { PipelineCursors } from "../runtime.js";

export const OM_SELECTION = "om.selection";
export interface SelectionSnapshot {
  version: 1;
  config: CompactionProjectionConfig;
  reviewedThrough: PipelineCursors;
}
export interface ContextObservation {
  sessionId: string;
  compactionId: string;
  observedAt: string;
  observationIds: string[];
  reflectionIds: string[];
  continuityPresent: boolean;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const latest = (entries: Entry[]) => {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "compaction") return i;
  return -1;
};
const detailsOf = (entry: Entry) => object(entry.details) ? entry.details : {};
const lineFor = (record: Observation | Reflection) => "sourceEntryIds" in record ? observationToSummaryLine(record) : reflectionToSummaryLine(record);
const recordKey = (record: Observation | Reflection) => `${"sourceEntryIds" in record ? "observation" : "reflection"}:${record.id}`;
const costFor = (record: Observation | Reflection) => "sourceEntryIds" in record ? observationRenderedTokens(record) : estimateStringTokens(reflectionToSummaryLine(record)) + 1;

/** Content observed at the extension hook, not a provider-wire receipt. */
export function observeMemoryContext(messages: any[], entries: Entry[], sessionId: string): ContextObservation | undefined {
  const entry = entries[latest(entries)];
  if (!entry) return undefined;
  const folded = detailsOf(entry)["om.folded"];
  const texts = messages.flatMap(m => m?.role === "compactionSummary" && typeof m.summary === "string" ? [m.summary] :
    m?.role === "custom" && m.customType === "blackhole-compaction-tail" && typeof m.content === "string" ? [m.content] : []);
  if (texts.length === 0) return undefined; // unknown host shape is not proof of missing memory
  const framed = `\n${texts.join("\n")}\n`;
  const contains = (r: Observation | Reflection) => framed.includes(`\n${lineFor(r)}\n`);
  return {
    sessionId, compactionId: entry.id, observedAt: new Date().toISOString(),
    observationIds: isMemoryDetails(folded) ? folded.observations.filter(contains).map(o => o.id) : [],
    reflectionIds: isMemoryDetails(folded) ? folded.reflections.filter(contains).map(r => r.id) : [],
    continuityPresent: texts.some(t => t.includes(CONTINUITY_START)),
  };
}

export type SelectionReason = "included" | "budget" | "outside-boundary" | "dropped" | "policy-inactive" | "after-snapshot" | "unknown";
export interface DiagnosticRow {
  id: string;
  kind: "observation" | "reflection";
  reason: SelectionReason;
  estimatedTokens: number;
  pinned: boolean;
  importance: string;
  currentActive: boolean;
  dropEntry?: { id: string; timestamp: string | null; proof: { reflectionIds: string[]; reason: string } | null };
  contextObserved: boolean | null;
}

/** Reconstruct decisions against the historical branch/config, never today's settings. */
export function memoryDiagnostics(entries: Entry[], context?: ContextObservation, sessionId?: string) {
  const idx = latest(entries), checkpoint = entries[idx];
  const current = foldLedger(entries);
  const currentIds = new Set([...current.activeObservations, ...current.activeReflections].map(recordKey));
  const before = idx >= 0 ? entries.slice(0, idx) : [];
  const atFold = foldLedger(before);
  const details = checkpoint ? detailsOf(checkpoint) : {};
  const folded = details["om.folded"];
  const selected = isMemoryDetails(folded) ? [...folded.observations, ...folded.reflections] : [];
  const selectedIds = new Set(selected.map(recordKey));
  const selectedById = new Map(selected.map(r => [recordKey(r), r]));
  const beforeIds = new Set([...atFold.observations, ...atFold.reflections].map(recordKey));
  const policy = applyMemoryPolicies(before, atFold.observations, atFold.reflections);
  const atSnapshotById = new Map([...policy.observations, ...policy.reflections].map(r => [recordKey(r), r]));
  const snapshot = details[OM_SELECTION];
  let candidates: Set<string> | undefined;
  let reconstruction: "available" | "legacy-or-unavailable" = "legacy-or-unavailable";
  if (checkpoint && object(snapshot) && snapshot.version === 1 && object(snapshot.config) &&
      typeof snapshot.config.observationsPoolMaxTokens === "number") {
    try {
      const projection = buildCompactionProjection(before, checkpoint.firstKeptEntryId ?? "", snapshot.config as unknown as CompactionProjectionConfig);
      // A missing fork anchor or changed format must not invent exclusion reasons.
      const rebuilt = [...projection.observations, ...projection.reflections].map(recordKey);
      if (rebuilt.length === selectedIds.size && rebuilt.every(id => selectedIds.has(id))) {
        candidates = new Set([...projection.candidates.observations, ...projection.candidates.reflections].map(recordKey));
        reconstruction = "available";
      }
    } catch { /* Legacy/partial checkpoints remain inspectable without fabricated reasons. */ }
  }
  const observed = context && checkpoint?.id === context.compactionId && sessionId === context.sessionId ? context : undefined;
  const observedIds = observed ? new Set([
    ...observed.observationIds.map(id => `observation:${id}`), ...observed.reflectionIds.map(id => `reflection:${id}`),
  ]) : undefined;
  const dropEntries = new Map<string, NonNullable<DiagnosticRow["dropEntry"]>>();
  for (const entry of entries) {
    if (!isObservationsDroppedEntry(entry)) continue;
    for (const id of entry.data.observationIds) {
      if (dropEntries.has(id)) continue;
      const raw = entry.data.proofs?.[id];
      const proof = raw && typeof raw.reason === "string" && Array.isArray(raw.reflectionIds) && raw.reflectionIds.every(v => typeof v === "string")
        ? { reflectionIds: raw.reflectionIds, reason: raw.reason } : null;
      dropEntries.set(id, { id: entry.id, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null, proof });
    }
  }
  const rows: DiagnosticRow[] = [...current.observations, ...current.reflections].map(record => {
    const key = recordKey(record), isObservation = "sourceEntryIds" in record;
    let reason: SelectionReason = "unknown";
    if (selectedIds.has(key)) reason = "included";
    else if (idx < 0 || !beforeIds.has(key)) reason = "after-snapshot";
    else if ((isObservation ? policy.inactiveObservationIds : policy.inactiveReflectionIds).has(record.id)) reason = "policy-inactive";
    else if (isObservation && atFold.droppedObservationIds.has(record.id)) reason = "dropped";
    else if (candidates) reason = candidates.has(key) ? "budget" : "outside-boundary";
    const rendered = selectedById.get(key) ?? atSnapshotById.get(key) ?? record;
    return { id: record.id, kind: "sourceEntryIds" in record ? "observation" : "reflection", reason,
      estimatedTokens: costFor(rendered), pinned: rendered.pinned ?? false, importance: rendered.relevance ?? "unknown",
      ...(isObservation && dropEntries.has(record.id) ? { dropEntry: dropEntries.get(record.id)! } : {}),
      currentActive: currentIds.has(key), contextObserved: observedIds ? observedIds.has(key) : null };
  });
  const counts = Object.fromEntries(["included", "budget", "outside-boundary", "dropped", "policy-inactive", "after-snapshot", "unknown"].map(reason => [reason, rows.filter(r => r.reason === reason).length]));
  return {
    compactionId: checkpoint?.id ?? null, compactionTimestamp: checkpoint?.timestamp ?? null,
    reconstruction, counts, rows,
    criticalDropMarkers: rows.filter(r => r.kind === "observation" && r.importance === "critical" && r.dropEntry).length,
    estimatedSelectedTokens: selected.reduce((sum, r) => sum + costFor(r), 0),
    reviewedThrough: object(snapshot) && object(snapshot.reviewedThrough) ? snapshot.reviewedThrough as PipelineCursors : {},
    context: observed ?? null,
    continuity: details["context-forge.continuity"] ?? null,
  };
}

export function renderMemoryDiagnostics(report: ReturnType<typeof memoryDiagnostics>, offset = 0, limit = 10, id?: string): string {
  const filtered = id ? report.rows.filter(r => r.id.toLowerCase() === id.toLowerCase()) : report.rows;
  const rows = filtered.slice(offset, offset + limit);
  const cursors = Object.entries(report.reviewedThrough).map(([stage, c]) => `${stage}: ${c.state}@${c.entryId}; completed ${c.completedAt ?? "unknown (legacy cursor)"}`);
  return [
    "── Memory use diagnostics ──",
    `Latest summary: ${report.compactionId ?? "none"}; reconstruction: ${report.reconstruction}`,
    `Selection counts: ${Object.entries(report.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `Selected records: ~${report.estimatedSelectedTokens.toLocaleString()} rendered tokens (headers/footer extra).`,
    `Continuity snapshot: ${report.continuity ? JSON.stringify(report.continuity) : "none"}`,
    `Critical observations with persisted drop markers: ${report.criticalDropMarkers}; inspect marker provenance before attributing these to the current worker.`,
    "Worker stage completion / coverage at this compaction (may include no-op checks; not factual verification):",
    ...cursors,
    report.context ? `Extension context observed ${report.context.observedAt}: ${report.context.observationIds.length} observations, ${report.context.reflectionIds.length} reflections; continuity=${report.context.continuityPresent}.` : "Extension context observation: unavailable for this summary/session.",
    "Context-hook evidence is not a provider-wire receipt or proof of model attention.",
    `Records ${offset + (rows.length ? 1 : 0)}–${offset + rows.length} of ${filtered.length}${id ? ` matching id:${id}` : ""}; snapshot reason / importance / ~tokens / current active / observed at hook:`,
    ...rows.map(r => `${r.id} ${r.kind}${r.pinned ? " [pinned]" : ""}: ${r.reason} / ${r.importance} / ~${r.estimatedTokens} / ${r.currentActive} / ${r.contextObserved ?? "unknown"}`),
    ...rows.filter(r => r.dropEntry).map(r => {
      const drop = r.dropEntry!;
      const proof = drop.proof ? `replacement refs=${drop.proof.reflectionIds.slice(0, 8).join(",")}; reason=${drop.proof.reason.replace(/\s+/g, " ").slice(0, 180)}` : "replacement proof unavailable (legacy/unrecorded)";
      return `${r.id} drop marker: ${drop.id}; written ${drop.timestamp ?? "unknown"}; ${proof}`;
    }),
    ...(offset + limit < filtered.length ? [`Next: /blackhole-memory diagnostics${id ? ` id:${id}` : ""} offset:${offset + limit} limit:${limit}`] : []),
    "Sources stay recallable. Coverage anchors identify source positions, not when a claim was reverified.",
  ].join("\n");
}
