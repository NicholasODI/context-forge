/** Read-only worker scheduling. No model calls, cursor writes or persistence. */
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import type { PipelineCursor } from "./runtime.js";
import type { PendingOMState } from "./pending.js";
import { isManualMode } from "../core/unified-config.js";
import { dropTargetTokens } from "./agents/dropper/selection.js";
import {
  OM_OBSERVATIONS_RECORDED,
  OM_REFLECTIONS_RECORDED,
  entryIndexForId,
  latestCoverageMarkerId,
  livePoolObservations,
  livePoolReflections,
  observationPoolTokens,
  rawTokensAfterIndex,
  rawTokensSinceDropCoverage,
  rawTokensSinceObservationCoverage,
  rawTokensSinceReflectionCoverage,
  type Entry,
} from "./ledger/index.js";

export interface SchedulingState {
  readonly config: Config;
  readonly cursors?: Partial<
    Record<"observer" | "reflector" | "dropper", PipelineCursor>
  >;
}
/** Dropper is evaluated only if neither upstream stage is due: execution rechecks after upstream results. */
export interface StagePlan {
  observer: boolean;
  reflector: boolean;
  dropper: boolean;
}

/**
 * Pressure gate for the dropper: the pool is full enough that it should be
 * pruned even though no new observation or reflection data has arrived.
 *
 * The basis is `observationsPoolMaxTokens` — the same maximum the footer
 * P gauge and `/blackhole-memory` divide by — not `reflectorInputMaxTokens`,
 * which only sizes reflector/dropper prompts. Both configured fractions have to
 * clear, so the effective trigger is
 * `max(dropperPressureThreshold, dropperPoolFullnessThreshold) × pool max`.
 * A threshold of `1.0` (the documented "off" value), or a non-positive pool
 * max, disables pressure entirely; the ordinary new-data trigger is
 * unaffected.
 */
export function dropperPressureReached(
  config: Config,
  poolTokens: number,
): boolean {
  const poolMax = config.observationsPoolMaxTokens;
  if (poolMax <= 0 || config.dropperPressureThreshold >= 1) return false;
  return (
    poolTokens / poolMax >= (config.dropperPoolFullnessThreshold ?? 0.1) &&
    poolTokens >= config.dropperPressureThreshold * poolMax
  );
}

/** Bind an empty verdict to the actual proof/policy inputs, not just obs ids. */
export function activePoolSignature(
  entries: Entry[],
  pending: PendingOMState | undefined,
  config: Config,
): string {
  const observations = livePoolObservations(entries, pending);
  const ids = new Set(observations.map((o) => o.id));
  return createHash("sha256")
    .update(
      JSON.stringify({
        observations: observations
          .map((o) => [o.id, o.relevance, o.pinned ?? false])
          .sort(),
        reflections: livePoolReflections(entries, pending)
          .filter((r) => r.supportingObservationIds.some((id) => ids.has(id)))
          .map((r) => [r.id, r.content, [...r.supportingObservationIds].sort()])
          .sort(),
        budgets: [
          config.observationsPoolMaxTokens,
          config.observationsPoolTargetTokens,
          config.dropperInputMaxTokens,
        ],
        model: config.dropperModel ?? config.model,
        fallbacks: config.dropperFallbackModels,
        policyVersion: 3,
      }),
    )
    .digest("hex");
}

/**
 * True when this exact pool has already been pressure-pruned and came back
 * empty: `runDropperStage` binds the signature to the `"empty"` dropper cursor
 * precisely so repeated due-checks cannot re-issue the same model call against
 * a pool the dropper just declined to touch. Any pool change — a new
 * observation, replacement citation, pin policy, or budget — changes the signature and
 * re-arms pressure.
 */
export function matchesEmptyPressurePool(
  runtime: SchedulingState,
  poolSignature: string,
): boolean {
  const cursor = runtime.cursors?.dropper;
  return (
    cursor?.state === "empty" && cursor.activePoolSignature === poolSignature
  );
}
/**
 * Accumulated source tokens since valid reflection coverage — the single
 * progress measure shared by the scheduler (`anyStageDue`) and the stage
 * gate (`runReflectorStage`). Automatic mode anchors on the
 * `OM_REFLECTIONS_RECORDED` coverage marker in the branch; manual mode
 * anchors on the pending reflection's `coversUpToId`, falling back to
 * observation coverage when no reflection has been pending yet.
 *
 * Crucially this does NOT use the pipeline cursor: a below-threshold or
 * skipped check must not move the accumulation anchor (the cursor is a
 * processing-position record, not a coverage claim).
 */
