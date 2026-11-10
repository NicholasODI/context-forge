import { describe, expect, it } from "vitest";
import { CheckReceipts } from "./check-receipts";

const call = (id = "call-1") => ({ toolName: "bash", toolCallId: id, input: { command: "API_KEY=DO_NOT_STORE npm test" } });
describe("bounded shell metadata receipts", () => {
  it("distinguishes requested, result received, observed exit and unknown tests without retaining secrets/stdout", () => {
    const receipts = new CheckReceipts();
    receipts.request("A", call());
    const id = receipts.list("A")[0].id;
    expect(receipts.list("A")[0].phase).toBe("requested");
    expect(() => receipts.resolve("A", [id])).toThrow("no matching result");
    receipts.result("A", { ...call(), isError: false, structuredContent: { output: "44 tests passed, DO_NOT_STORE" } });
    expect(receipts.list("A")[0]).toMatchObject({ phase: "result_received", exitCode: null, expectedTestsExecuted: "unknown" });
    receipts.result("A", { ...call(), isError: false, structuredContent: { exit_code: 0, output: "44 tests passed, DO_NOT_STORE" } });
    expect(receipts.resolve("A", [id])[0]).toMatchObject({ phase: "completed", exitCode: 0, expectedTestsExecuted: "unknown" });
    expect(JSON.stringify(receipts.list("A"))).not.toContain("DO_NOT_STORE");
    expect(JSON.stringify(receipts.list("A"))).not.toContain("44 tests");
  });
  it("does not attach unmatched, mutated-input, cross-session or stale results", () => {
    const receipts = new CheckReceipts();
    receipts.request("A", call());
    receipts.result("A", { ...call(), input: { command: "different" }, isError: false, structuredContent: { exit_code: 0 } });
    expect(receipts.list("A")[0].phase).toBe("requested");
    receipts.request("B", call("new-call"));
    receipts.result("A", { ...call(), isError: false, structuredContent: { exit_code: 0 } });
    expect(receipts.list("B")).toHaveLength(1);
    expect(receipts.list("B")[0].toolCallId).toBe("new-call");
  });
  it("evicts older receipts and does not infer exits from an error flag or wrong output field", () => {
    const receipts = new CheckReceipts();
    for (let n = 0; n < 20; n++) receipts.request("A", call(`call-${n}`));
    expect(receipts.list("A")).toHaveLength(16);
    receipts.result("A", { ...call("call-19"), isError: false, structuredContent: { exitCode: 0 } });
    expect(receipts.list("A").at(-1)).toMatchObject({ phase: "result_received", exitCode: null });
  });
  it("does not attach receipts from another cwd and deduplicates explicit attachments", () => {
    const receipts = new CheckReceipts();
    receipts.request("A", call(), "project-a");
    receipts.result("A", { ...call(), isError: false, structuredContent: { exit_code: 0 } }, "project-a");
    const id = receipts.list("A", "project-a")[0].id;
    expect(receipts.resolve("A", [id, id], "project-a")).toHaveLength(1);
    expect(() => receipts.resolve("A", [id], "project-b")).toThrow("no matching result");
  });
});
