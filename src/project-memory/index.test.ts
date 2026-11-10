import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProjectMemory, PROJECT_MEMORY_SCHEMA } from "./index";
import { validateToolArguments } from "@earendil-works/pi-ai";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "forge-hook-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function host(enabled = true, trusted = true) {
  const handlers = new Map<string, Function>();
  let tool: any, command: any;
  const pi = {
    registerTool: (value: unknown) => { tool = value; },
    registerCommand: (_name: string, value: unknown) => { command = value; },
    on: (name: string, handler: Function) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, isProjectTrusted: () => trusted, ui: { notify: vi.fn() },
    sessionManager: { getSessionId: () => "isolated-session" },
  } as unknown as ExtensionContext;
  const registration = registerProjectMemory(pi, () => enabled);
  registration.registerContext();
  registration.registerContext();
  return { ctx, tool, command, handlers, context: handlers.get("context")! };
}

describe("main-session project memory integration", () => {
  it("attaches explicit host metadata receipts without auto-writing task state or claiming expected tests ran", async () => {
    const { ctx, tool, handlers, context } = host();
    const event = { toolName: "bash", toolCallId: "check-call", input: { command: "TOKEN=TOP_SECRET_VALUE npm test" } };
    await handlers.get("tool_call")!(event, ctx);
    await handlers.get("tool_result")!({ ...event, isError: false, structuredContent: { exit_code: 0, output: "raw private output TOP_SECRET_VALUE" } }, ctx);
    const read = await tool.execute("read", { action: "read", section: "checks" }, undefined, undefined, ctx);
    const receipt = JSON.parse(read.content[0].text).receipts[0];
    await expect(readFile(join(root, ".context-forge/memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await tool.execute("write", { action: "set_task", expectedRevision: 0, text: "Current task", checkIds: [receipt.id] }, undefined, undefined, ctx);
    const source = await readFile(join(root, ".context-forge/memory.json"), "utf8");
    expect(source).not.toContain("TOP_SECRET_VALUE");
    expect(source).not.toContain("raw private output");
    expect(JSON.stringify(await context({ messages: [] }, ctx))).toContain("expected tests executed=unknown");
  });
  it("replaces the persisted handoff with one live view and keeps the fallback on storage errors", async () => {
    const { ctx, tool, context } = host();
    await tool.execute("save", { action: "set_task", expectedRevision: 0, text: "Focused task" }, undefined, undefined, ctx);
    const { renderContinuity } = await import("./continuity");
    const { readMemory } = await import("./store");
    const block = renderContinuity((await readMemory(root))!, new Map())!;
    const original = [{ role: "compactionSummary", summary: block.text + "\n\n[Files And Changes]\n- proof.ts", tokensBefore: 100, timestamp: 1 }] as any;
    const once = await context({ messages: original }, ctx);
    expect(JSON.stringify(once.messages)).not.toContain("context-forge:continuity:start");
    expect(JSON.stringify(once.messages).match(/focused continuation/g)).toHaveLength(1);
    expect(once.messages[0].summary).toContain("proof.ts");
    const twice = await context(once, ctx);
    expect(twice.messages).toHaveLength(2);
    await writeFile(join(root, ".context-forge/memory.json"), "broken");
    expect(await context({ messages: original }, ctx)).toBeUndefined(); // original complete summary retained
    expect(original[0].summary).toContain("context-forge:continuity:start");
  });
  it("ships serializable plain JSON schema", () => {
    const schema = JSON.parse(JSON.stringify(PROJECT_MEMORY_SCHEMA));
    expect(schema.type).toBe("object");
    expect(schema.properties.action.enum).toContain("set_task");
    const tool: any = { name: "project_memory", parameters: PROJECT_MEMORY_SCHEMA };
    expect(validateToolArguments(tool, { name: "project_memory", arguments: { action: "update_task", expectedRevision: 1, pendingGoalChange: null, reason: "User clarified" } } as any).pendingGoalChange).toBeNull();
    expect(() => validateToolArguments(tool, { name: "project_memory", arguments: { action: "set_task", expectedRevision: 0, text: "Task", provenance: { kind: "tool_observed", source: "model claim" } } } as any)).toThrow();
  });

  it("creates nothing during normal context requests or read-only status", async () => {
    const { ctx, tool, command, context } = host();
    expect(await context({ messages: [] }, ctx)).toBeUndefined();
    const read = await tool.execute("read", { action: "read" }, undefined, undefined, ctx);
    expect(JSON.parse(read.content[0].text).revision).toBe(0);
    await command.handler("", ctx);
    await expect(readFile(join(root, ".context-forge/memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sends a task reminder through provider conversion before and after synthetic compaction", async () => {
    const { ctx, tool, context } = host();
    await tool.execute("write", { action: "set_task", expectedRevision: 0, text: "Fix the resumed-session observer", nextSteps: ["Run the bounded regression"] }, undefined, undefined, ctx);
    const before = [{ role: "user", content: "Continue", timestamp: 1 }];
    const after = [{ role: "user", content: "Compacted history", timestamp: 2 }];
    for (const messages of [before, after]) {
      const result = await context({ messages }, ctx);
      const wire = convertToLlm(result.messages);
      expect(JSON.stringify(wire)).toContain("Fix the resumed-session observer");
      expect(JSON.stringify(wire)).toContain("Run the bounded regression");
      expect(messages).toHaveLength(1); // no mutation or transcript append
    }
    const first = await context({ messages: before }, ctx);
    const second = await context(first, ctx);
    expect(second.messages).toHaveLength(2); // replacement, never accumulation
  });

  it("refreshes stale labels on each request without rewriting source", async () => {
    const { ctx, tool, context } = host();
    await writeFile(join(root, "proof.txt"), "v1");
    await tool.execute("write", { action: "set_task", expectedRevision: 0, text: "Keep evidence", files: ["proof.txt"] }, undefined, undefined, ctx);
    const source = await readFile(join(root, ".context-forge/memory.json"), "utf8");
    await writeFile(join(root, "proof.txt"), "v2");
    expect(JSON.stringify(await context({ messages: [] }, ctx))).toContain("stale");
    expect(await readFile(join(root, ".context-forge/memory.json"), "utf8")).toBe(source);
  });

  it.each([[false, true], [true, false]])("respects enabled=%s/trusted=%s without creating files", async (enabled, trusted) => {
    const { ctx, tool, context } = host(enabled, trusted);
    await expect(tool.execute("write", { action: "set_task", expectedRevision: 0, text: "No write" }, undefined, undefined, ctx)).rejects.toThrow();
    expect(await context({ messages: [] }, ctx)).toBeUndefined();
    const { CONTINUITY_START, CONTINUITY_END } = await import("../blackhole/src/core/continuity");
    const messages = [{ role: "compactionSummary", summary: `${CONTINUITY_START}\nSaved private project objective\n${CONTINUITY_END}\n\n[Files And Changes]\n- retained.ts` }];
    const result = await context({ messages }, ctx);
    expect(result.messages[0].summary).toBe("[Files And Changes]\n- retained.ts");
    expect(messages[0].summary).toContain("Saved private project objective"); // projection only
    await expect(readFile(join(root, ".context-forge/memory.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves main context and warns if source memory is corrupt", async () => {
    const { ctx, tool, context } = host();
    await tool.execute("write", { action: "set_task", expectedRevision: 0, text: "A task" }, undefined, undefined, ctx);
    await writeFile(join(root, ".context-forge/memory.json"), "invalid");
    const messages = [{ role: "user", content: "Keep this", timestamp: 1 }];
    expect(await context({ messages }, ctx)).toBeUndefined();
    expect(messages[0].content).toBe("Keep this");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not loaded"), "warning");
  });

  it("pages a large decision history without returning the full source to the model", async () => {
    const { ctx, tool } = host();
    await mkdir(join(root, ".context-forge"));
    const decisions = Array.from({ length: 600 }, (_, i) => ({
      id: `d-${i + 1}`, text: `Decision ${i + 1}: ` + "x".repeat(1800), updatedAt: new Date().toISOString(), evidence: null,
    }));
    await writeFile(join(root, ".context-forge/memory.json"), JSON.stringify({ version: 1, revision: 600, task: null, decisions }));
    const first = await tool.execute("read", { action: "read", limit: 5 }, undefined, undefined, ctx);
    const page = JSON.parse(first.content[0].text);
    expect(first.content[0].text.length).toBeLessThanOrEqual(16000);
    expect(page.records).toHaveLength(5);
    expect(page.nextOffset).toBe(5);
    expect(page.totalDecisions).toBe(600);
    const second = JSON.parse((await tool.execute("read", { action: "read", offset: 5, limit: 5 }, undefined, undefined, ctx)).content[0].text);
    expect(second.records[0].id).not.toBe(page.records[0].id);
    const detail = JSON.parse((await tool.execute("read", { action: "read", id: "d-1" }, undefined, undefined, ctx)).content[0].text);
    expect(detail.records).toHaveLength(1);
    expect(detail.records[0].text).toBe(decisions[0].text);
  });

  it("keeps an explicitly pinned old decision in the working set", async () => {
    const { ctx, tool, context } = host();
    for (let i = 0; i < 12; i++) {
      await tool.execute("write", { action: "record_decision", expectedRevision: i, text: i === 0 ? "Old invariant: preserve source evidence" : `Recent routine choice ${i}` }, undefined, undefined, ctx);
    }
    await tool.execute("pin", { action: "pin", expectedRevision: 12, id: "d-1" }, undefined, undefined, ctx);
    const result = await context({ messages: [] }, ctx);
    expect(JSON.stringify(result)).toContain("Old invariant: preserve source evidence");
    expect(JSON.stringify(result)).toContain("[pinned]");
  });
});
