import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
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
    [0, 8, 8, 9, 10, 10, 10, 14],
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
it("picks a separate consolidator model from OMP models and toggles pre-compaction consolidation", async () => {
  const menu = ui([
    11, // open Consolidator model picker
    2, // pick 2nd OMP model ("openai/gpt-5-mini") — index 0 is default, 1 is 1st model, 2 is 2nd model
    12, // toggle Consolidate before compaction -> ON
    14, // Save and close
  ]);
  const save = vi.fn();
  await openForgeSettings(menu, DEFAULT_CONFIG, save, {
    listModels: () => [
      { value: "anthropic/claude-haiku-4-5", label: "anthropic/claude-haiku-4-5 (Haiku 4.5)" },
      { value: "openai/gpt-5-mini", label: "openai/gpt-5-mini (GPT-5 Mini)" },
    ],
  });
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    consolidatorModel: "openai/gpt-5-mini",
    consolidateBeforeCompaction: true,
  });
});
it("validates manual consolidator model entry and allows resetting to default", async () => {
  const menu = ui(
    [
      11, 1, // open Consolidator model -> manual entry (index 1 when listModels empty)
      11, 1, // retry manual entry with valid provider/model
      11, 0, // reset to default
      11, 1, // enter valid provider/model again
      14, // Save and close
    ],
    ["missing-slash", "anthropic/claude-haiku-4-5", " google/gemini-2.5-flash "],
  );
  const save = vi.fn();
  await openForgeSettings(menu, DEFAULT_CONFIG, save);
  expect(menu.notify.mock.calls.filter((c) => c[1] === "error")).toHaveLength(1);
  expect(save).toHaveBeenCalledWith({
    ...DEFAULT_CONFIG,
    consolidatorModel: "google/gemini-2.5-flash",
  });
});
it("stages reset and reports failed saves", async () => {
  const save = vi.fn();
  await openForgeSettings(
    ui([13, 14]),
    { ...DEFAULT_CONFIG, actionFusion: false },
    save,
  );
  expect(save).toHaveBeenCalledWith(DEFAULT_CONFIG);
  const menu = ui([14, undefined]);
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

it("loads global and project-local consolidatorModel and consolidateBeforeCompaction settings", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "forge-global-"));
  const projectDir = mkdtempSync(join(tmpdir(), "forge-project-"));
  try {
    saveSettings(
      join(globalDir, "context-forge.json"),
      {
        ...DEFAULT_CONFIG,
        consolidatorModel: "anthropic/claude-haiku-4-5",
        consolidateBeforeCompaction: true,
      },
      undefined,
    );
    const fromGlobal = loadContextForgeConfig(projectDir, globalDir, true);
    expect(fromGlobal.consolidatorModel).toBe("anthropic/claude-haiku-4-5");
    expect(fromGlobal.consolidateBeforeCompaction).toBe(true);

    saveSettings(
      join(projectDir, CONFIG_DIR_NAME, "context-forge.json"),
      {
        ...DEFAULT_CONFIG,
        consolidatorModel: "openai/gpt-5-mini",
        consolidateBeforeCompaction: false,
      },
      undefined,
    );
    // Untrusted project ignores local override and keeps global
    const untrusted = loadContextForgeConfig(projectDir, globalDir, false);
    expect(untrusted.consolidatorModel).toBe("anthropic/claude-haiku-4-5");
    expect(untrusted.consolidateBeforeCompaction).toBe(true);

    // Trusted project applies local override
    const trusted = loadContextForgeConfig(projectDir, globalDir, true);
    expect(trusted.consolidatorModel).toBe("openai/gpt-5-mini");
    expect(trusted.consolidateBeforeCompaction).toBe(false);

    // Invalid consolidatorModel throws
    writeFileSync(
      join(projectDir, CONFIG_DIR_NAME, "context-forge.json"),
      JSON.stringify({ version: 1, consolidatorModel: "no-slash" }),
    );
    expect(() => loadContextForgeConfig(projectDir, globalDir, true)).toThrow(
      "consolidatorModel",
    );
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

it("blackhole settings exposes consolidator model picker and consolidateBeforeCompaction in global and project scopes", async () => {
  const { config } = await import(
    "./blackhole/src/pi-base/blackhole-settings.ts"
  );
  const { DEFAULTS, loadUnifiedConfig, __setTestConfigDir } = await import(
    "./blackhole/src/core/unified-config.ts"
  );
  const { mkdirSync } = await import("node:fs");

  const globalRoot = mkdtempSync(join(tmpdir(), "bh-global-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "bh-project-"));
  const globalDir = join(globalRoot, "pi-blackhole");
  mkdirSync(globalDir, { recursive: true });
  try {
    __setTestConfigDir(globalRoot);
    const { opts } = config as unknown as {
      opts: {
        fields: (value: typeof DEFAULTS) => Array<{ key: string; type: string; value: unknown }>;
        validate: (raw: Record<string, unknown>) => typeof DEFAULTS;
      };
    };

    const fields = opts.fields(DEFAULTS);
    expect(fields.find((f) => f.key === "model")?.type).toBe("model");
    expect(fields.find((f) => f.key === "consolidateBeforeCompaction")?.type).toBe("boolean");

    // Modal ModelValue converts to OmModelConfig and clears cleanly on "(session model)"
    const converted = opts.validate({
      model: { id: "anthropic/claude-haiku-4-5", thinking: "low" },
      consolidateBeforeCompaction: true,
    });
    expect(converted.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
      thinking: "low",
    });
    expect(converted.consolidateBeforeCompaction).toBe(true);

    const cleared = opts.validate({ model: { id: "", thinking: "medium" } });
    expect(cleared.model).toBeUndefined();

    // Global + project-local persistence round-trip via ConfigManager.save + loadUnifiedConfig
    config.save(converted, "global", projectRoot, globalDir);
    const loadedGlobal = loadUnifiedConfig(projectRoot);
    expect(loadedGlobal.model).toEqual({
      provider: "anthropic",
      id: "claude-haiku-4-5",
      thinking: "low",
    });
    expect(loadedGlobal.consolidateBeforeCompaction).toBe(true);

    const projectConfig = opts.validate({
      model: { id: "openai/gpt-5-mini", thinking: "minimal" },
      consolidateBeforeCompaction: false,
    });
    config.save(projectConfig, "project", projectRoot, globalDir);
    const loadedLocal = loadUnifiedConfig(projectRoot);
    expect(loadedLocal.model).toEqual({
      provider: "openai",
      id: "gpt-5-mini",
      thinking: "minimal",
    });
    expect(loadedLocal.consolidateBeforeCompaction).toBe(false);
  } finally {
    __setTestConfigDir(undefined);
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
