import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createOnlineContextCompactExtension } from "./extension.ts";
import { ONLINE_STATE_ENTRY, type OnlineState } from "./state.ts";

it("records plan progress and resets it on host compaction", async () => {
  const branch: SessionEntry[] = [];
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    getContextUsage: () => ({ tokens: 100 }),
    getSystemPrompt: () => "System prompt",
  } as unknown as ExtensionToolContext;
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const pi = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerTool,
    appendEntry: (customType: string, data: OnlineState) => {
      const parentId = branch.at(-1)?.id ?? null;
      branch.push({ type: "custom", id: String(branch.length), parentId, timestamp: new Date().toISOString(), customType, data });
    },
  } as unknown as ExtensionAPI;
  const latest = () => {
    const entry = branch.at(-1);
    if (entry?.type !== "custom" || entry.customType !== ONLINE_STATE_ENTRY) throw new Error("Missing plan state");
    return entry.data as OnlineState;
  };

  createOnlineContextCompactExtension()(pi);
  handlers.get("session_start")?.({}, ctx);
  const [tool] = registerTool.mock.calls[0];
  const step = { id: "test", goal: "Run checks", status: "in_progress" };
  await tool.execute("initial", { steps: [step] }, undefined, undefined, ctx);
  handlers.get("before_provider_request")?.({}, ctx);
  expect(latest()).toMatchObject({ plan: [step], requestCount: 1, lastContextTokens: 100 });
  const completed = { ...step, status: "completed" };
  const result = await tool.execute("done", { steps: [completed] }, undefined, undefined, ctx);
  expect(result.details).toMatchObject({ boundary: true });
  expect(latest()).toMatchObject({ plan: [completed], completedBoundaryRequestCounts: [1] });

  handlers.get("session_compact")?.({}, ctx);
  expect(latest()).toMatchObject({ plan: [], epoch: 1, nativeCompactionCount: 1, cacheDebtTokens: 0 });
});
