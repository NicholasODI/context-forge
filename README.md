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
  "unifiedRecall": true
}
```

The pi-blackhole-derived mechanisms additionally read pi-blackhole's own `blackhole-config.json` for fine-grained tuning; `context-forge.json` only gates whether those mechanisms are registered at all.

## Commands

| Command | Description |
|---|---|
| `/blackhole` | Manual compact with structural summary. Subcommands: `[settings]` config overlay, `[changelog]`, `[cleanup]`, `[om-off]`/`[om-on]`. |
| `/blackhole-memory` | Memory pipeline status & token counters. `[view]` visible observations/reflections, `[full]` complete recorded memory (copies to clipboard). |
| `/blackhole-export` | Export distilled project memory to markdown. `[out:<path>]` — defaults to project cwd. |
| `/blackhole-recall` | Search session history. `<query> [page:N] [scope:all] [mode:file\|touched]`. |

## Tools

- **`recall`** — unified recall over session lineage, file content, and touched-file summaries, with paging and scope control.

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
