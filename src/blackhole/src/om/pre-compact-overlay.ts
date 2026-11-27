/**
 * Interactive progress overlay for synchronous pre-compaction consolidation.
 *
 * OMP enforces a 30s timeout (`EXTENSION_HANDLER_TIMEOUT_MS`) on event handlers,
 * including `session_before_compact`, EXCEPT while a host UI overlay opened via
 * `ctx.ui.custom()` is mounted (time spent in host dialogs pauses the handler
 * timeout budget). Mounting a live progress overlay during pre-compaction
 * consolidation both shows live Observer → Reflector → Dropper progress (with
 * Esc to skip) and prevents slow local/reasoning consolidator models from
 * hitting the 30s handler timeout during compaction.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type OverlayOptions,
  type TUI,
} from "../../../tui-compat.ts";
import {
  consolidateBeforeCompaction,
  remainingUnobservedTokens,
  shouldRunPreCompactionConsolidation,
  type ConsolidationCtx,
  type PreCompactionConsolidationResult,
} from "./consolidation.ts";
import { readPendingState } from "./pending.ts";
import { isManualMode } from "../core/unified-config.ts";
import type { Entry } from "./ledger/index.ts";
import type { Runtime } from "./runtime.ts";

interface CustomOverlayUI {
  custom?: <T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: unknown,
      done: (result: T) => void,
    ) => Component | Promise<Component>,
    options?: {
      overlay?: boolean;
      overlayOptions?: OverlayOptions;
      signal?: AbortSignal;
    },
  ) => Promise<T>;
}

const PROGRESS_OVERLAY_OPTIONS: OverlayOptions = {
  width: "70%",
  minWidth: 50,
  anchor: "center",
};

const PROGRESS_BAR_WIDTH = 20;

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
}

function phaseLabel(phase: Runtime["consolidationPhase"]): string {
  if (phase === "observer") return "Observer (extracting observations)";
  if (phase === "reflector") return "Reflector (synthesizing reflections)";
  if (phase === "dropper") return "Dropper (pruning superseded observations)";
  return "Preparing consolidation pipeline...";
}

function modelLabel(runtime: Runtime, ctx: ConsolidationCtx): string {
  const configured = runtime.config.model;
  if (configured?.provider && configured?.id) {
    return `${configured.provider}/${configured.id}`;
  }
  const sessionModel = ctx.model as { provider?: string; id?: string } | undefined;
  if (sessionModel?.provider && sessionModel?.id) {
    return `${sessionModel.provider}/${sessionModel.id} (session)`;
  }
  return "(session model)";
}

function safeRemainingTokens(runtime: Runtime, ctx: ConsolidationCtx): number | undefined {
  try {
    const entries = ctx.sessionManager.getBranch() as Entry[];
    const pending = isManualMode(runtime.config)
      ? readPendingState(ctx.sessionManager.getSessionId())
      : undefined;
    return remainingUnobservedTokens(entries, runtime, pending);
  } catch {
    return undefined;
  }
}

export interface OverlayTokenProgress {
  readonly processedTokens: number;
  readonly remainingTokens: number;
  readonly totalTokens: number;
  readonly percent: number;
}

/**
 * Compute token-based progress for the active consolidation stage
 * (Observer → Reflector → Dropper) from tokens left vs. stage initial tokens.
 */
export function computeOverlayTokenProgress(
  runtime: Runtime,
  ctx: ConsolidationCtx,
  initialObserverTokens: number | undefined,
): OverlayTokenProgress {
  const progress = runtime.consolidationProgress;
  const activeStage = progress?.stage ?? runtime.consolidationPhase;

  if ((activeStage === "reflector" || activeStage === "dropper") && progress) {
    const remainingTokens = Math.max(0, progress.backlogTokens);
    const totalTokens = Math.max(progress.stageInitialTokens, remainingTokens);
    const processedTokens = Math.max(0, totalTokens - remainingTokens);
    const percent =
      totalTokens > 0
        ? Math.min(100, Math.max(0, Math.round((processedTokens / totalTokens) * 100)))
        : 100;
    return { processedTokens, remainingTokens, totalTokens, percent };
  }

  const remainingTokens = Math.max(
    0,
    safeRemainingTokens(runtime, ctx) ?? progress?.backlogTokens ?? initialObserverTokens ?? 0,
  );
  const totalTokens = Math.max(
    initialObserverTokens ?? 0,
    progress?.stageInitialTokens ?? 0,
    remainingTokens,
  );
  const processedTokens = Math.max(0, totalTokens - remainingTokens);
  const percent =
    totalTokens > 0
      ? Math.min(100, Math.max(0, Math.round((processedTokens / totalTokens) * 100)))
      : 100;
  return { processedTokens, remainingTokens, totalTokens, percent };
}

function renderProgressBar(
  progress: OverlayTokenProgress,
  theme: Theme,
  barWidth = PROGRESS_BAR_WIDTH,
): string {
  const filled = Math.min(barWidth, Math.max(0, Math.round((progress.percent / 100) * barWidth)));
  const empty = Math.max(0, barWidth - filled);
  const bar =
    theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
  const tokenNote = `~${progress.remainingTokens.toLocaleString()} tokens left`;
  return `[${bar}] ${progress.percent}% (${tokenNote})`;
}

