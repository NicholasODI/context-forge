import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assessFreshness, emptyMemory, projectRoot, readMemory, refreshDocuments,
  renderReminder, updateMemory, type MemoryChange,
  memoryView, reminderRecords,
} from "./store.ts";

import { renderContinuity } from "./continuity.ts";
import type { ContinuityBlock } from "../blackhole/src/core/continuity.ts";

const stringList = { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2000 } };
// Plain JSON Schema avoids callable-TypeBox interop under native omp/jiti.
export const PROJECT_MEMORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["read", "set_task", "record_decision", "verify", "invalidate", "supersede", "pin", "unpin"] },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    expectedRevision: { type: "integer", minimum: 0, description: "Required for writes; get the current revision with action=read." },
    id: { type: "string", description: "task or a decision ID returned by read." },
    text: { type: "string", minLength: 1, maxLength: 2000, description: "Current task goal, or a decision including its rationale." },
    status: { type: "string", enum: ["active", "blocked", "done"] },
    progress: stringList,
    nextSteps: stringList,
    blockers: stringList,
    files: { ...stringList, description: "Project-relative evidence files; their actual SHA-256 hashes are captured." },
    checks: { ...stringList, description: "Checks actually performed, including their outcome. Recorded claims only; this tool does not execute checks." },
    sources: { ...stringList, description: "Source references such as session entry IDs, user decisions, URLs, or commit IDs; not independently verified." },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

type MemoryMessage = AgentMessage & { contextForgeProjectMemory?: boolean };

export function registerProjectMemory(pi: ExtensionAPI, enabled: (ctx: ExtensionContext) => boolean): { registerContext: () => void; loadContinuity: (ctx: ExtensionContext) => Promise<ContinuityBlock | undefined> } {
  const permitted = (ctx: ExtensionContext) => {
    if (!enabled(ctx)) throw new Error("Project memory is disabled by context-forge configuration.");
    if (!ctx.isProjectTrusted()) throw new Error("Project memory requires a trusted project.");
  };
  pi.registerTool({
    name: "project_memory",
    label: "Project memory",
    description: "Maintain durable project task/progress/next steps and decisions with rationale and evidence. Read first, then update after meaningful progress or changed decisions. Stored in .context-forge; no worker/model calls. Never mark a check passed unless it was actually performed.",
    parameters: PROJECT_MEMORY_SCHEMA,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      permitted(ctx);
      if (!raw || typeof raw !== "object") throw new Error("Project memory arguments must be an object.");
      const input = raw as unknown as MemoryChange | { action: "read"; id?: string; offset?: number; limit?: number };
      const root = await projectRoot(ctx.cwd);
      const state = input.action === "read"
        ? await readMemory(root) ?? emptyMemory()
        : await updateMemory(root, input, ctx.sessionManager.getSessionId());
      return {
        content: [{ type: "text", text: await memoryView(root, state, input.action === "read" ? input : {}) }],
        details: { root, revision: state.revision },
      };
    },
  });

  pi.registerCommand("forge-memory", {
    description: "Show durable task/decision status. /forge-memory refresh regenerates TASK.md and DECISIONS.md; it does not reverify evidence.",
    async handler(args, ctx) {
      try {
        permitted(ctx);
        if (args.trim() !== "" && args.trim() !== "refresh") throw new Error("Usage: /forge-memory [refresh]");
        const root = await projectRoot(ctx.cwd);
        const state = args.trim() === "refresh" ? await refreshDocuments(root) : await readMemory(root);
        ctx.ui.notify(state
          ? renderReminder(state, await assessFreshness(root, state, reminderRecords(state)))
          : "No durable project memory yet. Ask the agent to use project_memory to record the task and next steps.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let registered = false;
  return {
    async loadContinuity(ctx) {
      if (!enabled(ctx) || !ctx.isProjectTrusted()) return undefined;
      try {
        const root = await projectRoot(ctx.cwd);
        const state = await readMemory(root);
        if (!state?.task) return undefined;
        return renderContinuity(state, await assessFreshness(root, state, [state.task]));
      } catch (error) {
        ctx.ui.notify(`Continuity note unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
        return undefined;
      }
    },
    // Register after VCC's context projection so it cannot discard this live
    // reminder. Never append it to session history or advance OM cursors.
    registerContext() {
      if (registered) return;
      registered = true;
      pi.on("context", async (event, ctx) => {
        const original = event.messages;
        const messages = original.filter(m => !(m as MemoryMessage).contextForgeProjectMemory);
        if (!enabled(ctx) || !ctx.isProjectTrusted()) return messages.length === original.length ? undefined : { messages };
        try {
          const root = await projectRoot(ctx.cwd);
          const state = await readMemory(root);
          if (!state) return messages.length === original.length ? undefined : { messages };
          const reminder: MemoryMessage = {
            role: "user",
            content: [{ type: "text", text: renderReminder(state, await assessFreshness(root, state, reminderRecords(state))) }],
            timestamp: Date.now(),
            contextForgeProjectMemory: true,
          };
          return { messages: [...messages, reminder] };
        } catch (error) {
          // Preserve the provider context on storage errors; make the failure
          // visible so it cannot masquerade as a successful injection.
          ctx.ui.notify(`Project memory was not loaded: ${error instanceof Error ? error.message : String(error)}`, "warning");
          return messages.length === original.length ? undefined : { messages };
        }
      });
    },
  };
}
