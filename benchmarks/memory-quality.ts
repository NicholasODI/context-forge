/** Offline synthetic fixture: no workers, provider calls, or user-state access. */
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { compile } from "../src/blackhole/src/core/summarize.js";
import { CONTINUITY_START, withContinuity } from "../src/blackhole/src/core/continuity.js";
import { buildCompactionProjection } from "../src/blackhole/src/om/ledger/projection.js";
import { foldLedger } from "../src/blackhole/src/om/ledger/fold.js";
import { recallMemorySources } from "../src/blackhole/src/om/ledger/recall.js";
import { renderSummary, observationRenderedTokens, reflectionToSummaryLine } from "../src/blackhole/src/om/ledger/render-summary.js";
import { maxDropCountForPool, selectDropCandidates } from "../src/blackhole/src/om/agents/dropper/selection.js";
import { estimateStringTokens } from "../src/blackhole/src/om/tokens.js";
import { isObservation, isReflection, type Entry, type Observation, type Reflection } from "../src/blackhole/src/om/ledger/types.js";
import { renderContinuity } from "../src/project-memory/continuity.js";
import { emptyMemory, renderReminder } from "../src/project-memory/store.js";

export const PROFILES = [
  { name: "tight-8k", window: 8192, observations: 400, reflections: 200 },
  { name: "local-32k", window: 32768, observations: 1000, reflections: 400 },
  { name: "local-131k", window: 131072, observations: 2000, reflections: 800 },
] as const;
const memoryId = (n: number) => n.toString(16).padStart(12, "0");
const logicalTime = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
export interface Probe { id: string; question: string; expected: string; exposed: boolean; forbidden?: string }

