import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  FORGE_FIELDS,
  validForgeValue,
  loadContextForgeConfig,
  type ContextForgeConfig,
} from "./config.ts";

interface SettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** Atomic replacement with an optimistic check against changes made while the menu was open. */
export function saveSettings(
  path: string,
  config: ContextForgeConfig,
  original: string | undefined,
): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current !== original)
    throw new Error(
      "Configuration changed while settings were open. Reopen the menu before saving.",
    );
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function openForgeSettings(
  ui: SettingsUI,
  initial: ContextForgeConfig,
  save: (config: ContextForgeConfig) => void,
): Promise<void> {
  let draft = { ...initial };
  while (true) {
    const options = [
      ...FORGE_FIELDS.map(
        (field) =>
          `${field.label}: ${field.kind === "boolean" ? (draft[field.key] ? "ON" : "OFF") : draft[field.key]}`,
      ),
      "Reset draft to built-in defaults",
      "Save and close (restart required)",
      "Cancel",
    ];
    const choice = await ui.select(
      "Context Forge — arrows + Enter; Esc discards unsaved changes",
      options,
    );
    if (!choice || choice === "Cancel") return;
    const index = options.indexOf(choice);
    const field = FORGE_FIELDS[index];
    if (field) {
      if (field.kind === "boolean")
        draft = { ...draft, [field.key]: !draft[field.key] };
      else {
        const value = await ui.input(
          field.kind === "number"
            ? `${field.label} (finite number, zero or greater)`
            : `${field.label} (default = executor selection)`,
          String(draft[field.key]),
        );
        if (value === undefined) continue;
        const parsed =
          field.kind === "number"
            ? value.trim()
              ? Number(value)
              : NaN
            : value.trim();
        if (!validForgeValue(field, parsed))
          ui.notify(
            field.kind === "number"
              ? "Enter a finite number, zero or greater."
              : "Enter a non-empty value.",
            "error",
          );
        else draft = { ...draft, [field.key]: parsed };
      }
    } else if (choice === "Reset draft to built-in defaults")
      draft = { ...DEFAULT_CONFIG };
    else if (choice === "Save and close (restart required)") {
      try {
        save(draft);
        ui.notify(
          "Settings saved. Restart OMP to apply all changes. Advanced tuning: /blackhole settings.",
          "info",
        );
        return;
      } catch (error) {
        ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }
  }
}

export function registerForgeSettings(
  pi: ExtensionAPI,
  openAdvanced: (
    ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
  ) => Promise<void>,
): void {
  pi.registerCommand("context-forge", {
    description:
      "Configure features, compaction, memory workers, retention and recall",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const section = await ctx.ui.select("Context Forge settings", [
        "Features and reducer (restart required)",
        "Compaction, memory workers, retention and recall",
        "Continuation state and evidence — information",
        "Close",
      ]);
      if (!section || section === "Close") return;
      if (section === "Compaction, memory workers, retention and recall") {
        try {
          await openAdvanced(ctx);
        } catch (error) {
          ctx.ui.notify(
            `Unable to open advanced settings: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }
      if (section === "Continuation state and evidence — information") {
        ctx.ui.notify(
          "Project memory is controlled by the Project memory feature toggle. Focused continuation, goal supersession and check receipts follow the saved task state, not separate feature switches. Fixed safety budgets: Resume Context body 3,000 characters (3,200 with markers), live reminder 8,000, tool previews 16,000. Use /forge-memory to inspect state and /forge-memory diagnostics for omissions, freshness and attribution. Manage task records through project_memory. These records do not authorize work; check receipts do not prove expected tests ran.",
          "info",
        );
        return;
      }
      const global = "Global defaults";
      const project = "Project settings (override global defaults)";
      const scope = await ctx.ui.select(
        "Context Forge — choose save scope; advanced tuning: /blackhole settings",
        ctx.isProjectTrusted() ? [global, project] : [global],
      );
      if (!scope) return;
      const isProject = scope === project;
      if (isProject && !ctx.isProjectTrusted()) return;
      const directory = isProject
        ? join(ctx.cwd, CONFIG_DIR_NAME)
        : getAgentDir();
      const path = join(directory, "context-forge.json");
      try {
        const original = existsSync(path)
          ? readFileSync(path, "utf8")
          : undefined;
        // Match the runtime loader's scope resolution. A new project file starts from global settings.
        const initial = loadContextForgeConfig(
          ctx.cwd,
          getAgentDir(),
          isProject,
        );
        await openForgeSettings(ctx.ui, initial, (config) => {
          if (isProject && !ctx.isProjectTrusted())
            throw new Error(
              "Project trust is required to save project settings.",
            );
          saveSettings(path, config, original);
        });
      } catch (error) {
        ctx.ui.notify(
          `Unable to open settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
