import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProjectMemory, PROJECT_MEMORY_SCHEMA } from "./index";

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
  return { ctx, tool, command, context: handlers.get("context")! };
}

describe("main-session project memory integration", () => {
  it("ships serializable plain JSON schema", () => {
    const schema = JSON.parse(JSON.stringify(PROJECT_MEMORY_SCHEMA));
    expect(schema.type).toBe("object");
    expect(schema.properties.action.enum).toContain("set_task");
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
});