export function formatStageBacklog(
  runtime: Runtime,
  ctx: ConsolidationCtx,
  initialObserverTokens: number | undefined,
): string {
  const progress = runtime.consolidationProgress;
  const activeStage = progress?.stage ?? runtime.consolidationPhase;

  if ((activeStage === "reflector" || activeStage === "dropper") && progress) {
    const unit =
      progress.backlogItemUnit ?? (activeStage === "reflector" ? "observations" : "candidates");
    const items = progress.backlogItems ?? 0;
    const initialItems = progress.stageInitialItems;
    const itemText =
      initialItems !== undefined && initialItems > items
        ? `${items.toLocaleString()}/${initialItems.toLocaleString()} ${unit}`
        : `${items.toLocaleString()} ${unit}`;
    const tokText =
      progress.stageInitialTokens > progress.backlogTokens
        ? `~${progress.backlogTokens.toLocaleString()} / ~${progress.stageInitialTokens.toLocaleString()} tokens`
        : `~${progress.backlogTokens.toLocaleString()} tokens`;
    const batchSuffix =
      progress.stagePromptsTotal > 1
        ? ` · batch ${Math.min(
            progress.stagePromptsTotal,
            progress.stagePromptsTotal - progress.stagePromptsRemaining + 1,
          )}/${progress.stagePromptsTotal}`
        : "";
    return `${itemText} (${tokText})${batchSuffix}`;
  }

  const remaining = safeRemainingTokens(runtime, ctx) ?? progress?.backlogTokens;
  if (remaining === undefined) return "calculating...";
  const baseline = initialObserverTokens ?? progress?.stageInitialTokens;
  if (baseline !== undefined && baseline > remaining) {
    return `~${remaining.toLocaleString()} tokens left (from ~${baseline.toLocaleString()})`;
  }
  return `~${remaining.toLocaleString()} tokens remaining`;
}

/**
 * Run synchronous pre-compaction consolidation. When running in an interactive
 * TUI (`ctx.hasUI && ctx.ui.custom`), displays a live progress overlay so the
 * user sees real-time Observer → Reflector → Dropper progress, can press Esc to
 * skip, and OMP pauses its 30s event-handler timeout budget for the full run.
 */
export async function runPreCompactionConsolidationWithUI(
  pi: ExtensionAPI,
  runtime: Runtime,
  ctx: ConsolidationCtx,
  options?: { signal?: AbortSignal },
): Promise<PreCompactionConsolidationResult> {
  if (!shouldRunPreCompactionConsolidation(runtime, ctx, options)) {
    return consolidateBeforeCompaction(pi, runtime, ctx, options);
  }

  const uiWithCustom = ctx.ui as (ConsolidationCtx["ui"] & CustomOverlayUI) | undefined;
  if (!ctx.hasUI || typeof uiWithCustom?.custom !== "function") {
    return consolidateBeforeCompaction(pi, runtime, ctx, options);
  }

  const startedAt = Date.now();
  const initialRemaining = safeRemainingTokens(runtime, ctx);
  const overlayAbort = new AbortController();
  const onOuterAbort = () => overlayAbort.abort();
  if (options?.signal?.aborted) {
    return { outcome: "skipped", reason: "aborted" };
  }
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const result = await uiWithCustom.custom<PreCompactionConsolidationResult>(
      (tui, theme, _keybindings, done) => {
        let closed = false;
        let timer: ReturnType<typeof setInterval> | undefined;

        const finish = (outcome: PreCompactionConsolidationResult): void => {
          if (closed) return;
          closed = true;
          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
          done(outcome);
        };

        timer = setInterval(() => {
          if (!closed) tui.requestRender();
        }, 500);
        if (typeof timer === "object" && timer !== null && "unref" in timer) {
          (timer as NodeJS.Timeout).unref();
        }

        void consolidateBeforeCompaction(pi, runtime, ctx, {
          signal: overlayAbort.signal,
        })
          .then((res) => finish(res))
          .catch(() => finish({ outcome: "skipped", reason: "error" }));

        return {
          render(width: number): string[] {
            const innerWidth = Math.max(20, width - 4);
            const border = (s: string) => theme.fg("border", s);
            const pad = (line: string) => {
              const clipped = truncateToWidth(line, innerWidth, "…", true);
              return `${border("│")} ${clipped}`;
            };
            const top = border(`┌${"─".repeat(Math.max(1, width - 2))}┐`);
            const bottom = border(`└${"─".repeat(Math.max(1, width - 2))}┘`);

            const backlogText = formatStageBacklog(runtime, ctx, initialRemaining);
            const tokenProgress = computeOverlayTokenProgress(runtime, ctx, initialRemaining);
            const progressBarText = renderProgressBar(tokenProgress, theme);

            return [
              top,
              pad(theme.bold(theme.fg("accent", "Context Forge — Consolidating Before Compaction"))),
              pad(""),
              pad(`${theme.fg("muted", "Stage:   ")} ${theme.fg("text", phaseLabel(runtime.consolidationPhase))}`),
              pad(`${theme.fg("muted", "Model:   ")} ${theme.fg("text", modelLabel(runtime, ctx))}`),
              pad(`${theme.fg("muted", "Backlog: ")} ${theme.fg("text", backlogText)}`),
              pad(`${theme.fg("muted", "Progress:")} ${theme.fg("text", progressBarText)}`),
              pad(`${theme.fg("muted", "Elapsed: ")} ${theme.fg("text", formatElapsed(Date.now() - startedAt))}`),
              pad(""),
              pad(theme.fg("dim", "Compaction will continue automatically once all tokens finish. Press Esc to skip.")),
              bottom,
            ];
          },
          invalidate(): void {},
          handleInput(data: string): void {
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
              overlayAbort.abort();
              finish({ outcome: "skipped", reason: "aborted" });
            }
          },
        };
      },
      {
        overlay: true,
        overlayOptions: PROGRESS_OVERLAY_OPTIONS,
        signal: options?.signal,
      },
    );
    return result ?? { outcome: "skipped", reason: "aborted" };
  } finally {
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }
}
