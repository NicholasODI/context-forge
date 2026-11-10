import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OM_MEMORY_POLICY, type MemoryPolicy } from "../om/ledger/policy.js";
import { livePoolObservations, livePoolReflections } from "../om/ledger/progress.js";
import { readPendingState } from "../om/pending.js";
import { type Entry } from "../om/ledger/types.js";

export function registerMemoryPolicyTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_policy",
    label: "Memory policy",
    description: "Explicitly pin/unpin, invalidate, or supersede an observation/reflection. Use for important constraints or demonstrated corrections, never to satisfy a pruning quota. Source evidence stays archived. Pinning may block compaction if the pinned core cannot fit; keep it small.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action", "id", "reason"],
      properties: {
        action: { type: "string", enum: ["pin", "unpin", "invalidate", "supersede"] },
        id: { type: "string", pattern: "^[a-f0-9]{12}$" },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
        replacementId: { type: "string", pattern: "^[a-f0-9]{12}$" },
      },
    },
    async execute(_id, raw, _signal, _update, ctx) {
      if (!ctx.isProjectTrusted()) throw new Error("Memory policy requires a trusted project.");
      if (!raw || typeof raw !== "object") throw new Error("Invalid memory policy.");
      const policy = raw as unknown as MemoryPolicy;
      if (!["pin", "unpin", "invalidate", "supersede"].includes(policy.action) || !/^[a-f0-9]{12}$/.test(policy.id) || typeof policy.reason !== "string" || !policy.reason.trim() || policy.reason.length > 1000) throw new Error("Invalid memory policy.");
      const entries = ctx.sessionManager.getBranch() as Entry[];
      const pending = readPendingState(ctx.sessionManager.getSessionId());
      const active = [...livePoolObservations(entries, pending), ...livePoolReflections(entries, pending)];
      if (!active.some(r => r.id === policy.id)) throw new Error("Memory ID is missing or inactive; use recall to inspect its history.");
      if (policy.action === "supersede" && (policy.id === policy.replacementId || !active.some(r => r.id === policy.replacementId))) throw new Error("Supersession requires a different active replacement ID.");
      pi.appendEntry(OM_MEMORY_POLICY, policy);
      return { content: [{ type: "text", text: `Memory policy recorded: ${policy.action} ${policy.id}. Original evidence retained.` }], details: policy };
    },
  });
}
