# Maintenance boundaries

Context Forge owns memory state, evidence freshness, compaction handoffs and
retrieval. Omni Advisor owns recovery decisions and retry enforcement. Neither
extension imports the other or reads/writes its private persistence format.
Project memory is reference data, not execution authorization.

## Configuration

`src/config.ts` defines the unified feature descriptors (`FORGE_FIELDS`). The
loader, built-in defaults and terminal menu consume those descriptors. Add a
feature there rather than introducing positional menu branches.

Advanced configuration keeps its existing defaults in `core/unified-config.ts`.
`core/numeric-fields.ts` supplies numeric editing metadata and validation to both
the file loader and advanced modal. UI editing ranges are guides, not runtime
upper bounds. Token counts and turn counts are integers; zero is accepted only
where it has a documented opt-out or automatic meaning. Invalid values fall back
to existing defaults. Optional worker tuning remains optional.

The observation-pool target is normalized to half the maximum when it is absent
or at/above that maximum. Both modal and runtime now report the same target;
execution already uses a guarded target. Environment handling, legacy migration
and model selection remain in their existing configuration modules. This is an
incremental consolidation, not a new settings backend or a file-format migration.

## Scheduling and execution

`om/scheduling.ts` accepts branch entries, configuration, cursor state and
optional manual-mode pending state. `planStages` returns stage eligibility;
`anyStageDue` preserves the existing boolean API. Neither function advances a
cursor, persists state, calls a provider, or launches a worker. Repeated eligibility
checks cannot claim progress. The dropper check is deferred when an upstream
stage is due; execution rechecks after upstream results.

`om/consolidation.ts` owns execution: generation/session guards, model resolution,
retries, worker calls, result validation and persistence. It consumes the shared
eligibility/coverage helpers and re-exports the existing public scheduling APIs
for callers. A schedule decision is not permission to commit stale results;
existing generation checks remain authoritative at execution time.

Regression tests include repeated pure due-checks, lost cursors, low-volume
sources, runtime/modal numeric parity, distinct evidence identities and the
existing stale-session/coverage worker tests. No retry controller was added here.
