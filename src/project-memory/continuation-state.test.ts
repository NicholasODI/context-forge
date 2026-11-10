import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessFreshness, readMemory, updateMemory, refreshDocuments, memoryView, reminderRecords, type ProjectMemory } from "./store";
import { renderHandoff } from "./handoff";
import { renderContinuity } from "./continuity";
import { withContinuity } from "../blackhole/src/core/continuity";
import { extractSection } from "../blackhole/src/core/summarize";

const failure = vi.hoisted(() => ({ jsonRename: false }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: string, to: string) => {
    if (failure.jsonRename && to.endsWith("memory.json")) throw new Error("synthetic source commit interrupted");
    return fs.rename(from, to);
  } };
});
const exec = promisify(execFile);
let root: string;
beforeEach(async () => { failure.jsonRename = false; root = await mkdtemp(join(tmpdir(), "forge-continuation-state-")); });
afterEach(async () => { failure.jsonRename = false; await rm(root, { recursive: true, force: true }); });
const task = (revision: number, text = "Current objective") => ({ action: "set_task" as const, expectedRevision: revision, text, nextSteps: ["Run the focused regression"] });
const legacy = (): ProjectMemory => ({ version: 1, revision: 7, task: { id: "task", text: "Legacy objective", status: "active", progress: [], nextSteps: ["Old step"], evidence: null, updatedAt: "2026-01-01T00:00:00Z" }, decisions: [] });

