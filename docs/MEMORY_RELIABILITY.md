# Memory reliability and local-model tuning

These changes strengthen the existing Observer → Reflector → Dropper pipeline.
They add no background model jobs, embedding service, or independent LLM
decision-extraction call. `project_memory` and `memory_policy` are tools used
by the main agent; their filesystem/ledger operations make no provider calls.

## Worker completion and failure handling

- The observer must finish with a valid `record_observations` batch carrying
  `complete: true`. A completed empty batch is valid. A text-only response,
  rejected-only proposals, or an unfinished empty batch cannot advance coverage.
- A valid completion terminates the worker immediately, avoiding an extra
  provider confirmation request. Partial work can advance only an honest cited
  prefix; later source entries remain due.
- Tagged schema/setup and observer-protocol failures stop the invocation with
  their actual cause. Other exhausted attempts report the worker, attempt count,
  last model, and first error rather than only “all model candidates exhausted.”
- A session-model fallback gets at most two ordinary attempts per stage. The
  existing configured fallback chain remains available. Input/output size
  recovery can bisect batches under the pipeline's existing bounded limits.
- A successful empty reflector review persists a signature and coverage anchor.
  Unchanged observations are not reviewed again on every trigger, including
  after reload. New observations rearm the review; below-threshold or failed
  checks do not claim reviewed coverage.

Observer inputs omit assistant thinking to reduce repeated worker input. Raw
session evidence remains available through recall. The reflector and dropper
keep their existing normal-stop completion protocol.

## Protect or correct session memory

With unified recall enabled, the main agent can call `memory_policy` in a trusted
project. Get the 12-character observation/reflection ID from memory status or
recall, and inspect evidence before changing policy.

```json
{"action":"pin","id":"012345abcdef","reason":"User requires this constraint throughout the task"}
```

Supported actions: `pin`, `unpin`, `invalidate`, and `supersede`. Supersession
requires `replacementId` naming a different active record. It transfers a pin
and removes the old record from future active projections. An explicit
invalidation/supersession of an observation also removes reflections citing it
from the active set, so an older distilled statement cannot repeat the corrected
fact. Sources remain in the append-only ledger and are recallable. Inactive
records cannot be restored with `unpin`; record a supported replacement instead.

Pins take priority in summary selection, including policies written after the
chosen raw-history cut. Critical observations rank above high ones; reflections
inherit the importance of supporting observations. Within tiers, selection uses
task-word relevance and recency without another model call. There is no automatic
contradiction detector: the agent must apply explicit corrections when warranted.

If pinned records cannot fit the configured summary budget, compaction is
cancelled with a warning instead of silently omitting them. Inspect/unpin or
supersede records, or deliberately increase the budget. Worker preambles also
have finite budgets; keep the pinned core small. Project decision pins are a
separate store: they prioritize the eight-slot, 8,000-character live reminder,
which warns on excess pins or truncation rather than blocking compaction.

Session OM still enters the main context through the compaction summary. Policy
events change future projections and worker inputs; they do not rewrite a
summary already sent. Project task/decision notes provide the separate live
reminder before and after compaction and are shared by sessions in that project.

## Conservative pruning

The dropper cannot remove pinned or critical observations. Each proposed drop
must include a reason and replacement reflection IDs from its provided input;
each replacement must cite that observation. Accepted drops persist this audit
evidence in the `proofs` field of `om.observations.dropped` entries. Merely citing
a fact does **not** prove semantic equivalence; the worker must still judge
whether the replacement preserves the important detail.

Pressure, targets, and selected removal costs share rendered-line token
estimates, including IDs and metadata. `observationsPoolTargetTokens` now affects
pruning: below the effective target, no pruning call is needed; selection stops
once enough safe proposed records meet the target. Safety vetoes, count caps,
or missing replacement coverage can leave the pool above target. Full evidence
remains archived regardless of summary selection.

## Local worker settings

Merge overrides into the existing Blackhole configuration, not the top-level
feature-toggle file `context-forge.json`. Global configuration is under the
host's agent directory at `pi-blackhole/pi-blackhole-config.json`; project
overrides are at `<cwd>/.pi/pi-blackhole-config.json`.

```json
{
  "workerOutputMaxTokens": 4096,
  "workerAttemptTimeoutMs": 600000
}
```

These are the new defaults. The output cap is shared by preflight reservation
and dispatched generation and remains bounded by model/window limits and the
existing 32,000-token ceiling. Reasoning-heavy models may need a higher cap,
such as 8192 or 16384. Slow local prompt ingestion may require a deadline longer
than ten minutes; `0` disables that deadline. A configured provider idle timeout
is separate. Matching environment overrides:
`PI_BLACKHOLE_WORKER_OUTPUT_MAX_TOKENS` and
`PI_BLACKHOLE_WORKER_ATTEMPT_TIMEOUT_MS`.

Keep generation headroom and memory pools appropriate to the actual server
window. Token estimates are conservative heuristics, not the provider's exact
tokenizer; unknown server-side template overhead remains a limitation.

## Large histories and validation limits

`project_memory` reads page bounded previews instead of echoing the entire
decision log. Freshness checks hash each evidence file once per call and inspect
only the requested/selected records. The existing 2 MiB source limit remains;
this is not an unbounded database.

Recall skips caching session files larger than 64 MiB. Retained cache entries
are limited to three and 128 MiB of aggregate source-file bytes, with eviction
by recent use. This is a source-size proxy, **not** a hard process-heap limit:
scans still materialize results, and no persistent incremental index is added.

Regression coverage includes protocol failures, cancellation/deadlines, empty
review reloads, manual pending corrections, drop evidence, bounded history
reads/cache eviction, and pin survival through 300 synthetic compactions. These
tests use temporary data and mocked providers. They do not establish native omp
compatibility for every version or factual recall quality across hundreds of
real model calls. Reload/restart the installed extension to pick up changes.

Provider-specific tokenization, persistent search indexes, and measured
cross-model recall-quality benchmarks remain future work. A finite summary
still selects a working set: archive retention and pinning reduce repeated
compaction loss, but cannot guarantee model attention or perfect recall.
