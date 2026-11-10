import { CONTINUITY_END, CONTINUITY_START, type ContinuityBlock } from "../blackhole/src/core/continuity.ts";
import { reminderRecords, type Freshness, type ProjectMemory } from "./store.ts";
import { renderHandoff } from "./handoff.ts";
import { snippet } from "./privacy.ts";

/** Exactly the same working state drives the live and persisted handoffs. */
export function renderContinuity(state: ProjectMemory, freshness: Map<string, Freshness>): ContinuityBlock | undefined {
  const task = state.task;
  if (!task) return undefined;
  const handoff = renderHandoff(state, freshness, { budget: 3000, selected: reminderRecords(state) });
  const text = [CONTINUITY_START, "[Resume Context — saved project task]", handoff.text, CONTINUITY_END].join("\n");
  const active = task.status !== "done" && !task.invalidated && !task.supersededBy && !task.pendingGoalChange;
  return { version: 1, text, revision: state.revision, taskUpdatedAt: task.updatedAt, status: task.status,
    freshness: freshness.get("task")?.status ?? "unverified",
    focus: { objective: snippet(task.text, 650), active, reason: task.pendingGoalChange ? "unresolved goal change" : task.invalidated ? "invalidated" : task.supersededBy ? "superseded" : task.status },
    diagnostics: { ...handoff.diagnostics, bodyBudget: 3000, budget: 3200, usedCharacters: text.length },
  };
}
