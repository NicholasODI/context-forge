import { expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerMemoryConsolidateCommand } from "./memory-consolidate";
import { triggerConsolidation } from "../om/consolidation";
import type { Runtime } from "../om/runtime";

vi.mock("../om/consolidation", () => ({
  triggerConsolidation: vi.fn(() => ({ outcome: "launched", runId: "synthetic-run" })),
}));

it("preserves the original command context and prototype trust method for completion checkpoints", async () => {
  let handler: Function = () => undefined;
  const pi = { registerCommand: (_name: string, command: { handler: Function }) => { handler = command.handler; } } as unknown as ExtensionAPI;
  class HostContext {
    cwd = "/synthetic-project";
    hasUI = false;
    ui = { notify: vi.fn() };
    model = undefined;
    modelRegistry = {};
    sessionManager = { getBranch: () => [], getSessionId: () => "synthetic-session" };
    trusted = true;
    isProjectTrusted() { return this.trusted; }
  }
  const ctx = new HostContext() as unknown as ExtensionCommandContext;
  const runtime = {} as Runtime;
  registerMemoryConsolidateCommand(pi, runtime);
  await handler("", ctx);
  const forwarded = vi.mocked(triggerConsolidation).mock.calls.at(-1)![2];
  expect(forwarded).toBe(ctx); // A worker-field projection or object spread loses capabilities.
  expect((forwarded as unknown as ExtensionCommandContext).isProjectTrusted()).toBe(true);
});
