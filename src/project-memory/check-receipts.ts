import { createHash } from "node:crypto";
export interface CheckReceipt {
  id: string;
  toolCallId: string;
  sessionId: string;
  tool: string;
  commandDigest: string;
  requestedAt: string;
  resultAt?: string;
  phase: "requested" | "result_received" | "completed";
  exitCode: number | null;
  isError?: boolean;
  expectedTestsExecuted: "unknown";
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Bounded in-memory receipts. Only explicit attachment writes durable state. */
export class CheckReceipts {
  private receipts = new Map<string, CheckReceipt>();
  private currentSession?: string;
  private selectSession(session: string, scope = "") {
    const key = digest([session, scope]);
    if (key !== this.currentSession) { this.receipts.clear(); this.currentSession = key; }
  }
  request(session: string, event: { toolName: string; toolCallId: string; input: unknown }, scope = ""): void {
    this.selectSession(session, scope);
    if (!["bash", "powershell"].includes(event.toolName)) return;
    const id = `check-${digest([session, event.toolCallId]).slice(0, 12)}`;
    // Duplicate request events must not overwrite a completed receipt.
    if (this.receipts.has(id)) return;
    this.receipts.set(id, { id, sessionId: session, toolCallId: event.toolCallId, tool: event.toolName,
      commandDigest: digest(event.input), requestedAt: new Date().toISOString(), phase: "requested", exitCode: null, expectedTestsExecuted: "unknown" });
    while (this.receipts.size > 16) this.receipts.delete(this.receipts.keys().next().value!);
  }
  result(session: string, event: { toolName: string; toolCallId: string; input: unknown; isError: boolean; structuredContent?: unknown }, scope = ""): void {
    if (digest([session, scope]) !== this.currentSession) return; // late results cannot erase another session's receipts
    const receipt = this.receipts.get(`check-${digest([session, event.toolCallId]).slice(0, 12)}`);
    if (!receipt || receipt.tool !== event.toolName || receipt.commandDigest !== digest(event.input)) return;
    const structured = event.structuredContent;
    const code = structured && typeof structured === "object" && !Array.isArray(structured)
      ? (structured as Record<string, unknown>).exit_code : undefined;
    // This is the documented built-in shell structured output field. Never
    // infer exit status or test counts from prose, stdout, or isError=false.
    receipt.exitCode = Number.isSafeInteger(code) ? code as number : null;
    receipt.phase = receipt.exitCode === null ? "result_received" : "completed";
    receipt.resultAt = new Date().toISOString(); receipt.isError = event.isError;
  }
  list(session: string, scope = ""): CheckReceipt[] {
    this.selectSession(session, scope);
    return [...this.receipts.values()].map(r => ({ ...r }));
  }
  resolve(session: string, ids: string[], scope = ""): CheckReceipt[] {
    const available = this.list(session, scope);
    return [...new Set(ids)].map(id => {
      const receipt = available.find(r => r.id === id);
      if (!receipt || receipt.phase === "requested") throw new Error(`Check ${id} has no matching result in this session; read check receipts first.`);
      return { ...receipt };
    });
  }
}
