import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectArchive, archiveOrientation, pendingArchiveEntries, selectArchive } from "./archive";
import { registerProjectMemory } from "./index";
import { Runtime } from "../blackhole/src/om/runtime";
import type { Entry, Observation } from "../blackhole/src/om/ledger/types";

const faults = vi.hoisted(() => ({ commit: false }));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: string, to: string) => {
    if (faults.commit && to.includes("sessions") && to.endsWith(".json")) throw new Error("synthetic manifest commit interrupted");
    return fs.rename(from, to);
  } };
});
vi.mock("../blackhole/src/om/pending.ts", async original => ({ ...await original<typeof import("../blackhole/src/om/pending.ts")>(), readPendingState: () => undefined }));
vi.mock("../blackhole/src/om/debug-log.ts", async original => ({ ...await original<typeof import("../blackhole/src/om/debug-log.ts")>(), debugLog: vi.fn() }));

const ids = ["000000000001", "000000000002", "000000000003"];
const observation = (n: number, text = "Use the UNIX socket transport"): Observation => ({ id: ids[n], content: text, timestamp: "2026-01-01", relevance: "high", sourceEntryIds: ["source-user", "source-tool"], tokenCount: 10 });
const observations = (list = [observation(0), observation(1, "Obsolete TCP setting")], id = "obs"): Entry => ({ type: "custom", id, customType: "om.observations.recorded", data: { observations: list, coversUpToId: "source-user" } });
const branch = (): Entry[] => [
  { type: "message", id: "source-user", message: { role: "user", content: "Require UNIX sockets. api_key=PRIVATE_TEST_VALUE" } },
  { type: "message", id: "source-tool", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "SENSITIVE_RAW_STDOUT" }] } },
  observations(),
  { type: "custom", id: "ref", customType: "om.reflections.recorded", data: { reflections: [{ id: "000000000010", content: "UNIX socket transport is required", supportingObservationIds: [ids[0]], tokenCount: 10 }], coversUpToId: "obs" } },
  { type: "custom", id: "drop", customType: "om.observations.dropped", data: { observationIds: [ids[1]], coversUpToId: "obs", proofs: { [ids[1]]: { reflectionIds: ["000000000010"], reason: "explicitly replaced" } } } },
];
let root: string, other: string;
beforeEach(async () => { faults.commit = false; root = await mkdtemp(join(tmpdir(), "forge-archive-")); other = await mkdtemp(join(tmpdir(), "forge-archive-new-")); });
afterEach(async () => { faults.commit = false; await Promise.all([root, other].map(p => rm(p, { recursive: true, force: true }))); });

