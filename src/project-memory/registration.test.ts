import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { createContextForgeExtension } from "../index";

// Isolate initialization from real host patching and real user configuration.
// Model VCC removing a message during context projection: project memory must
// register after this projection to reach the provider on the same request.
vi.mock("../blackhole-register.ts", () => ({
  registerBlackholeCommands: vi.fn(),
  registerBlackholeMechanisms: async (pi: ExtensionAPI) => {
    pi.on("context", () => ({ messages: [] }));
  },
}));

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it("registers the durable reminder after VCC projection through the actual extension factory", async () => {
  root = await mkdtemp(join(tmpdir(), "forge-registration-test-"));
  const handlers = new Map<string, Function[]>();
  let memoryTool: any;
  const pi = {
    registerCommand: vi.fn(),
    registerTool: (tool: any) => { if (tool.name === "project_memory") memoryTool = tool; },
    on: (name: string, callback: Function) => handlers.set(name, [...(handlers.get(name) ?? []), callback]),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "synthetic-session" }, ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  createContextForgeExtension(() => ({
    ...DEFAULT_CONFIG,
    actionFusion: false, observationPack: false, onlineContextCompact: false,
    observationalMemory: false, vccCompaction: false, unifiedRecall: false,
  }))(pi);
  await memoryTool.execute("write", { action: "set_task", expectedRevision: 0, text: "Retain this task after compaction" }, undefined, undefined, ctx);
  await handlers.get("session_start")![0]({}, ctx);
  const contextHandlers = handlers.get("context")!;
  expect(contextHandlers).toHaveLength(2);
  let event = { messages: [{ role: "user", content: "Old transcript", timestamp: 1 }] };
  for (const handler of contextHandlers) {
    const result = await handler(event, ctx);
    if (result) event = result;
  }
  expect(JSON.stringify(event)).toContain("Retain this task after compaction");
  expect(JSON.stringify(event)).not.toContain("Old transcript");
});
