import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assessFreshness, emptyMemory, projectRoot, readMemory, refreshDocuments,
  renderReminder, updateMemory, type MemoryChange,
  memoryView, reminderRecords,
} from "./store.ts";

import { CheckReceipts } from "./check-receipts.ts";
import { renderHandoff } from "./handoff.ts";
import { CONTINUITY_START, stripContinuity } from "../blackhole/src/core/continuity.ts";
import { renderContinuity } from "./continuity.ts";
import type { ContinuityBlock } from "../blackhole/src/core/continuity.ts";

const stringList = { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2000 } };
// Plain JSON Schema avoids callable-TypeBox interop under native omp/jiti.
export const PROJECT_MEMORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["read", "diagnostics", "set_task", "update_task", "complete_task", "record_decision", "verify", "invalidate", "supersede", "pin", "unpin"] },
    section: { type: "string", enum: ["decisions", "tasks", "checks"] },
    offset: { type: "integer", minimum: 0 },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    expectedRevision: { type: "integer", minimum: 0, description: "Required for writes; get the current revision with action=read." },
    id: { type: "string", description: "task or a decision ID returned by read." },
    text: { type: "string", minLength: 1, maxLength: 2000, description: "Current task goal, or a decision including its rationale." },
    status: { type: "string", enum: ["active", "blocked", "done"] },
    progress: stringList,
    nextSteps: stringList,
    blockers: stringList,
    scope: stringList,
    acceptanceCriteria: stringList,
    checkIds: { ...stringList, description: "Attach matching host receipts returned by read section=checks. Exit code does not prove expected tests ran." },
    provenance: { type: "object", additionalProperties: false, required: ["kind", "source"], properties: {
      kind: { type: "string", enum: ["user_instruction", "model_plan", "model_report"] }, source: { type: "string", minLength: 1, maxLength: 500 },
    } },
    hypotheses: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["text", "status", "sources"], properties: {
      text: { type: "string", minLength: 1, maxLength: 2000 }, status: { type: "string", enum: ["open", "supported", "ruled_out"] }, sources: stringList,
    } } },
    pendingGoalChange: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, required: ["text", "source"], properties: {
      text: { type: "string", minLength: 1, maxLength: 2000 }, source: { type: "string", minLength: 1, maxLength: 500 },
    } }] },
    files: { ...stringList, description: "Project-relative evidence files; their actual SHA-256 hashes are captured." },
    checks: { ...stringList, description: "Checks actually performed, including their outcome. Recorded claims only; this tool does not execute checks." },
    sources: { ...stringList, description: "Source references such as session entry IDs, user decisions, URLs, or commit IDs; not independently verified." },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  },
};

type MemoryMessage = AgentMessage & { contextForgeProjectMemory?: boolean };