describe("portable project observational memory", () => {
  it("is self-contained after copying only the folder and does not resurrect drops", async () => {
    await new ProjectArchive().sync(root, "session-A", branch());
    await cp(join(root, ".context-forge"), join(other, ".context-forge"), { recursive: true });
    const archive = new ProjectArchive(), view = await archive.read(other);
    expect(view.sessions).toBe(1); expect(view.records).toHaveLength(3);
    expect(selectArchive(view, "TCP obsolete").map(r => r.id)).not.toContain(ids[1]);
    expect(view.records.find(r => r.id === ids[1])?.status).toBe("dropped");
    const recalled = view.records.find(r => r.id === ids[0])!;
    expect(recalled.sources[0].excerpt).toContain("[REDACTED]");
    expect(JSON.stringify(view)).not.toContain("PRIVATE_TEST_VALUE");
    expect(JSON.stringify(view)).not.toContain("SENSITIVE_RAW_STDOUT");
    expect(recalled.sources[1].omitted).toContain("raw tool output");
    expect((await archive.read(other, { object: recalled.object })).records[0].id).toBe(ids[0]);
    expect(archiveOrientation(view, "UNIX")).toContain("not authorization");
    expect(archiveOrientation(view, "UNIX").length).toBeLessThanOrEqual(3000);
    expect(archiveOrientation(view, "UNIX", "session-A")).toBe("");
    expect(selectArchive(view, "completely_unrelated_topic")).toHaveLength(0);
    expect((await archive.sessions(other)).sessions[0].sessionId).toBe("session-A");
    await expect(readFile(join(other, ".context-forge/memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("deduplicates capture, supports concurrent origins, and retains policy state", async () => {
    const a = new ProjectArchive();
    await a.sync(root, "A", branch());
    const path = join(root, ".context-forge/archive/objects");
    const initial = await readdir(path);
    await a.sync(root, "A", branch());
    expect(await readdir(path)).toEqual(initial);
    await Promise.all([new ProjectArchive().sync(root, "B", branch()), new ProjectArchive().sync(root, "C", branch())]);
    expect(await readdir(path)).toEqual(initial);
    let view = await new ProjectArchive().read(root);
    expect(view.sessions).toBe(3);
    expect(selectArchive(view, "UNIX")).toHaveLength(2);
    const policy: Entry = { type: "custom", id: "policy", customType: "om.memory.policy", data: { action: "invalidate", id: ids[0], reason: "Evidence contradicted" } };
    await a.sync(root, "A", [...branch(), policy]);
    view = await a.read(root);
    expect(selectArchive(view, "UNIX")).toHaveLength(0);
    expect(selectArchive(view, "UNIX", 8, true).length).toBeGreaterThan(0);
    expect((await a.read(root, { sessionId: "B" })).records.some(r => r.id === ids[0] && r.status === "active")).toBe(true);
  });
  it("keeps the old checkpoint usable when final commit is interrupted", async () => {
    const archive = new ProjectArchive();
    await archive.sync(root, "A", branch());
    faults.commit = true;
    await expect(archive.sync(root, "A", [...branch(), observations([observation(2, "New claim")], "later")])).rejects.toThrow("interrupted");
    expect((await new ProjectArchive().read(root)).records.map(r => r.id)).not.toContain(ids[2]);
    faults.commit = false;
    await archive.sync(root, "A", [...branch(), observations([observation(2, "New claim")], "later")]);
    expect((await archive.read(root)).records.map(r => r.id)).toContain(ids[2]);
  });
  it("keeps captured source excerpts after source messages disappear from the live branch", async () => {
    await new ProjectArchive().sync(root, "A", branch());
    const restored = new ProjectArchive();
    await restored.sync(root, "A", [...branch().filter(e => e.type === "custom"), observations([observation(2)], "later")]);
    const old = (await restored.read(root)).records.find(r => r.id === ids[0])!;
    expect(old.sources[0].excerpt).toContain("Require UNIX sockets");
    expect(old.sources[1].omitted).toContain("raw tool output");
  });
  it("reports corrupt objects and rejects symlinked storage", async () => {
    await new ProjectArchive().sync(root, "A", branch());
    const path = join(root, ".context-forge/archive/objects");
    const files = await readdir(path); await writeFile(join(path, files[0]), "tampered");
    const view = await new ProjectArchive().read(root);
    expect(view.records).toHaveLength(0); expect(view.warnings).toHaveLength(1);
    await symlink(join(root, ".context-forge"), join(other, ".context-forge"));
    await expect(new ProjectArchive().sync(other, "B", branch())).rejects.toThrow("real directory");
  });
  it("preserves unsupported checkpoints instead of overwriting a newer archive format", async () => {
    await new ProjectArchive().sync(root, "A", branch());
    const path = join(root, ".context-forge/archive/sessions");
    const file = join(path, (await readdir(path))[0]);
    const raw = JSON.stringify({ version: 99, sessionId: "A" });
    await writeFile(file, raw);
    await expect(new ProjectArchive().sync(root, "A", branch())).rejects.toThrow("Unsupported archive manifest");
    expect(await readFile(file, "utf8")).toBe(raw);
  });
  it("keeps old objects across a fork without merging retired branch state into its replacement", async () => {
    const archive = new ProjectArchive(); await archive.sync(root, "A", branch());
    const object = (await archive.read(root)).records.find(r => r.id === ids[0])!.object;
    await archive.sync(root, "A", [observations([observation(2, "Different branch")], "fork")]);
    expect((await archive.read(root)).records.map(r => r.id)).toEqual([ids[2]]);
    expect((await archive.read(root, { object })).records.map(r => r.id)).toContain(ids[0]);
    await archive.sync(root, "A", []);
    expect((await archive.read(root)).records).toHaveLength(0);
    expect((await archive.read(root, { object })).records.map(r => r.id)).toContain(ids[0]);
  });
  it("copies pending facts and tombstones, but never cursor state", async () => {
    const pending = pendingArchiveEntries({ observationBatches: [{ coversUpToId: "x", data: observations().data }], dropped: { coversUpToId: "obs", data: branch().at(-1)!.data }, cursors: { observer: { entryId: "SENSITIVE_CURSOR", state: "recorded" } } });
    expect(JSON.stringify(pending)).not.toContain("SENSITIVE_CURSOR");
    await new ProjectArchive().sync(root, "A", pending);
    expect((await new ProjectArchive().read(root)).records.find(r => r.id === ids[1])?.status).toBe("dropped");
  });
  it("bounds orientation and recall with a large archive and preserves the original full record", async () => {
    const archive = new ProjectArchive();
    const large = Array.from({ length: 80 }, (_, i) => ({ ...observation(0), id: i.toString(16).padStart(12, "0"), content: "UNIX " + "Long detail ".repeat(150) }));
    await archive.sync(root, "A", [observations(large)]);
    const view = await archive.read(root);
    expect(view.records).toHaveLength(80);
    expect(archiveOrientation(view, "UNIX").length).toBeLessThanOrEqual(3000);
    expect(view.records[0].content).toBe(large[0].content);
  });
});

function host(enabled = true, trusted = true) {
  const handlers = new Map<string, Function>(); let tool: any;
  const ctx: any = { cwd: root, isProjectTrusted: () => trusted, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => "A", getBranch: () => branch() } };
  const pi: any = { registerTool: (t: any) => { tool = t; }, registerCommand: vi.fn(), on: (n: string, f: Function) => handlers.set(n, f), newSession: vi.fn(), appendEntry: vi.fn() };
  const registration = registerProjectMemory(pi, () => enabled); registration.registerContext();
  return { pi, ctx, tool, handlers, registration, context: handlers.get("context")! };
}
describe("user-initiated session boundary", () => {
  it("captures A then orients empty B without session creation, cursor transfer or transcript injection", async () => {
    const h = host();
    await h.handlers.get("agent_end")!({}, h.ctx);
    h.ctx.sessionManager = { getSessionId: () => "B", getBranch: () => [] };
    const messages = [{ role: "user", content: "Implement UNIX transport", timestamp: 1 }];
    const first = await h.context({ messages }, h.ctx);
    const text = JSON.stringify(first.messages);
    expect(text).toContain("UNIX socket"); expect(text).not.toContain("Obsolete TCP");
    expect(text).toContain("Sessions are started by the user only");
    const second = await h.context(first, h.ctx);
    expect(second.messages).toHaveLength(2); expect(messages).toHaveLength(1);
    const result = await h.tool.execute("recall", { action: "recall", id: ids[1] }, undefined, undefined, h.ctx);
    expect(JSON.parse(result.content[0].text).records[0].status).toBe("dropped");
    expect(h.pi.newSession).not.toHaveBeenCalled(); expect(h.pi.appendEntry).not.toHaveBeenCalled();
    const path = join(root, ".context-forge/archive/sessions");
    const manifest = await readFile(join(path, (await readdir(path))[0]), "utf8");
    expect(manifest).not.toContain("cursors");
    const diagnostic = JSON.parse((await h.tool.execute("diag", { action: "diagnostics" }, undefined, undefined, h.ctx)).content[0].text);
    expect(diagnostic.archive.sessionsCreatedAutomatically).toBe(false);
    expect(diagnostic.archive.freshness).toContain("not automatically reverified");
  });
  it.each([[false, true], [true, false]])("does not capture/read when enabled=%s trusted=%s", async (enabled, trusted) => {
    const h = host(enabled, trusted);
    expect(await h.context({ messages: [] }, h.ctx)).toBeUndefined();
    await h.registration.checkpoint(h.ctx);
    await expect(h.tool.execute("recall", { action: "recall" }, undefined, undefined, h.ctx)).rejects.toThrow();
    await expect(readdir(join(root, ".context-forge"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not create an empty archive just by opening a session", async () => {
    const h = host(); h.ctx.sessionManager.getBranch = () => [];
    expect(await h.context({ messages: [] }, h.ctx)).toBeUndefined();
    await expect(readdir(join(root, ".context-forge"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checkpoints after failed worker work without leaking its lifecycle", async () => {
    const runtime = new Runtime(); const checkpoint = vi.fn(async () => undefined);
    runtime.onConsolidationSettled = checkpoint;
    await runtime.launchConsolidationTask({ hasUI: false }, async () => { throw new Error("synthetic worker failure"); });
    expect(checkpoint).toHaveBeenCalledOnce(); expect(runtime.consolidationInFlight).toBe(false);
    expect(runtime.consolidationPromise).toBeNull();
  });
});
