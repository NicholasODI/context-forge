# Focused continuation state

Context-forge stores one project working state and projects it as reference data.
Portable session OM and automatic orientation are described in
[SESSION_HANDOFF.md](SESSION_HANDOFF.md); archive capsules are separate from
the revision-checked task state and do not import worker cursors.
It does not authorize tasks, infer user intent from arbitrary conversation text,
retry failed actions, or invoke an advisor. Latest explicit user instructions
always control; a generic “continue” does not authorize unrelated historical work.

## Implementation boundary

Existing mechanisms were extended rather than replaced:

| Mechanism | Change |
|---|---|
| `project-memory/store.ts` | v2 task snapshots, explicit lifecycle, attribution, scoped freshness; existing locks/revisions/atomic writes |
| `project-memory/handoff.ts` | One deterministic working-state renderer and omission diagnostics |
| `project-memory/continuity.ts` | Existing Resume Context prefix uses that renderer |
| `project-memory/index.ts` | Existing tool/reminder, bounded shell receipts, live/persisted handoff deduplication |
| `blackhole/src/core/continuity.ts` | Focuses the locally-owned Session Goal section when saved state exists |
| `blackhole/src/hooks/before-compact.ts` | Passes that focus through normal, fallback and append modes |

The original local compiler merges up to eight old `Session Goal` bullets and
prefers the first ones (`core/summarize.ts`, `mergeHeaderSection`). That can retain
old stop/finish/continue requests as goals. With an explicit saved task,
Context-forge replaces **only that goal section** with the saved working objective
and its reference/authorization qualifier. Inactive or ambiguous state produces
no active saved objective. Other sections, source history, OM pools and retrieval
remain intact. With no task state, Context-forge does not guess an authoritative
goal from the text; the original structural extraction remains a heuristic.

Old append segments are immutable historical records. The latest handoff says
that their goals are historical; new segments and the complete fallback summary
carry the current focus. An empty structural/OM result still delegates to native
compaction even if a saved task exists. Cancellation is checked after loading
the note. External OMP summaries/goal metadata produced outside this hook are
not rewritten. Native host message shapes that do not expose a Pi-style
`compactionSummary` need an upstream/supported adapter for prefix deduplication;
this implementation does not rewrite arbitrary user messages.

## Lifecycle through `project_memory`

Read first to get the current revision. Every mutation requires
`expectedRevision`. State remains in `.context-forge/memory.json`, with generated
`TASK.md` and `DECISIONS.md`; no second task-state file is introduced.

- `set_task`: explicitly records/replaces the objective. Supply complete lists.
  A different objective gets a new stable `taskId`; the previous task snapshot
  is archived as superseded. Repeating the same active objective updates it.
- `update_task`: patches progress, scope, criteria, blockers, hypotheses, next
  steps, evidence or status without changing objective identity. Supplied lists
  replace lists; omitted fields remain. It cannot reactivate a completed task.
- `complete_task`: explicitly marks the saved task done; next actions stop
  appearing in the handoff. It does not assert independent proof of completion.
- `supersede` with `id: "task"`: explicitly replaces a task, retaining the old
  snapshot and linking it to the replacement. Decision supersession still works.
- `invalidate`, `verify`, `pin`, `unpin`: retain their existing explicit behavior.
  `verify` records a new evidence snapshot; it does not run or independently
  validate tests. Invalidation and completion are not undone by a generic update.

Task changes retain historical snapshots under `taskHistory`, with unique snapshot
IDs, stable task IDs, archive reasons, timestamps and the last operation/session.
Historical `status` values describe that old snapshot, not simultaneous active
goals. Snapshots are not injected. New decisions are associated with the current
task; unrelated task decisions leave the working set unless explicitly pinned
as project references. Legacy unscoped decisions stay reference-only and are not
automatically classified from their prose.

Example initial write (paths/source references are illustrative):

```json
{
  "action": "set_task",
  "expectedRevision": 0,
  "text": "Fix observer continuation after resume",
  "scope": ["Session-generation guard", "Isolated regression"],
  "acceptanceCriteria": ["Valid resumed work can commit", "Stale work cannot write into another session"],
  "progress": [],
  "blockers": [],
  "nextSteps": ["Inspect the resume guard", "Run the focused regression"],
  "provenance": {"kind":"user_instruction","source":"user entry requesting the resume fix"}
}
```

For an ambiguous change, use `update_task` with
`pendingGoalChange: {"text":"Proposed objective","source":"ambiguous user entry"}`.
The handoff marks it unresolved and withholds the recorded next action; it does
not promote the proposal into an accepted goal. Clearing it with
`pendingGoalChange: null` requires a `reason`. A new explicit objective can
supersede the old one. Neither operation independently establishes user consent.

Provenance kinds distinguish agent-attributed `user_instruction`, `model_plan`,
and `model_report`. The tool cannot authenticate a model-supplied user reference,
so the handoff explicitly labels attribution as agent-authored/reported.
Hypotheses have `open`, `supported`, or `ruled_out` status and source references.
Non-open hypotheses require a reference but remain **agent-reported claims**;
stale/unknown basis is not turned into established fact.

## Evidence: observations and claims

