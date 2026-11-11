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
import { ProjectArchive, archiveOrientation, selectArchive } from "./archive.ts";
import type { Entry } from "../blackhole/src/om/ledger/types.ts";
import { snippet } from "./privacy.ts";
import { readPendingState } from "../blackhole/src/om/pending.ts";
import { pendingArchiveEntries } from "./archive.ts";

const stringList = { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2000 } };
// Plain JSON Schema avoids callable-TypeBox interop under native omp/jiti.
export const PROJECT_MEMORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["read", "recall", "diagnostics", "set_task", "update_task", "complete_task", "record_decision", "verify", "invalidate", "supersede", "pin", "unpin"] },
    query: { type: "string", maxLength: 1000, description: "Cross-session archive search; archived claims are historical reference, not current verification." },
    sessionId: { type: "string", maxLength: 500, description: "Scope archive recall to an origin session." },
    object: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Retrieve an immutable historical object returned by recall; its lifecycle may since have changed." },
    includeInactive: { type: "boolean", description: "Include dropped/invalidated archive records for explicit historical inspection only." },
    section: { type: "string", enum: ["decisions", "tasks", "checks", "sessions"] },
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

export function registerProjectMemory(pi: ExtensionAPI, enabled: (ctx: ExtensionContext) => boolean): { registerContext: () => void; checkpoint: (ctx: ExtensionContext) => Promise<void>; loadContinuity: (ctx: ExtensionContext) => Promise<ContinuityBlock | undefined> } {
  const receipts = new CheckReceipts();
  const archive = new ProjectArchive();
  const checkpoint = async (ctx: ExtensionContext, resolvedRoot?: string) => {
    if (typeof ctx.isProjectTrusted !== "function") throw new Error("Archive checkpoint requires the full host context with project trust capability; no data was written.");
    if (!enabled(ctx) || !ctx.isProjectTrusted()) return { outcome: "not-permitted" as const, objects: 0 };
    if (typeof ctx.sessionManager.getBranch !== "function") throw new Error("Archive checkpoint requires the live session branch; no data was written.");
    // Snapshot identity/branch together before awaiting filesystem work. No cursors transfer.
    const id = ctx.sessionManager.getSessionId(), entries = ctx.sessionManager.getBranch() as Entry[];
    const pending = pendingArchiveEntries(readPendingState(id));
    return archive.sync(resolvedRoot ?? await projectRoot(ctx.cwd), id, [...entries, ...pending]);
  };
  const safeCheckpoint = async (ctx: ExtensionContext, resolvedRoot?: string) => {
    try { await checkpoint(ctx, resolvedRoot); }
    catch (e) {
      try { ctx.ui?.notify(`Project archive was not updated: ${e instanceof Error ? e.message : String(e)}`, "warning"); }
      catch { /* stale host UI must not fail a completed worker */ }
    }
  };
  pi.on("agent_end", (_event, ctx) => safeCheckpoint(ctx));
  try { pi.on("session_shutdown", (_event, ctx) => safeCheckpoint(ctx)); }
  catch { /* Some OMP versions expose only stop; context/agent/worker hooks remain active. */ }
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
    description: "Maintain one focused task, scope, acceptance criteria, progress, blockers, hypotheses and next action. recall searches portable cross-session observations/reflections in .context-forge (query or id; optional sessionId/includeInactive). set_task replaces an objective; update_task changes progress; complete_task completes it; supersede id=task replaces explicitly; read section=tasks retrieves history. Changes and archived claims are reference state, never authorization or current verification. Attribute sources and keep ambiguity explicit. Read first, then update after meaningful progress. No worker/model calls. Never mark a check passed unless actually performed.",
    parameters: PROJECT_MEMORY_SCHEMA,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      permitted(ctx);
      if (!raw || typeof raw !== "object") throw new Error("Project memory arguments must be an object.");
      const input = raw as unknown as MemoryChange | { action: "read"; id?: string; offset?: number; limit?: number; section?: "decisions" | "tasks" | "checks" | "sessions" } | { action: "diagnostics" } | { action: "recall"; query?: string; id?: string; sessionId?: string; object?: string; includeInactive?: boolean; offset?: number; limit?: number };
      const root = await projectRoot(ctx.cwd);
      const sessionId = ctx.sessionManager.getSessionId();
      if (input.action === "read" && input.section === "sessions") return {
        content: [{ type: "text", text: JSON.stringify(await archive.sessions(root, input.offset, input.limit)) }], details: {},
      };
      if (input.action === "recall") {
        await safeCheckpoint(ctx, root);
        const offset = input.offset ?? 0, limit = input.limit ?? 5;
        if (!Number.isInteger(offset) || offset < 0 || offset > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Archive recall offset must be 0–4096 and limit 1–10");
        const view = await archive.read(root, input);
        const pool = input.id ? view.records.filter(r => r.id === input.id) : selectArchive(view, input.query ?? "", 4096, input.includeInactive ?? false);
        const records = pool.slice(offset, offset + limit).map(r => ({ ...r, content: snippet(r.content, 1500), sourceEntryIds: r.sourceEntryIds?.slice(0, 16), supportingObservationIds: r.supportingObservationIds?.slice(0, 16), sources: r.sources.slice(0, 4).map(s => ({ ...s, ...(s.excerpt ? { excerpt: snippet(s.excerpt, 500) } : {}) })), preview: "Bounded content/references; read the saved object file for omitted archive fields." }));
        const result = { note: "Historical claims, not current verification or task authorization. Status is scoped to origin checkpoints. Source excerpts are bounded/redacted; tool output is not copied. Object files: .context-forge/archive/objects/<object>.json; original transcript may be needed for full evidence.", sessions: view.sessions, scannedObjects: view.objects, limited: view.limited, warnings: view.warnings.slice(0, 8),
          totalMatches: pool.length, nextOffset: offset + records.length < pool.length ? offset + records.length : null, records };
        while (JSON.stringify(result).length > 12000 && result.records.length) { result.records.pop(); result.nextOffset = offset + result.records.length; }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      }
      if (input.action === "read" && input.section === "checks") return {
        content: [{ type: "text", text: JSON.stringify({ receipts: receipts.list(sessionId, ctx.cwd), note: "Host metadata only. Missing results/exit codes and expected test execution remain unknown. Receipts expire on reload/session/cwd changes." }) }], details: {},
      };
      if (input.action === "diagnostics") {
        const state = await readMemory(root) ?? emptyMemory();
        const report = renderHandoff(state, await assessFreshness(root, state, reminderRecords(state)), { budget: 8000, selected: reminderRecords(state) });
        const archived = await archive.read(root);
        return { content: [{ type: "text", text: JSON.stringify({ view: "planned current handoff, not provider-wire evidence", schemaVersion: state.version, revision: state.revision, diagnostics: report.diagnostics,
          archive: { sessions: archived.sessions, objects: archived.objects, records: archived.records.length, limited: archived.limited, warnings: archived.warnings, orientationBudget: 3000, freshness: "historical; not automatically reverified", sessionsCreatedAutomatically: false },
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
        if (!["", "refresh", "diagnostics", "sync"].includes(args.trim())) throw new Error("Usage: /forge-memory [refresh|diagnostics|sync]");
        if (args.trim() === "sync") {
          const result = await checkpoint(ctx);
          const message = result.outcome === "empty" ? "No observational memory entries found in this session or its pending batches; no checkpoint was created."
            : result.outcome === "not-permitted" ? "Project archive checkpoint skipped: project memory is disabled or the project is untrusted."
            : `Project archive ${result.outcome}: ${result.objects} OM entries in this session checkpoint. Start a new session yourself; no session was created.`;
          ctx.ui.notify(message, "info"); return;
        }
        const root = await projectRoot(ctx.cwd);
        const state = args.trim() === "refresh" ? await refreshDocuments(root) : await readMemory(root);
        if (args.trim() === "diagnostics") {
          const current = state ?? emptyMemory();
          const f = await assessFreshness(root, current, reminderRecords(current));
          const view = await archive.read(root);
          ctx.ui.notify(JSON.stringify({ ...renderHandoff(current, f, { budget: 8000, selected: reminderRecords(current) }).diagnostics,
            archive: { sessions: view.sessions, records: view.records.length, limited: view.limited, warnings: view.warnings, orientationBudget: 3000 } }, null, 2), "info"); return;
        }
        const view = await archive.read(root);
        ctx.ui.notify([
          state ? renderReminder(state, await assessFreshness(root, state, reminderRecords(state)))
            : "No explicit task/decision note yet. Use project_memory to record the current authorized task.",
          `Portable archive: ${view.sessions} session checkpoint(s), ${view.records.length} record copies. Use project_memory action=recall or read section=sessions.`,
          ...(view.limited || view.warnings.length ? ["Archive scan limited/unavailable in part; inspect diagnostics."] : []),
        ].join("\n"), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  let registered = false;
  return {
    checkpoint: safeCheckpoint,
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
          await safeCheckpoint(ctx, root);
          const state = await readMemory(root);
          const view = await archive.read(root);
          const latestUser = [...messages].reverse().find(m => m.role === "user");
          const content = latestUser?.content;
          const query = typeof content === "string" ? content.slice(0, 1000) : Array.isArray(content) ? content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join(" ").slice(0, 1000) : "";
          const orientation = archiveOrientation(view, query, ctx.sessionManager.getSessionId());
          if (!state && !orientation) return messages.length === original.length ? undefined : { messages };
          const reminder: MemoryMessage = {
            role: "user",
            content: [{ type: "text", text: [state ? renderReminder(state, await assessFreshness(root, state, reminderRecords(state))) : "", orientation].filter(Boolean).join("\n\n") }],
            timestamp: Date.now(),
            contextForgeProjectMemory: true,
          };
          return { messages: [...(state ? withoutPersistedPrefix(messages) : messages), reminder] };
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
