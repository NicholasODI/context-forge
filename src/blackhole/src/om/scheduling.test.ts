import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../core/unified-config.ts";
import { planStages, anyStageDue, type SchedulingState } from "./scheduling.ts";
import type { Entry } from "./ledger/index.ts";

const source = (text: string): Entry =>
  ({
    type: "message",
    id: "e1",
    message: { role: "user", content: text, timestamp: 1 },
  }) as Entry;
const state = (threshold: number): SchedulingState => ({
  config: {
    ...DEFAULTS,
    observeAfterTokens: threshold,
    reflectAfterTokens: 1e9,
  },
  cursors: {},
});
describe("read-only scheduling", () => {
  it("can repeat a due decision without consuming coverage or executing a worker", () => {
    const entries = [source("facts ".repeat(100))];
    const snapshot = state(1),
      before = structuredClone(snapshot);
    expect(planStages(entries, snapshot)).toEqual({
      observer: true,
      reflector: false,
      dropper: false,
    });
    expect(planStages(entries, snapshot)).toEqual(planStages(entries, before));
    expect(snapshot).toEqual(before);
    expect(anyStageDue(entries, snapshot)).toBe(true);
  });
  it("does not schedule empty or below-threshold sources just because checks repeat", () => {
    const snapshot = state(1e9);
    for (let i = 0; i < 4; i++) {
      expect(anyStageDue([], snapshot)).toBe(false);
      expect(anyStageDue([source("small")], snapshot)).toBe(false);
    }
  });
  it("a lost observer cursor falls back to actual coverage rather than suppressing work", () => {
    const snapshot = state(1);
    snapshot.cursors!.observer = {
      entryId: "missing",
      state: "not_due",
    } as any;
    expect(planStages([source("new facts")], snapshot).observer).toBe(true);
  });
});
