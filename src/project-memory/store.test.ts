import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assessFreshness, projectRoot, readMemory, refreshDocuments, renderReminder, updateMemory,
  type ProjectMemory,
} from "./store";

const exec = promisify(execFile);
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "forge-memory-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const task = (revision = 0) => ({ action: "set_task" as const, expectedRevision: revision, text: "Fix observer reliability", nextSteps: ["Run the isolated regression"] });

describe("durable project memory", () => {
  it("does not create files when reading an uninitialized project", async () => {
    expect(await readMemory(root)).toBeNull();
    await expect(readFile(join(root, ".context-forge/memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists task/progress and projects readable docs across reloads", async () => {
    const saved = await updateMemory(root, { ...task(), progress: ["Found the faulty gate"] }, "session-a");
    expect(saved.revision).toBe(1);
    expect(await readMemory(root)).toEqual(saved);
    expect(await readFile(join(root, ".context-forge/TASK.md"), "utf8")).toContain("Run the isolated regression");
    expect(await readFile(join(root, ".context-forge/DECISIONS.md"), "utf8")).toContain("# Decision log");
    expect((await assessFreshness(root, saved)).get("task")?.status).toBe("unverified");
  });

  it("captures real file hashes and marks modified/deleted evidence stale without writes", async () => {
    await writeFile(join(root, "observer.ts"), "original");
    const saved = await updateMemory(root, { ...task(), files: ["observer.ts"], checks: ["targeted tests: 3 passed"], sources: ["entry:a1"] }, "session-a");
    expect(saved.task?.evidence?.files[0].sha256).toHaveLength(64);
    expect(saved.task?.evidence?.sessionId).toBe("session-a");
    expect((await assessFreshness(root, saved)).get("task")?.status).toBe("current");
    const source = await readFile(join(root, ".context-forge/memory.json"), "utf8");
    await writeFile(join(root, "observer.ts"), "changed");
    expect((await assessFreshness(root, saved)).get("task")?.status).toBe("stale");
    await rm(join(root, "observer.ts"));
    expect((await assessFreshness(root, saved)).get("task")?.reason).toContain("unavailable");
    expect(await readFile(join(root, ".context-forge/memory.json"), "utf8")).toBe(source);
  });

  it("retains superseded decisions in history and allows explicit invalidation/reverification", async () => {
    await writeFile(join(root, "design.md"), "approved design");
    await updateMemory(root, { action: "record_decision", expectedRevision: 0, text: "Use strategy A because it is simple" }, "a");
    let state = await updateMemory(root, { action: "supersede", expectedRevision: 1, id: "d-1", text: "Use strategy B because A loses coverage", files: ["design.md"] }, "b");
    expect(state.decisions).toHaveLength(2);
    expect(state.decisions[0].supersededBy).toBe("d-2");
    state = await updateMemory(root, { action: "invalidate", expectedRevision: 2, id: "d-2", reason: "Requirement changed" }, "b");
    expect((await assessFreshness(root, state)).get("d-2")?.reason).toBe("Requirement changed");
    state = await updateMemory(root, { action: "verify", expectedRevision: 3, id: "d-2", files: ["design.md"] }, "b");
    const freshness = await assessFreshness(root, state);
    expect(freshness.get("d-1")?.status).toBe("superseded");
    expect(freshness.get("d-2")?.status).toBe("current");
    const reminder = renderReminder(state, freshness);
    expect(reminder).not.toContain("Use strategy A");
    expect(reminder).toContain("Use strategy B");
    expect(await readFile(join(root, ".context-forge/DECISIONS.md"), "utf8")).toContain("Use strategy A");
  });

  it("rejects stale revisions and concurrent writers instead of losing updates", async () => {
    await updateMemory(root, task(), "a");
    await expect(updateMemory(root, task(), "b")).rejects.toThrow("revision conflict");
    const results = await Promise.allSettled([
      updateMemory(root, { action: "record_decision", expectedRevision: 1, text: "A" }, "a"),
      updateMemory(root, { action: "record_decision", expectedRevision: 1, text: "B" }, "b"),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await readMemory(root))?.decisions).toHaveLength(1);
  });

  it("does not overwrite user-authored documents or malformed source state", async () => {
    await mkdir(join(root, ".context-forge"));
    await writeFile(join(root, ".context-forge/TASK.md"), "my existing task note");
    await expect(updateMemory(root, task(), "a")).rejects.toThrow("user-authored");
    expect(await readFile(join(root, ".context-forge/TASK.md"), "utf8")).toBe("my existing task note");
    await writeFile(join(root, ".context-forge/memory.json"), "broken JSON");
    await expect(updateMemory(root, task(), "a")).rejects.toThrow("invalid JSON");
    expect(await readFile(join(root, ".context-forge/memory.json"), "utf8")).toBe("broken JSON");
  });

  it("rejects evidence outside the project and self-referential evidence", async () => {
    await expect(updateMemory(root, { ...task(), files: ["../outside.txt"] }, "a")).rejects.toThrow("inside the project");
    await expect(updateMemory(root, { ...task(), files: [".context-forge/TASK.md"] }, "a")).rejects.toThrow("own file evidence");
    expect(await readMemory(root)).toBeNull();
  });

  it("rejects symlinked storage and evidence escaping the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "forge-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "outside");
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(outside, join(root, ".context-forge"), linkType);
      await expect(readMemory(root)).rejects.toThrow("real directory");
      await rm(join(root, ".context-forge"));
      await symlink(outside, join(root, "outside-link"), linkType);
      await expect(updateMemory(root, { ...task(), files: ["outside-link/secret.txt"] }, "a")).rejects.toThrow("escapes");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("requires real evidence fields for verify and validates mutations before writing", async () => {
    await expect(updateMemory(root, { ...task(), expectedRevision: undefined } as never, "a")).rejects.toThrow("expectedRevision");
    await updateMemory(root, task(), "a");
    await expect(updateMemory(root, { action: "verify", expectedRevision: 1, id: "task", sources: ["user said it works"] }, "a")).rejects.toThrow("requires file evidence");
    expect((await readMemory(root))?.revision).toBe(1);
  });

  it("refreshes generated docs without claiming checks were rerun or changing revision", async () => {
    await writeFile(join(root, "proof.txt"), "before");
    await updateMemory(root, { ...task(), files: ["proof.txt"] }, "a");
    await writeFile(join(root, "proof.txt"), "after");
    const state = await refreshDocuments(root);
    expect(state.revision).toBe(1);
    expect(await readFile(join(root, ".context-forge/TASK.md"), "utf8")).toContain("evidence: stale");
  });

  it("bounds the main-context reminder while retaining all decisions on disk", async () => {
    const state: ProjectMemory = { version: 1, revision: 1, task: null, decisions: Array.from({ length: 100 }, (_, i) => ({
      id: `d-${i}`, text: `decision ${i}: ` + "x".repeat(1900), updatedAt: new Date().toISOString(), evidence: null,
    })) };
    const reminder = renderReminder(state, await assessFreshness(root, state));
    expect(reminder.length).toBeLessThanOrEqual(8000);
    expect(reminder).toContain("92 additional decisions omitted");
    expect(state.decisions).toHaveLength(100);
  });

  it("shares the repo root and invalidates reported checks when tracked content changes", async () => {
    await exec("git", ["init", root]);
    await writeFile(join(root, "tracked.txt"), "before");
    await exec("git", ["-C", root, "add", "tracked.txt"]);
    await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
    await mkdir(join(root, "subdir"));
    expect(await projectRoot(join(root, "subdir"))).toBe(await projectRoot(root));
    const state = await updateMemory(root, { ...task(), checks: ["unit tests: passed"] }, "a");
    expect((await assessFreshness(root, state)).get("task")?.status).toBe("current");
    await writeFile(join(root, "tracked.txt"), "after");
    expect((await assessFreshness(root, state)).get("task")?.status).toBe("stale");
  });
});
