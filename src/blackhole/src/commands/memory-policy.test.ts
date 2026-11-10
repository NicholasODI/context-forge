import { describe, expect, it, vi } from "vitest";
import { registerMemoryPolicyTool } from "./memory-policy";
import { foldLedger } from "../om/ledger/fold";
import { readPendingState } from "../om/pending";

vi.mock("../om/pending.js", () => ({ readPendingState: vi.fn(() => ({})) }));
function host(trusted = true) {
  const observations = [1, 2].map(n => ({ id: n.toString().padStart(12, "0"), content: `Fact ${n}`, timestamp: "2026-01-01 00:00", relevance: "high", sourceEntryIds: ["source"], tokenCount: 2 }));
  const entries: any[] = [{ type: "message", id: "source", message: { role: "user", content: "Facts" } },
    { type: "custom", id: "observations", customType: "om.observations.recorded", data: { coversUpToId: "source", observations } }];
  let tool: any;
  const appendEntry = vi.fn((customType, data) => entries.push({ type: "custom", id: `policy-${entries.length}`, customType, data }));
  registerMemoryPolicyTool({ registerTool: (value: unknown) => { tool = value; }, appendEntry } as any);
  const ctx = { isProjectTrusted: () => trusted, sessionManager: { getBranch: () => entries, getSessionId: () => "synthetic" } };
  return { tool, ctx, entries, observations, appendEntry };
}

describe("explicit memory policy tool", () => {
  it("pins and supersedes through the registered tool while retaining source records", async () => {
    const h = host();
    await h.tool.execute("pin", { action: "pin", id: h.observations[0].id, reason: "User constraint" }, undefined, undefined, h.ctx);
    await h.tool.execute("replace", { action: "supersede", id: h.observations[0].id, replacementId: h.observations[1].id, reason: "User corrected the fact" }, undefined, undefined, h.ctx);
    const folded = foldLedger(h.entries);
    expect(folded.observations).toHaveLength(2);
    expect(folded.activeObservations).toHaveLength(1);
    expect(folded.activeObservations[0].pinned).toBe(true);
    await expect(h.tool.execute("cycle", { action: "supersede", id: h.observations[1].id, replacementId: h.observations[0].id, reason: "Cycle" }, undefined, undefined, h.ctx)).rejects.toThrow("active replacement");
  });
  it("rejects untrusted writes and missing replacements without appending anything", async () => {
    const h = host(false);
    await expect(h.tool.execute("pin", { action: "pin", id: h.observations[0].id, reason: "x" }, undefined, undefined, h.ctx)).rejects.toThrow("trusted");
    expect(h.appendEntry).not.toHaveBeenCalled();
    const good = host();
    await expect(good.tool.execute("bad", { action: "supersede", id: good.observations[0].id, reason: "x" }, undefined, undefined, good.ctx)).rejects.toThrow("replacement");
    expect(good.appendEntry).not.toHaveBeenCalled();
  });
  it("recognizes manual-mode pending records without touching real session files", async () => {
    const h = host();
    const pending = { ...h.observations[0], id: "000000000003" };
    vi.mocked(readPendingState).mockReturnValueOnce({ observationBatches: [{ coversUpToId: "source", data: { observations: [pending] } }] });
    await h.tool.execute("pin", { action: "pin", id: pending.id, reason: "Pending user constraint" }, undefined, undefined, h.ctx);
    expect(h.appendEntry).toHaveBeenCalledWith("om.memory.policy", expect.objectContaining({ id: pending.id }));
  });
});