describe("focused continuation lifecycle", () => {
  it("reads v1 without writes and upgrades only on an explicit revision-checked mutation", async () => {
    await mkdir(join(root, ".context-forge"));
    const source = JSON.stringify(legacy());
    await writeFile(join(root, ".context-forge/memory.json"), source);
    expect((await readMemory(root))?.version).toBe(1);
    expect(await readFile(join(root, ".context-forge/memory.json"), "utf8")).toBe(source);
    const updated = await updateMemory(root, { action: "update_task", expectedRevision: 7, progress: ["Found the cause"] }, "synthetic");
    expect(updated.version).toBe(2);
    expect(updated.task?.taskId).toBe("legacy-task-7");
    expect(updated.taskHistory?.[0].text).toBe("Legacy objective");
    expect((await readMemory(root))?.revision).toBe(8);
    expect(JSON.parse(await memoryView(root, updated, { id: updated.task!.taskId })).records[0].progress).toEqual(["Found the cause"]);
    const history = JSON.parse(await memoryView(root, updated, { section: "tasks" }));
    expect(history.totalTaskSnapshots).toBe(1);
    expect(history.records[0].archiveReason).toBe("updated");
  });
  it("keeps completed/superseded objectives and their decisions out of active goals while retaining history", async () => {
    await updateMemory(root, task(0, "Old objective"), "a");
    await updateMemory(root, { action: "record_decision", expectedRevision: 1, text: "Old task-specific interpretation" }, "a");
    await updateMemory(root, { action: "complete_task", expectedRevision: 2 }, "a");
    const current = await updateMemory(root, { action: "supersede", id: "task", expectedRevision: 3, text: "New objective", acceptanceCriteria: ["Focused tests pass"], nextSteps: ["Inspect the new fixture"], provenance: { kind: "user_instruction", source: "user entry:new-task" } }, "b");
    const handoff = renderHandoff(current, await assessFreshness(root, current), { budget: 3000, selected: reminderRecords(current) });
    expect(handoff.text).toContain("New objective");
    expect(handoff.text).not.toContain("Old objective");
    expect(handoff.text).not.toContain("Old task-specific interpretation");
    expect(handoff.text).toContain("agent-attributed user instruction");
    expect(current.taskHistory?.some(t => t.status === "done")).toBe(true);
    const old = current.taskHistory!.find(t => t.text === "Old objective")!;
    expect(JSON.parse(await memoryView(root, current, { id: old.id })).records[0].text).toBe("Old objective");
    const summary = withContinuity("[Session Goal]\n- stop\n- finish old task\n- continue\n\n[Files And Changes]\n- old.ts\n\n---\n\nHistoric brief", renderContinuity(current, new Map()));
    expect(extractSection(summary, "Session Goal")).toContain("New objective");
    expect(extractSection(summary, "Session Goal")).not.toMatch(/finish old task|stop|continue/);
    expect(summary).toContain("Historic brief");
  });
  it("keeps ambiguous goal changes explicit and requires a reason to clear them", async () => {
    await updateMemory(root, task(0), "a");
    const ambiguous = await updateMemory(root, { action: "update_task", expectedRevision: 1, pendingGoalChange: { text: "Possibly switch objectives", source: "ambiguous user entry" } }, "a");
    const block = renderContinuity(ambiguous, new Map())!;
    expect(block.focus?.active).toBe(false);
    expect(block.text).toContain("UNRESOLVED");
    expect(block.text).toContain("Next recorded action: withheld");
    expect(block.text).not.toContain("Run the focused regression");
    await expect(updateMemory(root, { action: "update_task", expectedRevision: 2, pendingGoalChange: null }, "a")).rejects.toThrow("requires a reason");
    const resolved = await updateMemory(root, { action: "update_task", expectedRevision: 2, pendingGoalChange: null, reason: "User clarified entry:confirmed" }, "a");
    expect(resolved.task?.lastChange?.reason).toContain("entry:confirmed");
    await updateMemory(root, { action: "complete_task", expectedRevision: 3 }, "a");
    await expect(updateMemory(root, { action: "update_task", expectedRevision: 4, status: "active" }, "a")).rejects.toThrow("cannot reactivate");
  });
  it("keeps migration source authoritative if the final atomic source write is interrupted", async () => {
    await mkdir(join(root, ".context-forge"));
    const source = JSON.stringify(legacy());
    await writeFile(join(root, ".context-forge/memory.json"), source);
    failure.jsonRename = true;
    await expect(updateMemory(root, task(7, "New objective"), "a")).rejects.toThrow("interrupted");
    expect(await readFile(join(root, ".context-forge/memory.json"), "utf8")).toBe(source);
    failure.jsonRename = false;
    await refreshDocuments(root);
    expect(await readFile(join(root, ".context-forge/TASK.md"), "utf8")).toContain("Legacy objective");
    expect((await readMemory(root))?.version).toBe(1);
  });
  it("protects task history during concurrent updates", async () => {
    await updateMemory(root, task(0), "a");
    const outcomes = await Promise.allSettled(["a", "b"].map(session => updateMemory(root, { action: "update_task", expectedRevision: 1, progress: [session] }, session)));
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await readMemory(root))?.taskHistory).toHaveLength(1);
  });
  it("does not invalidate file-scoped evidence for unrelated tracked changes", async () => {
    await exec("git", ["init", root]);
    await writeFile(join(root, "related.ts"), "v1"); await writeFile(join(root, "other.ts"), "v1");
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
    const state = await updateMemory(root, { ...task(0), files: ["related.ts"], checks: ["model reports focused check completed"] }, "a");
    await writeFile(join(root, "other.ts"), "v2");
    expect((await assessFreshness(root, state)).get("task")?.status).toBe("current");
    await writeFile(join(root, "related.ts"), "v2");
    expect((await assessFreshness(root, state)).get("task")?.status).toBe("stale");
    expect(renderContinuity(state, await assessFreshness(root, state))!.text).toContain("Recheck these referenced inputs");
  });
  it("rejects secret-like writes and redacts legacy notes without persisting command/output contents", async () => {
    await expect(updateMemory(root, { ...task(0), checks: ["api_key=PRIVATE_TEST_VALUE"] }, "a")).rejects.toThrow("secret-like");
    const state = legacy(); state.task!.text = "Repair endpoint password=PRIVATE_TEST_VALUE";
    const block = renderContinuity(state, new Map())!;
    expect(block.text).not.toContain("PRIVATE_TEST_VALUE");
    expect(block.text).toContain("[REDACTED]");
    expect(block.diagnostics?.redactedFields).toContain("objective");
  });
  it("preserves essential state and uncertainty under pressure from large histories", () => {
    const state = legacy();
    state.task!.text = "ESSENTIAL_OBJECTIVE " + "x".repeat(1800);
    state.task!.blockers = ["ESSENTIAL_BLOCKER " + "x".repeat(1800)];
    state.task!.nextSteps = ["ESSENTIAL_NEXT " + "x".repeat(1800), "Other step"];
    state.task!.hypotheses = [{ text: "Potential cause", status: "ruled_out", sources: ["model-report:old-test"] }];
    state.decisions = Array.from({ length: 1000 }, (_, n) => ({ id: `d-${n}`, text: "Old decision ".repeat(100), updatedAt: "2026-01-01", evidence: null }));
    const block = renderContinuity(state, new Map([["task", { status: "stale", reason: "Changed related.ts" }]]))!;
    expect(block.text.length).toBeLessThanOrEqual(3200);
    expect(block.text).toContain("ESSENTIAL_OBJECTIVE"); expect(block.text).toContain("ESSENTIAL_BLOCKER"); expect(block.text).toContain("ESSENTIAL_NEXT");
    expect(block.text).toContain("stale");
    expect(block.diagnostics?.archivedTasksExcluded).toBe(0);
    expect((block.diagnostics?.omitted as unknown[]).length).toBeGreaterThan(0);
  });
  it("reserves essentials even when attribution, ambiguity, freshness and blockers are all long", () => {
    const state = legacy();
    state.task!.text = "objective ".repeat(200);
    state.task!.blockers = ["blocker ".repeat(200), "blocker ".repeat(200)];
    state.task!.provenance = { kind: "user_instruction", source: "source ".repeat(200) };
    state.task!.pendingGoalChange = { text: "proposal ".repeat(200), source: "source ".repeat(200) };
    const block = renderContinuity(state, new Map([["task", { status: "stale", reason: "reason ".repeat(200) }]]))!;
    expect(block.text.length).toBeLessThanOrEqual(3200);
    expect(block.diagnostics?.included).toEqual(expect.arrayContaining(["objective", "ambiguity", "freshness", "blockers", "next"]));
    expect(block.text).toContain("Next recorded action: withheld");
  });
});
