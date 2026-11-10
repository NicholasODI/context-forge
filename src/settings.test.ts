import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadContextForgeConfig } from "./config.ts";
import { openForgeSettings, saveSettings } from "./settings.ts";

function ui(choices: (number | undefined)[], inputs: (string | undefined)[] = []) {
 return {
  select: vi.fn(async (_title: string, options: string[]) => { const index = choices.shift(); return index === undefined ? undefined : options[index]; }),
  input: vi.fn(async () => inputs.shift()), notify: vi.fn(),
 };
}
it("discards staged toggles on Escape", async () => {
 const save = vi.fn();
 await openForgeSettings(ui([0, undefined]), DEFAULT_CONFIG, save);
 expect(save).not.toHaveBeenCalled();
 expect(DEFAULT_CONFIG.actionFusion).toBe(true);
});
it("validates fields and saves toggles, trimmed strings, and zero ratio", async () => {
 const menu = ui([0, 8, 8, 9, 10, 10, 10, 12], [" ", " model ", " provider ", "", "Infinity", "0"]);
 const save = vi.fn();
 await openForgeSettings(menu, DEFAULT_CONFIG, save);
 expect(menu.notify.mock.calls.filter(c => c[1] === "error")).toHaveLength(3);
 expect(save).toHaveBeenCalledWith({ ...DEFAULT_CONFIG, actionFusion: false, evidencePreservingReducerModel: "model", evidencePreservingReducerProvider: "provider", cacheWriteReadRatio: 0 });
});
it("stages reset and reports failed saves", async () => {
 const save = vi.fn();
 await openForgeSettings(ui([11, 12]), { ...DEFAULT_CONFIG, actionFusion: false }, save);
 expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
 const menu = ui([12, undefined]);
 await openForgeSettings(menu, DEFAULT_CONFIG, () => { throw new Error("read only"); });
 expect(menu.notify).toHaveBeenCalledExactlyOnceWith("read only", "error");
});
it("writes reloadable settings and preserves external changes", () => {
 const dir = mkdtempSync(join(tmpdir(), "forge-settings-"));
 try {
  const path = join(dir, "context-forge.json");
  saveSettings(path, { ...DEFAULT_CONFIG, unifiedRecall: false }, undefined);
  expect(loadContextForgeConfig(dir, dir).unifiedRecall).toBe(false);
  const original = readFileSync(path, "utf8");
  writeFileSync(path, "external edit");
  expect(() => saveSettings(path, DEFAULT_CONFIG, original)).toThrow("changed");
  expect(readFileSync(path, "utf8")).toBe("external edit");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
