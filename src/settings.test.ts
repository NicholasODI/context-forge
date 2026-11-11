import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadContextForgeConfig } from "./config.ts";
import {
  openForgeSettings,
  registerForgeSettings,
  saveSettings,
} from "./settings.ts";

function ui(
  choices: (number | undefined)[],
  inputs: (string | undefined)[] = [],
) {
  return {
    select: vi.fn(async (_title: string, options: string[]) => {
      const index = choices.shift();
      return index === undefined ? undefined : options[index];
    }),
    input: vi.fn(async () => inputs.shift()),
    notify: vi.fn(),
  };
}
it("discards staged toggles on Escape", async () => {
  const save = vi.fn();
  await openForgeSettings(ui([0, undefined]), DEFAULT_CONFIG, save);
  expect(save).not.toHaveBeenCalled();
  expect(DEFAULT_CONFIG.actionFusion).toBe(true);
});
it("validates fields and saves toggles, trimmed strings, and zero ratio", async () => {
  const menu = ui(
    [0, 8, 8, 9, 10, 10, 10, 12],
    [" ", " model ", " provider ", "", "Infinity", "0"],
  );
  const save = vi.fn();
  await openForgeSettings(menu, DEFAULT_CONFIG, save);
  expect(menu.notify.mock.calls.filter((c) => c[1] === "error")).toHaveLength(
    3,
  );
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    actionFusion: false,
    evidencePreservingReducerModel: "model",
    evidencePreservingReducerProvider: "provider",
    cacheWriteReadRatio: 0,
  });
});
it("stages reset and reports failed saves", async () => {
  const save = vi.fn();
  await openForgeSettings(
    ui([11, 12]),
    { ...DEFAULT_CONFIG, actionFusion: false },
    save,
  );
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
  const menu = ui([12, undefined]);
  await openForgeSettings(menu, DEFAULT_CONFIG, () => {
    throw new Error("read only");
  });
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
    expect(() => saveSettings(path, DEFAULT_CONFIG, original)).toThrow(
      "changed",
    );
    expect(readFileSync(path, "utf8")).toBe("external edit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("routes advanced settings through the shared runtime callback", async () => {
  let handler: (args: string, ctx: any) => Promise<void> = async () => {};
  const api = {
    registerCommand: (_name: string, command: any) => {
      handler = command.handler;
    },
  };
  const advanced = vi.fn(async () => {});
  registerForgeSettings(api as any, advanced);
  const menu = ui([1]);
  const ctx = { hasUI: true, ui: menu };
  await handler("", ctx);
  expect(advanced).toHaveBeenCalledExactlyOnceWith(ctx);
  expect(menu.select).toHaveBeenCalledTimes(1);
});
it("shows continuation information without opening advanced settings or writing files", async () => {
  let handler: (args: string, ctx: any) => Promise<void> = async () => {};
  const advanced = vi.fn(async () => {});
  registerForgeSettings(
    {
      registerCommand: (_name: string, command: any) => {
        handler = command.handler;
      },
    } as any,
    advanced,
  );
  const menu = ui([2]);
  await handler("", { hasUI: true, ui: menu });
  expect(advanced).not.toHaveBeenCalled();
  expect(menu.notify.mock.calls[0][0]).toContain("3,000");
  expect(menu.notify.mock.calls[0][0]).toContain("/forge-memory diagnostics");
});

it("advanced recall and retained-output controls accept opt-out zero and reject invalid budgets", async () => {
  const { config } = await import(
    "./blackhole/src/pi-base/blackhole-settings.ts"
  );
  const { DEFAULTS } = await import("./blackhole/src/core/unified-config.ts");
  // Inspect the schema consumed by the existing ConfigManager modal and validator.
  const { opts } = config as unknown as {
    opts: {
      fields: (value: typeof DEFAULTS) => Array<{ key: string; min?: number }>;
      validate: (raw: Record<string, unknown>) => typeof DEFAULTS;
    };
  };
  const fields = opts.fields(DEFAULTS);
  for (const key of [
    "recallResponseMaxChars",
    "retainedToolOutputMaxTokens",
  ] as const) {
    expect(fields.find((field) => field.key === key)?.min).toBe(0);
    expect(opts.validate({ [key]: 0 })[key]).toBe(0);
    expect(opts.validate({ [key]: 12000 })[key]).toBe(12000);
    for (const invalid of [-1, 1.5, Infinity, "12000"]) {
      expect(opts.validate({ [key]: invalid })[key]).toBe(DEFAULTS[key]);
    }
  }
});

it("runtime and modal agree on numeric counterexamples and preserve zero opt-outs", async () => {
  const { config } = await import(
    "./blackhole/src/pi-base/blackhole-settings.ts"
  );
  const { loadUnifiedConfig, __setTestConfigDir, DEFAULTS } = await import(
    "./blackhole/src/core/unified-config.ts"
  );
  const { NUMERIC_KEYS } = await import(
    "./blackhole/src/core/numeric-fields.ts"
  );
  const { mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "forge-schema-"));
  const modal = config as unknown as {
    opts: { validate(raw: Record<string, unknown>): typeof DEFAULTS };
  };
  try {
    __setTestConfigDir(dir);
    mkdirSync(join(dir, "pi-blackhole"));
    for (const value of [-1, 0, 1.5, "1000", 12000]) {
      const raw = Object.fromEntries(NUMERIC_KEYS.map((key) => [key, value]));
      writeFileSync(
        join(dir, "pi-blackhole", "pi-blackhole-config.json"),
        JSON.stringify(raw),
      );
      const runtime = loadUnifiedConfig(dir),
        edited = modal.opts.validate(raw);
      for (const key of NUMERIC_KEYS)
        expect(edited[key], `${key}: ${value}`).toEqual(runtime[key]);
    }
  } finally {
    __setTestConfigDir(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
