# context-forge

Merged context-engineering extension for the [oh-my-pi](https://pi.dev) agentic coding harness.

`context-forge` combines two projects into a single, deterministic extension:

- **[SoL-Pi](https://github.com/NVlabs/SoL-Pi)** — four context mechanisms: Action Fusion, Observation Pack, Evidence-Preserving Reducer, and Online Context Compact.
- **[pi-blackhole](https://pi.dev/packages/pi-blackhole)** — observational memory, VCC (variable-cost compaction) content, and unified recall.

The result is one extension that archives raw tool output behind placeholders, compresses context economically, and keeps a searchable memory of what happened across sessions.

## Mechanisms

### SoL-Pi side (see raw messages first)

| Mechanism | Default | What it does |
|---|---|---|
| **Action Fusion** | on | Fuses related tool actions to reduce redundant context. |
| **Observation Pack** | on | Archives large tool outputs behind compact observation placeholders with drill-down IDs. |
| **Evidence-Preserving Reducer** | off | Uses a cheap model to summarize verbose output while preserving evidence receipts. |
| **Online Context Compact** | on | Economic compaction trigger based on cache write/read ratio. |

### pi-blackhole side (see placeholders, not raw data)

| Mechanism | Default | What it does |
|---|---|---|
| **Observational Memory** | on | Background consolidation workers that distill observations/reflections into durable project memory. |
| **VCC Compaction** | on | Variable-cost compaction: structural summaries, before-compact hooks, compact-failed recovery, and pre-compaction output archival. |
| **Unified Recall** | on | A single `recall` tool that searches session history, file content, and touched-file summaries. |

Registration order is deterministic: SoL-Pi `context` handlers run first (they see raw messages and archive/placeholder them), then pi-blackhole's compaction-context projection runs (it sees the placeholders). Compaction triggering is owned by pi-blackhole's threshold trigger; the SoL-Pi economic trigger is disabled by default so the two never both fire.

## Install

Clone or copy this folder into your omp extensions directory, then restart omp:

```bash
git clone https://github.com/NicholasODI/context-forge.git ~/.omp/extensions/context-forge
cd ~/.omp/extensions/context-forge
npm install
```

omp discovers the extension via the `omp.extensions` entry in `package.json`. No further wiring is needed.

> Requires Node.js ≥ 22.19.0 and a running omp installation with the `@earendil-works/pi-*` packages available (peer dependencies).

## Configuration

All mechanisms are toggled from a single JSON file: `context-forge.json`.

Resolution order (later wins):

1. Built-in defaults
2. Global: `~/.omp/agent/context-forge.json`
3. Project: `<cwd>/.omp/context-forge.json` (only when the project is trusted)

### Interactive settings

Run `/context-forge` for a terminal settings menu using arrows and Enter.
The entry menu offers:

- **Features and reducer**: global or trusted-project feature toggles, reducer
  model/provider, and cache write/read ratio.
- **Compaction, memory workers, retention and recall**: the existing advanced
  modal, including summary/tail modes, thresholds, worker models and budgets,
  dropper controls, retained tool-output tokens, and recall-response characters.
  It uses the same configuration and runtime refresh as `/blackhole settings`.
- **Continuation state and evidence**: an explanation of focused handoffs,
  fixed safety budgets, and the commands for inspecting state and diagnostics.

In the features menu, changes are staged until **Save and close**. Escape or Cancel discards them;
Reset changes only the draft until saved.

**Restart OMP after saving feature settings** to apply all changes. That menu
edits saved settings, not currently registered mechanisms. The advanced modal
uses its existing global/project/session scopes and environment precedence;
closing it refreshes the memory runtime configuration. Its settings cannot
activate a mechanism disabled in the feature configuration until restart.
Zero retained tool-output tokens disables retention limiting; zero recall-response
characters disables response bounding. Continuation budgets are fixed safeguards,
not editable options. Project files take precedence over global
files; omitted fields use built-in defaults, matching the existing loader.
Saving writes a complete configuration, so project settings can mask later
global changes. Invalid files and files changed while the menu is open are not
overwritten. Advanced tuning remains under `/blackhole settings`.

Example:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerModel": "default",
  "evidencePreservingReducerProvider": "default",
  "onlineContextCompact": true,
  "cacheWriteReadRatio": 12.5,
  "observationalMemory": true,
  "vccCompaction": true,
  "unifiedRecall": true,
  "projectMemory": true
}
```

The pi-blackhole-derived mechanisms additionally read pi-blackhole's own `blackhole-config.json` for fine-grained tuning; `context-forge.json` only gates whether those mechanisms are registered at all.

## Commands

| Command | Description |
|---|---|
| `/context-forge` | Interactive feature settings, advanced memory/compaction settings, and continuation information. |
| `/blackhole` | Manual compact with structural summary. Subcommands: `[settings]` config overlay, `[changelog]`, `[cleanup]`, `[om-off]`/`[om-on]`. |
| `/blackhole-memory` | Memory pipeline status & token counters. `[view]` visible observations/reflections, `[full]` complete recorded memory (copies to clipboard). |
| `/blackhole-memory diagnostics` | Latest summary selection/exclusion reasons, token estimates, worker completion/coverage, and context-hook evidence. Filter with `id:MEMORY_ID`; page with `offset:N limit:1–25`. Includes drop-marker provenance. |
| `/blackhole-export` | Export distilled project memory to markdown. `[out:<path>]` — defaults to project cwd. |
| `/blackhole-recall` | Search session history. `<query> [page:N] [scope:all] [mode:file\|touched]`. |

## Tools

- **`recall`** — unified recall over session lineage, file content, and touched-file summaries, with paging and scope control.
- **`project_memory`** — maintain a project-local task note and decision log with evidence and freshness tracking.
- **`memory_policy`** — pin, unpin, invalidate, or supersede session observations/reflections while retaining source evidence.

See [Memory reliability and local-model tuning](docs/MEMORY_RELIABILITY.md) for
worker completion rules, pruning safeguards, retention controls, and limits.

## Durable task and decision notes

The `projectMemory` feature (default `true`) complements observational memory with
explicit project state and focused compaction handoffs. It does **not** change
worker thresholds or the observational-memory ledger. No files are created until the agent calls the
`project_memory` tool to write a record in a trusted project.

To start, ask: **“Record our current goal, completed progress, blockers, and next steps in
project memory. Record important decisions with their rationale and evidence.”**
The agent should update it after meaningful progress, not on every tool call.
This feature supplies storage and tool guidance; it does not infer decisions or
create extra model calls in the background.

The extension maintains these files at the Git root, or the current working
directory for a non-Git project:

| File | Purpose |
|---|---|
| `.context-forge/TASK.md` | Current goal, status, progress, next steps, and evidence |
| `.context-forge/DECISIONS.md` | Decisions and rationale, including invalidated and superseded history |
| `.context-forge/memory.json` | Authoritative structured state, evidence fingerprints, and revision |

The Markdown files are generated views. Update through the tool; existing
user-authored files with these names are not overwritten. You may commit these
files for review and handoff, but the extension never commits them or edits
`AGENTS.md`. Do not record secrets. `/forge-memory` displays current state;
`/forge-memory refresh` regenerates the Markdown views without rerunning checks
or declaring evidence valid again.

The tool supports `read`, `diagnostics`, `set_task`, `update_task`, `complete_task`,
`record_decision`, `verify`, `invalidate`,
`supersede`, `pin`, and `unpin`. `supersede id=task` explicitly replaces a task;
`read section=tasks` retrieves previous snapshots. Read first; each mutation requires `expectedRevision` to avoid
overwriting another session's updates. `set_task` replaces the current task;
include its complete progress, blocker, and next-step lists. Decision IDs are returned by
the tool; superseding retains the original in the full log and transfers its pin.
Reads return bounded previews: use `offset` and `limit` (default 5, maximum 10)
to page decisions newest first, or `id` to inspect one record. Responses contain
the revision and at most 16,000 characters; complete records remain on disk.

Example tool arguments after an initial `read` reports revision 0:

```json
{
  "action": "set_task",
  "expectedRevision": 0,
  "text": "Fix resumed-session observer execution",
  "status": "active",
  "progress": ["Identified the session identity mismatch"],
  "nextSteps": ["Implement the fix", "Run the isolated regression"],
  "blockers": [],
  "files": ["src/blackhole/src/om/runtime.ts"],
  "sources": ["User requested observer/reflector reliability"]
}
```

File evidence is hashed from actual project files. Checks record the agent's
reported command and result; the tool does **not** execute or independently
validate tests. Only record checks that were actually run.

- **Current** means the selected evidence snapshot is unchanged. New file-based
  notes track only their listed file hashes; repository-scoped and legacy
  evidence also compare the available Git snapshot. Unknown dependencies remain
  unknown. This does not prove a claim true or expected tests ran.
- **Stale** means evidence changed/disappeared, repository state changed, or the
  record was explicitly invalidated. Reinspect/retest before `verify` captures
  a new evidence snapshot.
- **Unverified** means there is no freshness-trackable evidence. Source
  references alone are retained as provenance, not verification. Checks in a
  non-Git directory need file evidence for meaningful freshness tracking.
- **Superseded** decisions remain on disk but leave the active reminder.

Git freshness covers tracked changes; explicitly list relevant untracked files
as evidence too. Files outside the project, symlink evidence, and files over
4 MiB are rejected. File contents are not copied into evidence—only paths and
SHA-256 hashes. Read-only freshness checks do not rewrite state or advance any
observer/reflector cursor. Markdown freshness labels reflect their last
generation; tool reads recompute evidence for the requested records, and context
requests check only the task and selected decisions. Historical records outside
that working set are marked unverified in generated Markdown.

On each main-session `context` event, after compaction projection, the extension
adds one live reminder containing the task and up to eight active decisions,
ranked by pin, task relevance, and recency. Invalidated and superseded decisions
leave the reminder. It is capped at **8,000 characters**, not provider-specific tokens;
the full history remains on disk. The reminder is not appended to the session
transcript, and is rebuilt after compaction and resume. It supplies reference
data, not authorization to start an old task. In untrusted projects or with
`"projectMemory": false` in `context-forge.json`, it is not loaded.

Blackhole compaction also places a bounded **Resume Context** block at the start
of its summary when a saved task is available. It includes the goal, blockers,
next action, progress, and freshly assessed evidence status. It is deterministic,
replaced at each compaction, and respects `projectMemory` and project trust.
Stale, completed, and cross-session notes remain reference data, not new tasks.
This works in both normal and append-summary modes.

Run `npm run benchmark:memory` for three isolated 300-compaction retention
profiles and optional model-recall probes. See [the benchmark guide](benchmarks/README.md).

See [Focused continuation state](docs/CONTINUATION_STATE.md) for v2 migration,
task lifecycle, provenance, host check receipts, handoff diagnostics, and the
omni-advisor integration boundary. `/forge-memory diagnostics` shows budget and
omission decisions without making model calls.

Concurrent writers use a lock and revision checks. If a process crashes leaving
`.context-forge/write.lock`, inspect whether another writer is active before
manually removing that directory. Each file is replaced atomically, with the
JSON source committed last; if a write is interrupted, read the source revision
and refresh its generated documents. This is project state shared by sessions
of the same checkout; it is not a private per-session scratchpad.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

## Project layout

```
index.ts                     # package entry point (re-exports src/index.ts)
src/
  index.ts                   # extension factory + registration order
  config.ts                  # unified context-forge.json loading
  blackhole-register.ts      # pi-blackhole mechanism/command registration
  extensions/                # SoL-Pi mechanisms
    action-fusion/
    observation-pack/
    evidence-preserving-reducer/
    online-context-compact/
  blackhole/                 # pi-blackhole-derived code
    src/
      om/                    # observational memory runtime, ledger, agents
      hooks/                 # compaction hooks
      commands/              # slash commands
      tools/                 # recall tool
      core/                  # shared formatting/budget/sanitize logic
      extract/               # git/file/goal/preference extraction
      pi-base/               # pi-blackhole settings & config manager
```

## License

[MIT](./LICENSE)

Implementation boundaries and configuration maintenance are described in
[Maintenance boundaries](docs/MAINTENANCE_BOUNDARIES.md).
