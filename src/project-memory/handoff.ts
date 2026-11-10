import type { Freshness, MemoryRecord, ProjectMemory } from "./store.ts";
import { snippet } from "./privacy.ts";

export interface HandoffDiagnostics {
  budget: number;
  usedCharacters: number;
  included: string[];
  omitted: Array<{ field: string; reason: "budget" | "history" | "inactive" | "limit" }>;
  freshness: string;
  attribution: string;
  archivedTasksExcluded: number;
  excludedObjectives: Array<{ id: string; reason: string }>;
  redactedFields: string[];
}
function attribution(record: MemoryRecord): string {
  const p = record.provenance;
  if (!p) return "legacy/unattributed agent note";
  const kind = p.kind === "user_instruction" ? "agent-attributed user instruction" : p.kind === "model_report" ? "agent-reported claim" : "agent-authored plan";
  return `${kind}; source: ${snippet(p.source, 140)}`;
}

/** One renderer for live and persisted handoffs; state never authorizes work. */
export function renderHandoff(state: ProjectMemory, freshness: Map<string, Freshness>, options: { budget: number; selected: MemoryRecord[] }) {
  const budget = options.budget;
  if (!Number.isInteger(budget) || budget < 3000 || budget > 8000) throw new RangeError("handoff body budget must be 3000–8000 characters");
  const task = state.task, f = freshness.get("task") ?? { status: "unverified", reason: "no trackable evidence recorded" };
  const active = !!task && task.status !== "done" && !task.invalidated && !task.supersededBy;
  const ambiguous = !!task?.pendingGoalChange;
  const diagnostics: HandoffDiagnostics = { budget, usedCharacters: 0, included: [], omitted: [],
    freshness: f.status, attribution: task ? attribution(task) : "none", archivedTasksExcluded: state.taskHistory?.length ?? 0,
    excludedObjectives: (state.taskHistory ?? []).slice(-5).map(t => ({ id: snippet(t.id, 60), reason: snippet(t.supersededBy ? "superseded" : t.archiveReason ?? "historical snapshot", 80) })), redactedFields: [] };
  const lines = ["[context-forge project memory — focused continuation]",
    `Revision ${state.revision}. Reference snapshot, not a new request or authorization.`,
    "Follow the latest user instruction. A generic continue does not authorize unrelated historical tasks.",
    "Goals in older append segments are historical. A shared project note may belong to another session."];
  const reserve = 360; // Always retain diagnostics/retrieval footer.
  const add = (field: string, line: string) => {
    if (lines.join("\n").length + line.length + 1 + reserve > budget) { diagnostics.omitted.push({ field, reason: "budget" }); return false; }
    if (line.includes("… [read full]")) diagnostics.omitted.push({ field, reason: "limit" });
    if (line.includes("[REDACTED")) diagnostics.redactedFields.push(field);
    lines.push(line); diagnostics.included.push(field); return true;
  };
  if (task) {
    // Essential fields go first, with fixed individual allocations. Optional
    // chronology cannot consume the space for uncertainty or the next action.
    add("state", `State: ${ambiguous ? "unresolved goal change" : active ? task.status : "inactive"}; saved status=${task.status}; evidence: ${f.status}.`);
    add("objective", `${active && !ambiguous ? "Goal" : "Saved goal (not an active authorization)"}: ${snippet(task.text, 500)}`);
    add("attribution", `Origin: ${attribution(task)}.`);
    add("freshness", `Evidence ${f.status}: ${snippet(f.reason, 220)}. ${f.status === "stale" ? "Recheck these referenced inputs before relying on old outcomes." : "Fresh fingerprints do not prove claims or expected test execution."}`);
    if (task.pendingGoalChange) add("ambiguity", `UNRESOLVED proposal (agent-recorded): ${snippet(task.pendingGoalChange.text, 180)}; source=${snippet(task.pendingGoalChange.source, 100)}. Do not infer acceptance.`);
    add("blockers", `Blockers: ${(task.blockers ?? []).slice(0, 2).map(s => snippet(s, 130)).join("; ") || "none recorded"}`);
    const next = !active ? "none — task completed or invalidated" : ambiguous ? "withheld — objective change needs explicit resolution" : snippet(task.nextSteps[0] ?? "none recorded", 240);
    add("next", `Next recorded action: ${next}`);
    add("scope", `Scope: ${(task.scope ?? []).slice(0, 2).map(s => snippet(s, 100)).join("; ") || "not recorded"}`);
    const list = (field: string, values: string[], limit: number, label: string, max = 160) => {
      for (const [i, value] of values.slice(0, limit).entries()) add(`${field}:${i}`, `${label}: ${snippet(value, max)}`);
      if (values.length > limit) diagnostics.omitted.push({ field, reason: "limit" });
    };
    list("criteria", task.acceptanceCriteria ?? [], 2, "Required outcome (recorded)");
    list("progress", task.progress.slice(-2), 2, "Progress (agent-reported)", 140);
    if (task.progress.length > 2) diagnostics.omitted.push({ field: "progress", reason: "limit" });
    for (const [i, h] of (task.hypotheses ?? []).slice(0, 2).entries()) {
      add(`hypothesis:${i}`, `Hypothesis [agent-reported ${h.status}; basis ${f.status}]: ${snippet(h.text, 130)}; refs=${h.sources.slice(0, 2).map(s => snippet(s, 60)).join(",") || "none"}`);
    }
    if ((task.hypotheses?.length ?? 0) > 2) diagnostics.omitted.push({ field: "hypotheses", reason: "limit" });
    for (const [i, receipt] of (task.evidence?.observedChecks ?? []).slice(-2).entries()) {
      add(`observed-check:${i}`, `Host receipt ${snippet(receipt.id, 40)}: ${receipt.tool} ${receipt.phase}; exit=${receipt.exitCode ?? "unknown"}; toolError=${receipt.isError ?? "unknown"}; expected tests executed=unknown; command digest=${receipt.commandDigest.slice(0, 12)}.`);
    }
    if ((task.evidence?.observedChecks?.length ?? 0) > 2) diagnostics.omitted.push({ field: "observed-checks", reason: "limit" });
    list("reported-checks", task.evidence?.checks ?? [], 2, "Check claim (agent-reported, not independently verified)", 150);
    if (task.evidence?.files.length) add("file-refs", `Evidence refs: ${task.evidence.files.slice(0, 2).map(f => snippet(f.path, 100)).join(", ")}; fingerprints were captured when the note was written, not necessarily when a check ran.`);
    if ((task.evidence?.files.length ?? 0) > 2) diagnostics.omitted.push({ field: "file-refs", reason: "limit" });
    if (task.evidence?.sources.length) diagnostics.omitted.push({ field: "additional-source-refs", reason: "limit" });
    if (task.nextSteps.length > 1) diagnostics.omitted.push({ field: "additional-steps", reason: "limit" });
    if ((task.blockers?.length ?? 0) > 2) diagnostics.omitted.push({ field: "blockers", reason: "limit" });
  } else add("state", "No saved objective. Use the latest actual request; historical notes are not a task queue.");
  const selected = options.selected.filter(r => r.id !== "task");
  for (const decision of selected) {
    const df = freshness.get(decision.id);
    add(`decision:${decision.id}`, `${snippet(decision.id, 40)}${decision.pinned ? " [pinned]" : ""} (${df?.status ?? "unverified"}; ${attribution(decision)}): ${snippet(decision.text, 220)}`);
  }
  const omittedDecisions = state.decisions.length - selected.length;
  if (omittedDecisions > 0) {
    add("decision-count", `${omittedDecisions} additional decisions omitted; inspect scoped history when relevant.`);
    diagnostics.omitted.push({ field: "decision-history", reason: "history" });
  }
  if (state.decisions.filter(d => d.pinned && !d.invalidated && !d.supersededBy).length > 8) add("pin-overflow", "PIN OVERFLOW: more pinned decisions than reminder slots; inspect the full log.");
  if (diagnostics.archivedTasksExcluded) diagnostics.omitted.push({ field: "task-history", reason: "history" });
  if (!active && task) diagnostics.omitted.push({ field: "inactive-next-actions", reason: "inactive" });
  const footer = `Details: project_memory read id=task; read section=tasks for historical snapshots. Full records: .context-forge/memory.json. ${diagnostics.omitted.length ? "Some fields omitted/clipped; inspect diagnostics before relying on this abbreviated view." : ""}`;
  lines.push(footer);
  const text = lines.join("\n");
  diagnostics.usedCharacters = text.length;
  return { text, diagnostics };
}