export function registerProjectMemory(pi: ExtensionAPI, enabled: (ctx: ExtensionContext) => boolean): { registerContext: () => void; loadContinuity: (ctx: ExtensionContext) => Promise<ContinuityBlock | undefined> } {
  const receipts = new CheckReceipts();
  // Hooks retain metadata only; observing a result does not mutate task state.
  pi.on("tool_call", (event, ctx) => {
    try { if (enabled(ctx) && ctx.isProjectTrusted()) receipts.request(ctx.sessionManager.getSessionId(), event, ctx.cwd); } catch { /* optional capability */ }
  });
  pi.on("tool_result", (event, ctx) => {
    try { if (enabled(ctx) && ctx.isProjectTrusted()) receipts.result(ctx.sessionManager.getSessionId(), event, ctx.cwd); } catch { /* unknown host shape stays unknown */ }
  });
  const permitted = (ctx: ExtensionContext) => {
    if (!enabled(ctx)) throw new Error("Project memory is disabled by context-forge configuration.");
    if (!ctx.isProjectTrusted()) throw new Error("Project memory requires a trusted project.");
  };
  pi.registerTool({
    name: "project_memory",
    label: "Project memory",
    description: "Maintain one focused task, scope, acceptance criteria, progress, blockers, hypotheses and next action. set_task replaces an objective; update_task changes progress; complete_task completes it; supersede id=task replaces explicitly; read section=tasks retrieves history. Changes are reference state, never authorization. Attribute sources and keep ambiguity explicit. Read first, then update after meaningful progress or changed decisions. Stored in .context-forge; no worker/model calls. Never mark a check passed unless it was actually performed.",
    parameters: PROJECT_MEMORY_SCHEMA,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      permitted(ctx);
      if (!raw || typeof raw !== "object") throw new Error("Project memory arguments must be an object.");
      const input = raw as unknown as MemoryChange | { action: "read"; id?: string; offset?: number; limit?: number; section?: "decisions" | "tasks" | "checks" } | { action: "diagnostics" };
      const root = await projectRoot(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      if (input.action === "read" && input.section === "checks") return {
        content: [{ type: "text", text: JSON.stringify({ receipts: receipts.list(sessionId, ctx.cwd), note: "Host metadata only. Missing results/exit codes and expected test execution remain unknown. Receipts expire on reload/session/cwd changes." }) }], details: {},
      };
      if (input.action === "diagnostics") {
        const state = await readMemory(root) ?? emptyMemory();
        const report = renderHandoff(state, await assessFreshness(root, state, reminderRecords(state)), { budget: 8000, selected: reminderRecords(state) });
        return { content: [{ type: "text", text: JSON.stringify({ view: "planned current handoff, not provider-wire evidence", schemaVersion: state.version, revision: state.revision, diagnostics: report.diagnostics,
          archivedTasksExcluded: state.taskHistory?.length ?? 0, capture: "metadata-only; expected test execution unknown" }, null, 2) }], details: {} };
      }
      const state = input.action === "read"
        ? await readMemory(root) ?? emptyMemory()
        : await updateMemory(root, input, sessionId, receipts.resolve(sessionId, input.checkIds ?? [], ctx.cwd));
      return {
        content: [{ type: "text", text: await memoryView(root, state, input.action === "read" ? { ...input, section: input.section === "tasks" ? "tasks" : "decisions" } : {}) }],
        details: { root, revision: state.revision },
      };
    },
  });

  pi.registerCommand("forge-memory", {
    description: "Show durable task/decision status. /forge-memory refresh regenerates TASK.md and DECISIONS.md; it does not reverify evidence.",
    async handler(args, ctx) {
      try {
        permitted(ctx);
        if (!["", "refresh", "diagnostics"].includes(args.trim())) throw new Error("Usage: /forge-memory [refresh|diagnostics]");
        const root = await projectRoot(ctx.cwd);
        const state = args.trim() === "refresh" ? await refreshDocuments(root) : await readMemory(root);
        if (args.trim() === "diagnostics" && state) {
          const f = await assessFreshness(root, state, reminderRecords(state));
          ctx.ui.notify(JSON.stringify(renderHandoff(state, f, { budget: 8000, selected: reminderRecords(state) }).diagnostics, null, 2), "info"); return;
        }
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
        return renderContinuity(state, await assessFreshness(root, state, reminderRecords(state)));
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
        const withoutPersistedPrefix = (input: typeof messages) => input.flatMap(m => {
          const message = m as unknown as { role?: string; summary?: string };
          if (message.role !== "compactionSummary" || typeof message.summary !== "string" || !message.summary.includes(CONTINUITY_START)) return [m];
          const summary = stripContinuity(message.summary);
          return summary ? [{ ...m, summary } as AgentMessage] : [];
        });
        if (!enabled(ctx) || !ctx.isProjectTrusted()) {
          const clean = withoutPersistedPrefix(messages);
          return clean.length === original.length && clean.every((m, i) => m === original[i]) ? undefined : { messages: clean };
        }
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
          return { messages: [...withoutPersistedPrefix(messages), reminder] };
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
