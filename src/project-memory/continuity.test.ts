import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { registerProjectMemory } from "./index";
import { renderContinuity } from "./continuity";
import { emptyMemory, renderReminder, type ProjectMemory } from "./store";
import { CONTINUITY_START, CONTINUITY_END, stripContinuity, withContinuity } from "../blackhole/src/core/continuity";
import { compile } from "../blackhole/src/core/summarize";
import { registerBeforeCompactHook } from "../blackhole/src/hooks/before-compact";
import { projectAppendOnlyContext } from "../blackhole/src/core/compaction-chain";
import { Runtime } from "../blackhole/src/om/runtime";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "forge-continuity-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const state = (): ProjectMemory => ({ ...emptyMemory(), revision: 1, task: {
  id: "task", text: "Repair observer resume handling", updatedAt: "2026-11-01T00:00:00Z", evidence: null,
  status: "blocked", progress: ["Reproduced the problem"], nextSteps: ["Inspect the generation guard"], blockers: ["Need the host callback order"],
} });

describe("deterministic continuity", () => {
  it("renders goal, blocker, next action and freshness without inventing a task", () => {
    expect(renderContinuity(emptyMemory(), new Map())).toBeUndefined();
    const block = renderContinuity(state(), new Map([["task", { status: "stale", reason: "file changed" }]]))!;
    expect(block.text).toContain("evidence: stale");
    expect(block.text).toContain("Need the host callback order");
    expect(block.text).toContain("Next recorded action: Inspect the generation guard");
    expect(block.text).toContain("not a new request");
    expect(renderContinuity(state(), new Map([["task", { status: "stale", reason: "file changed" }]]))).toEqual(block);
  });
  it("bounds long fields and keeps one replaceable prefix across repeated compactions", () => {
    const s = state();
    s.task!.text = "x".repeat(2000);
    s.task!.blockers = Array(32).fill("y".repeat(2000));
    const block = renderContinuity(s, new Map())!;
    expect(block.text.length).toBeLessThanOrEqual(3200);
    let summary = "[Session Goal]\nRepair the observer";
    for (let n = 0; n < 300; n++) summary = withContinuity(summary, block);
    expect(summary.split(CONTINUITY_START)).toHaveLength(2);
    expect(stripContinuity(summary)).toBe("[Session Goal]\nRepair the observer");
    const compiled = compile({ messages: [{ role: "user", content: "Continue checking", timestamp: 1 }], previousSummary: summary });
    expect(compiled).not.toContain(CONTINUITY_START);
    expect(compiled).not.toContain("xxxxxx");
    const quoted = `const start = "${CONTINUITY_START}"; const end = "${CONTINUITY_END}";`;
    expect(stripContinuity(quoted)).toBe(quoted);
  });
  it.each(["done", "invalidated"])("does not advertise next actions for a %s task", mode => {
    const s = state();
    if (mode === "done") s.task!.status = "done"; else s.task!.invalidated = "User cancelled";
    expect(renderContinuity(s, new Map())!.text).not.toContain("Inspect the generation guard");
    expect(renderReminder(s, new Map())).not.toContain("Next:");
    expect(s.task!.nextSteps).toEqual(["Inspect the generation guard"]); // retained as history
  });
  it("respects trust/disable gates and rechecks changed evidence through the registered loader", async () => {
    let tool: any;
    const pi: any = { registerTool: (t: any) => { tool = t; }, registerCommand: vi.fn(), on: vi.fn() };
    const ctx: any = { cwd: root, isProjectTrusted: () => true, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => "synthetic" } };
    let enabled = true;
    const registration = registerProjectMemory(pi, () => enabled);
    expect(await registration.loadContinuity(ctx)).toBeUndefined();
    await writeFile(join(root, "proof.txt"), "v1");
    await tool.execute("save", { action: "set_task", expectedRevision: 0, text: "Continue the fix", blockers: ["Need evidence"], files: ["proof.txt"] }, undefined, undefined, ctx);
    expect((await registration.loadContinuity(ctx))?.freshness).toBe("current");
    await writeFile(join(root, "proof.txt"), "v2");
    expect((await registration.loadContinuity(ctx))?.freshness).toBe("stale");
    enabled = false;
    expect(await registration.loadContinuity(ctx)).toBeUndefined();
    enabled = true; ctx.isProjectTrusted = () => false;
    expect(await registration.loadContinuity(ctx)).toBeUndefined();
  });
  it.each(["default", "append"])("places the current prefix first in %s compaction and provider projection", async mode => {
    const runtime = new Runtime();
    runtime.config = { ...runtime.config, compactionSummaryMode: mode as "default" | "append", skipForProviders: [] };
    vi.spyOn(runtime, "ensureConfig").mockImplementation(() => {});
    const handlers = new Map<string, Function>();
    const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn) };
    let block = renderContinuity(state(), new Map())!;
    const load = vi.fn(async () => block);
    registerBeforeCompactHook(pi, runtime, load);
    const entries: any[] = [{ type: "message", id: "u1", message: { role: "user", content: "Fix the observer and preserve evidence", timestamp: 1 } },
      { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Examined the runtime" }], timestamp: 2 } },
      { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "Found the guard" }], timestamp: 3 } }];
    const ctx: any = { cwd: root, ui: { notify: vi.fn() }, sessionManager: { getEntries: () => entries } };
    let previousSummary: string | undefined;
    for (let cycle = 1; cycle <= 2; cycle++) {
      if (cycle === 2) {
        const updated = state(); updated.task!.nextSteps = ["Run the NEW validation"];
        block = renderContinuity(updated, new Map())!;
        entries.push(
          { type: "message", id: "u2", message: { role: "user", content: "Continue the observer fix", timestamp: 4 } },
          { type: "message", id: "a3", message: { role: "assistant", content: [{ type: "text", text: "Updated the guard" }], timestamp: 5 } },
          { type: "message", id: "a4", message: { role: "assistant", content: [{ type: "text", text: "Ready for validation" }], timestamp: 6 } },
        );
      }
      const result = await handlers.get("session_before_compact")!({ branchEntries: entries,
        preparation: { firstKeptEntryId: "", previousSummary, tokensBefore: 50000, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, settings: { reserveTokens: 4096 } },
      }, ctx);
      expect(result.compaction.summary.startsWith(CONTINUITY_START)).toBe(true);
      expect(result.compaction.details["om.selection"].version).toBe(1);
      expect(result.compaction.details["context-forge.continuity"].revision).toBe(1);
      const compaction = { ...result.compaction, type: "compaction", id: `c${cycle}`, timestamp: "2026-11-01T00:00:00Z" };
      const context = [{ role: "compactionSummary", summary: compaction.summary, timestamp: 1, tokensBefore: 50000 }];
      const projected = projectAppendOnlyContext(context, [...entries, compaction]);
      const wire = convertToLlm(projected as any);
      expect(JSON.stringify(wire[0])).toContain("Resume Context");
      expect(JSON.stringify(wire[0])).toContain(cycle === 1 ? "Inspect the generation guard" : "Run the NEW validation");
      expect(JSON.stringify(wire).split(CONTINUITY_START)).toHaveLength(2);
      if (cycle === 2) expect(JSON.stringify(wire)).not.toContain("Inspect the generation guard");
      previousSummary = compaction.summary;
      entries.push(compaction);
    }
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("cancels when the host aborts while the task note is being loaded", async () => {
    const controller = new AbortController();
    const runtime = new Runtime();
    vi.spyOn(runtime, "ensureConfig").mockImplementation(() => {});
    const handlers = new Map<string, Function>();
    const entries = Array.from({ length: 3 }, (_, n) => ({ type: "message", id: `entry-${n}`, message: {
      role: n === 0 ? "user" : "assistant", content: n === 0 ? "Continue the work" : [{ type: "text", text: "Progress recorded" }], timestamp: n,
    } }));
    registerBeforeCompactHook({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any, runtime, async () => {
      controller.abort(); return renderContinuity(state(), new Map());
    });
    const result = await handlers.get("session_before_compact")!({ signal: controller.signal, branchEntries: entries,
      preparation: { firstKeptEntryId: "", tokensBefore: 50000, fileOps: { read: new Set(), written: new Set(), edited: new Set() } },
    }, { cwd: root, ui: { notify: vi.fn() }, sessionManager: { getEntries: () => entries } });
    expect(result).toEqual({ cancel: true });
    expect(runtime.lastCompactCancelled).toBe(true);
  });
});
