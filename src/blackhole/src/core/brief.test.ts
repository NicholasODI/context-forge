import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { compileBrief } from "./brief";
import { normalize } from "./normalize";
import { compileSegment } from "./summarize";
import type { NormalizedBlock } from "../types";

function toolCall(args: Record<string, unknown>, name = "bash"): NormalizedBlock {
  return { kind: "tool_call", name, args, sourceIndex: 12 };
}

describe("brief transcript bash command shapes", () => {
  it("preserves an array command as data instead of treating it as shell syntax", () => {
    const summary = compileBrief([toolCall({ command: ["git", "status", "--short"] })]);
    expect(summary).toContain('[non-text command: ["git","status","--short"]]');
    expect(summary).toContain("#12");
  });

  it.each([false, 42, { script: "git status" }])("handles non-text command %j", (command) => {
    expect(compileBrief([toolCall({ command })])).toContain(
      `[non-text command: ${JSON.stringify(command)}]`,
    );
  });

  it("handles a non-text description when no command is available", () => {
    expect(compileBrief([toolCall({ description: { text: "status" } }, "Bash")])).toContain(
      '[non-text command: {"text":"status"}]',
    );
  });

  it("keeps normal command compression and textual description fallback", () => {
    expect(compileBrief([toolCall({ command: "cd /repo && git status\ngit diff" })])).toContain(
      'git status; git diff',
    );
    expect(compileBrief([toolCall({ description: "git status | head -20" })])).toContain('bash "git status"');
    expect(compileBrief([toolCall({})])).toContain('bash ""');
  });

  it("also handles non-text commands carried by persisted bashExecution messages", () => {
    // Session JSON is external input; a static Message annotation cannot
    // guarantee the shape of entries from older hosts or imported sessions.
    const messages = [{ role: "bashExecution", command: ["git", "status"], output: "", exitCode: 0 }];
    const summary = compileBrief(normalize(messages as unknown as Message[]));
    expect(summary).toContain('[non-text command: ["git","status"]]');
  });

  it("bounds non-text command previews without losing the following task", () => {
    const summary = compileBrief([
      toolCall({ command: { script: "x".repeat(10_000) } }),
      { kind: "user", text: "Continue fixing the observer", sourceIndex: 13 },
    ]);
    expect(summary).toContain("[non-text command:");
    expect(summary).toContain("Continue fixing the observer");
    expect(summary.length).toBeLessThan(400);
  });

  it("compiles a complete summary from session history containing a structured bash command", () => {
    const messages = [
      { role: "user", content: "Fix the observer crash", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: ["git", "status"] } }],
        timestamp: 2,
      },
    ] as unknown as Message[];
    const summary = compileSegment({ messages });
    expect(summary).toContain("Fix the observer crash");
    expect(summary).toContain('[non-text command: ["git","status"]]');
  });
});