Manual `checks` remain agent-reported descriptions. File SHA-256 fingerprints
are computed by the extension. An unchanged fingerprint establishes only that
the selected file evidence has not changed, not that a statement is true or a
test exercised it.

Optional shell metadata capture uses documented `tool_call` / `tool_result`
hooks for `bash` and `powershell`. It keeps at most 16 receipts in memory:

1. A matching request records a digest of arguments, tool/call/session IDs and
   request time. The command text is not retained.
2. A matching result records `result_received` and the tool error flag.
3. Only a numeric structured `exit_code` from the documented shell output sets
   `completed` and an observed exit status. Unsupported shapes stay unknown.
4. `expectedTestsExecuted` stays `unknown`, including for exit 0. Nothing parses
   stdout, shell text, “passed” prose, `isError: false`, or a command name to
   infer which tests actually ran.

Use `{"action":"read","section":"checks"}` to inspect receipts, then include
selected `checkIds` in an explicit state mutation. Automatic capture makes no
filesystem/task changes. Unmatched results, changed inputs, requested-only
receipts, another session/cwd and evicted IDs cannot attach as observed results.
Receipts expire on reload/session/cwd changes; attached copies remain in evidence.
Native OMP hook/output support is opportunistic and not established by Linux
synthetic tests. Direct nested `.bash.execute()` calls such as fused `then_run`
may not emit the required hooks. That requires host event forwarding or a tested
adapter, not guessed exit codes from its text markers.

Receipt association and file lists are agent-selected. File hashes are taken
when the note is written, not necessarily when a command ran. The extension does
not infer command dependencies or assert that a receipt tested those files.

New file-based records use file-scoped freshness: unrelated files/commits do not
invalidate them, while listed changed/missing files do. Dependencies outside the
list remain unknown. Records without file evidence can use the tracked repository
snapshot for broader freshness. Legacy records retain their prior repository
comparison semantics; migration does not silently narrow their dependency scope.

## Handoff budgets and diagnostics

The shared renderer reserves space for objective, state/uncertainty, evidence
freshness, blockers and one next action before optional chronology:

- Persisted Resume Context: 3,000-character body, at most 3,200 including markers.
- Live reminder: at most 8,000 characters.
- Tool reads: existing 16,000-character previews, with paging and record lookup.
- Source: existing 2 MiB limit. Task history grows only on explicit task writes,
  not compaction or provider requests. Oversize writes fail without silently
  pruning history; keep notes compact and preserve/archive source deliberately
  if this limit is reached.

Acceptance criteria, recent progress, bounded hypotheses/basis references,
reported checks, host receipts, file references and relevant decisions fill the
remaining budget. Omission/clipping is reported; status and uncertainty precede
the abbreviated claim. Completed/invalidated tasks show no executable next
action. Stale evidence identifies what needs rechecking; no broad investigation
or retry is scheduled. Full detail stays retrievable:

```json
{"action":"read","id":"task"}
{"action":"read","section":"tasks","offset":0,"limit":5}
{"action":"read","id":"task-history-r7"}
{"action":"diagnostics"}
```

`/forge-memory diagnostics` exposes renderer budgets, included fields, omitted
fields/reasons, attribution/freshness labels and excluded historical objectives.
It describes the **planned current handoff**, not provider-wire delivery.
Compaction details persist the actual prefix's renderer metadata. `/blackhole-memory
diagnostics` can inspect that snapshot. The context hook registers after VCC,
removes only recognized generated prefixes, and appends one latest live view.
It never appends that reminder to session history. On storage failure it preserves
the complete compaction fallback and warns; it does not discard raw history to
replace it with only a task note.

## Privacy, migration and controls

The existing `projectMemory` feature switch and project trust gate apply to
storage, receipts and handoffs. Disabled/untrusted contexts do not load project
state; recognized generated prefixes/live reminders are removed from the
projection. Existing historical session entries are not edited. Known credential
assignments, bearer values, credential URLs and private keys are rejected in new
notes and redacted when legacy fields are projected. No command text or raw tool
output is captured. This is not universal secret detection: do not write secret
values or paste sensitive output into notes; use concise redacted references.

v1 source remains readable without writes. The next explicit revision-checked
mutation upgrades the same file to v2; old attribution/dependencies remain
unknown or legacy-scoped. Task notes overwritten before this version cannot be
reconstructed from nonexistent snapshots. Existing locks, atomic replacement,
JSON-last source commit and user-authored Markdown refusal remain. If a write is
interrupted, JSON remains authoritative; `/forge-memory refresh` regenerates
views from it without rerunning checks. Update all shared-project writers before
editing v2 state; old builds reject its version rather than safely understanding
the new fields. No downgrade or automatic deletion is attempted.

## Small omni-advisor contract

Omni-advisor may read `project_memory` and its diagnostics, retrieve referenced
history, and propose/update state through the same revision-checked operations.
It must respect attributed versus observed evidence, unknown dependencies/test
execution and current user authorization. On revision conflict, reread before
updating. Never treat a saved plan or hypothesis as authority to execute it.

Omni-advisor owns failure-loop detection, retry/recovery decisions, escalation
and stopping conditions. This feature adds none of those controls and performs
no autonomous advisor/cloud/LLM calls. Handoff text cannot guarantee attention or
correct behavior from every model; real OMP/provider integration remains a
separate runtime validation boundary.