export function runMemoryProfile(profile: typeof PROFILES[number], cycles = 300) {
  const entries: (Entry & { parentId: string | null })[] = [];
  let sequence = 0, clock = 0;
  const append = (entry: Omit<Entry, "id">) => {
    const id = (++sequence).toString(16).padStart(8, "0");
    entries.push({ ...entry, id, parentId: entries.at(-1)?.id ?? null, timestamp: logicalTime(clock) });
    return id;
  };
  const addObservation = (id: number, content: string, relevance: Observation["relevance"] = "high") => {
    const source = append({ type: "message", message: { role: "user", content, timestamp: clock } });
    const observation: Observation = { id: memoryId(id), content, relevance, timestamp: logicalTime(clock), sourceEntryIds: [source], tokenCount: estimateStringTokens(content) };
    append({ type: "custom", customType: "om.observations.recorded", data: { coversUpToId: source, observations: [observation] } });
    return observation;
  };
  const setPolicy = (action: string, id: string, replacementId?: string) => append({ type: "custom", customType: "om.memory.policy", data: { action, id, replacementId, reason: "Synthetic user constraint/correction" } });
  addObservation(1, "Deployment port: 43179."); setPolicy("pin", memoryId(1));
  const checksum = addObservation(2, "Checksum invariant: OAK-731.", "critical"); setPolicy("pin", memoryId(2));
  // Real workers hash content in both namespaces: an exact copy can share an ID.
  append({ type: "custom", customType: "om.reflections.recorded", data: { coversUpToId: checksum.sourceEntryIds[0], reflections: [
    { id: checksum.id, content: checksum.content, supportingObservationIds: [checksum.id], tokenCount: checksum.tokenCount },
  ] } });
  addObservation(3, "Transport: TCP-OLD."); setPolicy("pin", memoryId(3));
  addObservation(5, "Historical retry budget: 17.", "low");
  const state = { ...emptyMemory(), revision: 1, task: {
    id: "task", text: "Implement observer reliability", status: "active" as const, progress: ["Reproduced the failure"],
    nextSteps: ["Inspect OLD-NEXT-ACTION"], blockers: ["Waiting on OLD-BLOCKER"], evidence: null, updatedAt: logicalTime(0),
  }, decisions: [{ id: "d-1", text: "Decision canary: retain source evidence EVIDENCE-552.", evidence: null, updatedAt: logicalTime(0), pinned: true }] };
  const freshness = new Map([["task", { status: "unverified" as const, reason: "synthetic note" }], ["d-1", { status: "unverified" as const, reason: "synthetic decision" }]]);
  const config = { observationsPoolMaxTokens: profile.observations, reflectionsPoolMaxTokens: profile.reflections, fullFoldAlways: true, taskQuery: state.task.text };
  let previousSummary = "", pinnedChecks = 0, pinnedHits = 0, correctedChecks = 0, correctedHits = 0, staleLeaks = 0;
  let budgetViolations = 0, prefixViolations = 0, staleActionLeaks = 0, maxSummaryTokens = 0, pruned = 0;
  let recordShapeViolations = 0, criticalTagViolations = 0;
  let finalSelected: string[] = [], finalSummary = "";
  for (let cycle = 1; cycle <= cycles; cycle++) {
    clock = cycle;
    if (cycle === 75) {
      addObservation(4, "Transport: UNIX-NEW.");
      setPolicy("supersede", memoryId(3), memoryId(4));
    }
    if (cycle === 150) {
      state.revision++;
      state.task.nextSteps = ["Run NEW-NEXT-ACTION-902"];
      state.task.blockers = [];
      state.task.updatedAt = logicalTime(cycle);
    }
    const obs: Observation[] = [];
    for (let j = 0; j < 3; j++) obs.push(addObservation(1000 + cycle * 3 + j, `Cycle ${cycle} detail ${j}: inspect component ${cycle}; preserve identifiers in the fixture.`, j ? "low" : "high"));
    const reflection: Reflection = { id: memoryId(100000 + cycle), content: `Cycle ${cycle}: component ${cycle} was inspected; fixture detail preserved.`, supportingObservationIds: obs.map(o => o.id), tokenCount: 20 };
    append({ type: "custom", customType: "om.reflections.recorded", data: { coversUpToId: obs.at(-1)!.sourceEntryIds[0], reflections: [reflection] } });
    if (cycle % 10 === 0) {
      // Synthetic worker proposals exercise the real deterministic safety/ranking.
      // This is not a test of whether an LLM judges equivalence correctly.
      const pool = foldLedger(entries);
      const poolTokens = pool.activeObservations.reduce((s, o) => s + observationRenderedTokens(o), 0);
      const maximum = maxDropCountForPool(pool.activeObservations, poolTokens, profile.observations, 0.1, profile.observations / 2);
      const ids = selectDropCandidates(pool.activeObservations.map(o => o.id), pool.activeObservations, maximum, pool.activeReflections, Math.max(0, poolTokens - profile.observations / 2));
      if (ids.length) {
        pruned += ids.length;
        append({ type: "custom", customType: "om.observations.dropped", data: {
          coversUpToId: obs.at(-1)!.sourceEntryIds[0], observationIds: ids,
          proofs: Object.fromEntries(ids.map(id => [id, { reason: "Synthetic replacement proposal", reflectionIds: pool.activeReflections.filter(r => r.supportingObservationIds.includes(id)).map(r => r.id) }])),
        } });
      }
    }
    const projection = buildCompactionProjection(entries, "", config);
    recordShapeViolations += projection.observations.filter(o => !isObservation(o)).length + projection.reflections.filter(r => !isReflection(r)).length;
    if (projection.observations.find(o => o.id === checksum.id)?.relevance !== "critical") criticalTagViolations++;
    const ids = new Set(projection.observations.map(o => o.id));
    for (const id of [memoryId(1), memoryId(2)]) { pinnedChecks++; if (ids.has(id)) pinnedHits++; }
    if (cycle >= 75) {
      correctedChecks++;
      if (ids.has(memoryId(4))) correctedHits++;
      if (ids.has(memoryId(3))) staleLeaks++;
    }
    const obsTokens = Math.max(0, projection.observations.reduce((s, o) => s + observationRenderedTokens(o), 0) - 1);
    const refTokens = Math.max(0, projection.reflections.reduce((s, r) => s + estimateStringTokens(reflectionToSummaryLine(r)) + 1, 0) - 1);
    if (obsTokens > profile.observations || refTokens > profile.reflections) budgetViolations++;
    const structural = compile({ messages: [{ role: "user", content: "Continue implementing observer reliability", timestamp: cycle }], previousSummary });
    const prefix = renderContinuity(state, freshness)!;
    finalSummary = withContinuity(`${structural}\n\n${renderSummary(projection.reflections, projection.observations)}`, prefix);
    if (finalSummary.split(CONTINUITY_START).length !== 2) prefixViolations++;
    if (cycle >= 150 && (finalSummary.includes("OLD-NEXT-ACTION") || finalSummary.includes("OLD-BLOCKER"))) staleActionLeaks++;
    maxSummaryTokens = Math.max(maxSummaryTokens, estimateStringTokens(finalSummary));
    append({ type: "compaction", summary: finalSummary, firstKeptEntryId: "", details: { "om.folded": projection.details }, data: undefined });
    previousSummary = finalSummary;
    finalSelected = [...projection.observations, ...projection.reflections].map(r => r.id);
  }
  const archive = [1, 2, 3, 4, 5].filter(n => n !== 4 || cycles >= 75).map(n => recallMemorySources(entries, memoryId(n)));
  const context = buildSessionContext(entries as any);
  const wire = convertToLlm(context.messages);
  const reminder = renderReminder(state, freshness);
  const visible = JSON.stringify(wire) + reminder;
  const questions: Omit<Probe, "exposed">[] = [
    { id: "port", question: "What is the deployment port?", expected: "43179" },
    { id: "checksum", question: "What is the checksum invariant identifier?", expected: "OAK-731" },
    { id: "transport", question: "Which transport is currently required?", expected: cycles >= 75 ? "UNIX-NEW" : "TCP-OLD", forbidden: cycles >= 75 ? "TCP-OLD" : undefined },
    { id: "retry", question: "What was the historical retry budget?", expected: "17" },
    { id: "next", question: "What is the next recorded action?", expected: cycles >= 150 ? "NEW-NEXT-ACTION-902" : "OLD-NEXT-ACTION" },
    { id: "decision", question: "Which source-evidence decision identifier must be retained?", expected: "EVIDENCE-552" },
  ];
  const probes: Probe[] = questions.map(q => ({ ...q, exposed: q.id === "retry" ? finalSelected.includes(memoryId(5)) : visible.includes(q.expected) }));
  return {
    profile: profile.name, fixtureVersion: 2, cycles, declaredWindow: profile.window,
    metrics: { pinnedHits, pinnedChecks, correctedHits, correctedChecks, staleLeaks, budgetViolations, prefixViolations, staleActionLeaks, recordShapeViolations, criticalTagViolations,
      archiveRecovered: archive.filter(r => r.status === "found" && !r.partial && r.sourceEntries.length).length, archiveChecks: archive.length,
      pruned, maxSummaryTokens, estimatedSummaryFitsWindow: maxSummaryTokens < profile.window,
      finalSelectedRecords: finalSelected.length, hostCompactionMessages: context.messages.filter(m => (m as any).role === "compactionSummary").length,
      exposedProbes: probes.filter(p => p.exposed).length, totalProbes: probes.length },
    probes,
    request: { profile: profile.name, messages: [...wire, { role: "user", content: `${reminder}\n\nOffline recall probe. Use only this context, no tools. Answer JSON with keys ${questions.map(q => q.id).join(", ")}. Use the exact value or "unknown" when absent.\n${questions.map(q => `${q.id}: ${q.question}`).join("\n")}` }] },
    modelRecall: { status: "not-run" as const },
  };
}

/** Exact canary scoring, not a semantic/factual evaluator. */
export function gradeAnswers(probes: Probe[], answers: unknown) {
  const data = answers && typeof answers === "object" && !Array.isArray(answers) ? answers as Record<string, unknown> : {};
  const rows = probes.map(p => {
    const answer = typeof data[p.id] === "string" ? data[p.id] as string : "";
    const exact = answer.trim().toLowerCase() === p.expected.toLowerCase();
    const contradicts = !!p.forbidden && answer.toLowerCase().includes(p.forbidden.toLowerCase());
    return { id: p.id, exposed: p.exposed, correct: exact && !contradicts, abstained: answer.trim().toLowerCase() === "unknown", contradicts };
  });
  return { exactCorrect: rows.filter(r => r.correct).length, total: rows.length,
    exposedCorrect: rows.filter(r => r.exposed && r.correct).length, exposedTotal: rows.filter(r => r.exposed).length,
    unexposedAbstentions: rows.filter(r => !r.exposed && r.abstained).length, rows };
}