export function reflectionAccumulatedTokens(
  entries: Entry[],
  config: Config,
  pending?: PendingOMState,
  cursor?: PipelineCursor,
): number {
  if (
    cursor?.reviewSignature &&
    (cursor.state === "empty" || cursor.state === "recorded")
  ) {
    const idx = entryIndexForId(entries, cursor.entryId);
    if (idx >= 0) {
      const marker = isManualMode(config)
        ? pending?.reflection?.coversUpToId
        : latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
      return rawTokensAfterIndex(
        entries,
        Math.max(idx, entryIndexForId(entries, marker)),
      );
    }
  }
  if (isManualMode(config)) {
    if (pending?.reflection?.coversUpToId) {
      const idx = entryIndexForId(entries, pending.reflection.coversUpToId);
      if (idx >= 0) return rawTokensAfterIndex(entries, idx);
      // Coverage point gone (fork/compaction): fall back to observation coverage.
    }
    return rawTokensSinceObservationCoverage(entries);
  }
  return rawTokensSinceReflectionCoverage(entries);
}

/** Changes only when actual observation input or reflector policy changes. */
export function reflectionReviewSignature(
  entries: Entry[],
  config: Config,
  pending?: PendingOMState,
): string {
  const observations = livePoolObservations(entries, pending);
  return createHash("sha256")
    .update(
      JSON.stringify({
        root: entries[0]?.id,
        observations: observations
          .map((o) => [
            o.id,
            o.content,
            o.relevance,
            o.pinned ?? false,
            o.sourceEntryIds,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        model: config.reflectorModel ?? config.model,
        fallbacks: config.reflectorFallbackModels,
        prompt: 1,
      }),
    )
    .digest("hex");
}

export function reflectionAlreadyReviewed(
  entries: Entry[],
  runtime: SchedulingState,
  pending?: PendingOMState,
): boolean {
  const cursor = runtime.cursors?.reflector;
  return (
    !!cursor?.reviewSignature &&
    (cursor.state === "empty" || cursor.state === "recorded") &&
    entryIndexForId(entries, cursor.entryId) >= 0 &&
    cursor.reviewSignature ===
      reflectionReviewSignature(entries, runtime.config, pending)
  );
}

/** Cursor-aware stage-due check.  Uses cursors when available; falls back to
 *  legacy coverage markers when cursors are absent (cold start, fork recovery).
 *
 *  In compaction: "manual" mode, the branch has no OM markers — observations
 *  live in the per‑session pending file.  `pending` provides the pool fullness
 *  and new‑data visibility that the reflector/dropper checks need. */
export function planStages(
  entries: Entry[],
  runtime: SchedulingState,
  pending?: PendingOMState,
): StagePlan {
  const config = runtime.config;
  const cursors = runtime.cursors ?? {};

  // ── Observer ──────────────────────────────────────────────────────────
  const observerDue = (() => {
    const cursor = cursors.observer;
    if (!cursor) {
      return (
        rawTokensSinceObservationCoverage(entries) >= config.observeAfterTokens
      );
    }
    const idx = entryIndexForId(entries, cursor.entryId);
    const tokensSince =
      idx >= 0
        ? rawTokensAfterIndex(entries, idx)
        : rawTokensSinceObservationCoverage(entries);
    return tokensSince >= config.observeAfterTokens;
  })();

  // ── Reflector ─────────────────────────────────────────────────────────
  // Token accumulation anchors on valid reflection coverage (see
  // reflectionAccumulatedTokens), never on the cursor: a persisted not_due/
  // skipped cursor must not reset or perpetuate a lost accumulation anchor.
  const reflectorDue = (() => {
    if (
      reflectionAlreadyReviewed(entries, runtime, pending) ||
      livePoolObservations(entries, pending).length === 0
    )
      return false;
    if (
      reflectionAccumulatedTokens(entries, config, pending, cursors.reflector) <
      config.reflectAfterTokens
    ) {
      return false;
    }
    // Above threshold: due when unprocessed observations exist beyond valid
    // reflection coverage. The coverage marker — not the cursor — is the
    // anchor, so a broken persisted cursor cannot hide earlier observations.
    const coverageId = isManualMode(config)
      ? pending?.reflection?.coversUpToId
      : latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED);
    if (!coverageId) return true; // no prior reflection → any observations are unprocessed
    const covIdx = entryIndexForId(entries, coverageId);
    if (covIdx < 0) return true; // coverage point gone → treat as unprocessed
    for (let i = covIdx + 1; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === OM_OBSERVATIONS_RECORDED) {
        const obs = (e.data as any)?.observations;
        if (Array.isArray(obs) && obs.length > 0) return true;
      }
    }
    // Manual mode: pending observation batches beyond the reflection coverage
    // are unprocessed. Unanchored batches are deliberately not a trigger:
    // they carry no coverage point, so a review of them alone could not be
    // committed — they ride along on the next recorded run's input instead.
    if (isManualMode(config)) {
      const pendingBatches = pending?.observationBatches ?? [];
      for (const batch of pendingBatches) {
        if (!(batch.data as any)?.observations?.length) continue;
        if (!batch.coversUpToId) continue; // unanchored
        const batchIdx = entryIndexForId(entries, batch.coversUpToId);
        if (batchIdx < 0 || batchIdx > covIdx) return true;
      }
    }
    return false;
  })();

  // ── Dropper ───────────────────────────────────────────────────────────
  // Short‑circuit: only compute dropperDue when observer and reflector are
  // both not due — if either is due, the pipeline launches anyway.
  const dropperDue =
    observerDue || reflectorDue
      ? false
      : (() => {
          // Live active pool, plus pending observation batches in manual mode.
          const poolTokens = observationPoolTokens(entries, pending).tokens;
          if (
            poolTokens <=
            dropTargetTokens(
              config.observationsPoolMaxTokens,
              config.observationsPoolTargetTokens,
            )
          )
            return false;
          const fullnessVsPool =
            config.observationsPoolMaxTokens > 0
              ? poolTokens / config.observationsPoolMaxTokens
              : 0;

          // Must have at least dropperPoolFullnessThreshold fullness to consider dropper
          if (fullnessVsPool < (config.dropperPoolFullnessThreshold ?? 0.1))
            return false;

          // Pressure check: pool ≥ max(pressure, fullness) fraction of
          // observationsPoolMaxTokens — and not for a pool the dropper has
          // already evaluated and left untouched.
          if (
            dropperPressureReached(config, poolTokens) &&
            !matchesEmptyPressurePool(
              runtime,
              activePoolSignature(entries, pending, config),
            )
          )
            return true;

          // New data check: new obs or ref batches after dropper cursor
          const cursor = cursors.dropper;
          if (!cursor) {
            // In manual mode, pending batches are the only source of new‑data
            // visibility (branch has no OM markers). Unanchored-only pending
            // is deliberately not new data (same no-coverage-point reason as
            // the reflector gate): kept facts join the next cadence or
            // pressure run's candidate set instead of launching one alone.
            const hasPendingNewData = pending
              ? (pending.observationBatches?.length ?? 0) > 0 ||
                (pending.reflectionBatches?.length ?? 0) > 0
              : false;
            if (hasPendingNewData) return true;
            return (
              rawTokensSinceDropCoverage(entries) >= config.reflectAfterTokens
            );
          }
          const idx = entryIndexForId(entries, cursor.entryId);
          if (idx < 0) {
            return (
              rawTokensSinceDropCoverage(entries) >= config.reflectAfterTokens
            );
          }
          // Token accumulation anchors on valid drop coverage (see
          // rawTokensSinceDropCoverage), never on the cursor: a persisted
          // not_due cursor must not reset the accumulation anchor, matching
          // runDropperStage's own gate.
          if (rawTokensSinceDropCoverage(entries) < config.reflectAfterTokens) {
            return false;
          }
          for (let i = idx + 1; i < entries.length; i++) {
            const e = entries[i];
            if (
              e.type === "custom" &&
              (e.customType === OM_OBSERVATIONS_RECORDED ||
                e.customType === OM_REFLECTIONS_RECORDED)
            ) {
              const markerCoversUpTo: string | undefined = (e as any).data
                ?.coversUpToId;
              if (markerCoversUpTo) {
                const markerCoversIdx = entryIndexForId(
                  entries,
                  markerCoversUpTo,
                );
                if (markerCoversIdx >= 0 && markerCoversIdx <= idx) continue;
              }
              return true;
            }
          }
          // In manual mode, also check pending batches after the cursor.
          // Unanchored batches excluded deliberately (see reflector gate).
          if (pending) {
            const pendingObs = pending.observationBatches ?? [];
            const pendingRef = pending.reflectionBatches ?? [];
            for (const batch of [...pendingObs, ...pendingRef]) {
              if (batch.coversUpToId) {
                const batchIdx = entryIndexForId(entries, batch.coversUpToId);
                if (batchIdx >= 0 && batchIdx > idx) return true;
              }
            }
          }
          return false;
        })();

  return {
    observer: observerDue,
    reflector: reflectorDue,
    dropper: dropperDue,
  };
}

export function anyStageDue(
  entries: Entry[],
  state: SchedulingState,
  pending?: PendingOMState,
): boolean {
  const plan = planStages(entries, state, pending);
  return plan.observer || plan.reflector || plan.dropper;
}
