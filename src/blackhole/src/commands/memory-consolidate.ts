/**
 * /blackhole-consolidate — manually launch the memory consolidation pipeline.
 *
 * Routes through the exact same guarded entry the automatic agent_start /
 * turn_end triggers use (consolidation.ts → triggerConsolidation), so a
 * manual run gets the identical lifecycle protections: config gates,
 * in-flight single-flight, retry gate, cursor loading/validation, and
 * session-change generation capture. It cannot double-launch a pipeline
 * that is already running; every possible skip reason is reported via UI
 * notification (and to the debug log) instead of failing silently.
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../om/runtime.ts";
import { triggerConsolidation } from "../om/consolidation.ts";
import type { ConsolidationCtx } from "../om/consolidation.ts";

/** User-facing text for each internal skip reason. */
const SKIP_MESSAGES: Record<string, string> = {
  memory_false: "memory is disabled in config (memory: false)",
  provider_skip: "the current provider is excluded from blackhole consolidation",
  legacy_passive: "legacy passive=true config disables automatic memory workers",
  in_flight: "a consolidation is already in flight — run /blackhole-memory to watch it",
  retry_gated: "retry gate active after a recent failure (backoff in progress)",
  no_stage_due: "no stage is due — nothing new past the token thresholds since the last run",
  stale_ctx: "the session context went stale between trigger and launch",
  generation_inactive: "the session changed after launch was captured",
};

export function registerMemoryConsolidateCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("blackhole-consolidate", {
    description:
      "Manually launch the memory consolidation pipeline now (observer → reflector → dropper). " +
      "Runs through the same guards as the automatic trigger; reports the skip reason if it cannot launch.",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const omCtx: ConsolidationCtx = {
        cwd: ctx.cwd,
        hasUI: ctx.hasUI,
        ui: ctx.ui,
        model: ctx.model,
        modelRegistry: ctx.modelRegistry,
        sessionManager: ctx.sessionManager,
      };
      const result = triggerConsolidation(pi, runtime, omCtx);
      if (result.outcome === "launched") {
        ctx.ui.notify(
          "Consolidation launched (observer → reflector → dropper). Check /blackhole-memory for progress.",
          "info",
        );
      } else {
        ctx.ui.notify(`Consolidation skipped: ${SKIP_MESSAGES[result.reason] ?? result.reason}`, "warning");
      }
    },
  });
}