# User-initiated sessions with portable project memory

You create new sessions in OMP. Context-forge does not call newSession, switch
sessions, launch a task, or mark the previous task complete. A generic
“continue” is not authorization to resume an unrelated old task.

The projectMemory feature now maintains a portable observational-memory archive
alongside the existing task/decision state. Neither workers nor deterministic
compaction are replaced. No extra LLM, embedding or advisor call is made.

## Normal workflow

1. Work in a trusted project with projectMemory enabled (the default).
2. Update project_memory after meaningful task progress. Use complete_task only
   when the current task is complete; record unresolved issues and evidence.
3. Let in-flight workers finish before leaving. Automatic checkpoints run on
   main-context preparation, agent_end, session_shutdown where supported, and consolidation
   settlement (including partially successful pipelines). The last callback
   captures worker results that arrive after the main agent has ended.
4. Optionally run /forge-memory sync before leaving, especially when upgrading
   an existing long session. This checkpoints existing branch/pending OM data;
   it does not run workers, compact, or change a task's status.
5. Create a new session yourself in the same project and state the new task.
   The extension reads the folder and injects one bounded orientation
   automatically. The model does not need to discover the folder by a tool call.

Hooks resolve the live session manager, so a resumed boot identity is not used
as permanent project identity. The context handler remains registered after VCC.
No branch OM entries or worker cursors are imported into the new session.
Fresh session workers start with their own transcript and pools. Cross-session
memory remains available through the orientation and archive recall.

## Package layout and copying

| Path inside .context-forge | Purpose |
|---|---|
| memory.json | Existing authoritative v1/v2 task/decision state |
| TASK.md / DECISIONS.md | Existing generated human-readable views |
| archive/objects/HASH.json | Immutable, content-addressed OM entries and bounded source excerpts |
| archive/sessions/HASH.json | Per-origin-session latest branch checkpoint, with ordered object references |

Copy the **whole folder**, including archive objects and session manifests,
to another checkout/machine. A new trusted session can read it without the old
OMP session file or global pending file. v1/v2 task state migration is unchanged;
the archive has its own version=1 format. Old builds simply do not use this
archive. No new folder is created in a project with neither OM records nor an
explicit task/decision write.

Archive records retain memory IDs, observation source IDs, reflection support
IDs, drop proof metadata where present, and explicit pin/invalidation/supersession
events. SHA-256 object names check saved-byte integrity, not factual truth or
trusted authorship.
Original memory IDs remain provenance labels even if secret redaction changes
their content. Pending observation/reflection/drop batches are included as
synthetic archive entries, without their worker cursors.

Only the origin's latest branch manifest is selected by default. Fork replacement
does not merge conflicting branch tombstones. Previously written objects stay
on disk; a known object hash can retrieve the old capsule, or it can be read
directly. Unreferenced historical objects are not automatically searched.
This is not a full multi-branch transcript backup.

## What a new session receives

The existing task/decision reminder remains at most 8,000 characters. The
cross-session orientation adds at most 3,000 characters, for a combined ceiling
of 11,002 characters including the separator. It reports archive availability,
reference/authorization and freshness warnings, and up to six relevant records.

Selection is deterministic lexical matching against the latest projected user
message. It is not semantic search and may miss paraphrases. With a nonempty
query, unrelated records are not injected merely to fill slots. Current-session
records are excluded from the cross-session orientation to avoid duplication
with the live session's OM summary. Orientation/reminder messages are replaced
on each request, never appended to the session transcript.

All archive claims have **unknown current freshness**, even if the source task
had once passed checks. Active means active at the captured origin checkpoint,
not “still true now.” Current task/decision file fingerprints retain their
existing scoped freshness behavior; it is not transferred to unrelated
archived claims.

## Recall and diagnosis

Use the existing project_memory tool:

    {"action":"recall","query":"permission isolation","limit":5}
    {"action":"recall","id":"012345abcdef"}
    {"action":"recall","query":"permission","sessionId":"ORIGIN_SESSION_ID"}
    {"action":"recall","query":"old transport","includeInactive":true}
    {"action":"read","section":"sessions","offset":0,"limit":10}
    {"action":"diagnostics"}

Recall is paginated and bounded to roughly 12,000 serialized characters.
Content and reference arrays are previews. Follow the returned object hash to
archive/objects/HASH.json for saved fields omitted from previews. Reflection
support IDs can be recalled as observations to inspect their saved sources.
An explicit ID lookup can expose inactive records and per-origin conflicts;
do not infer current lifecycle from a standalone historical object.

Dropped/policy-inactive records are excluded from default search/orientation.
If scanned origins disagree, any retired copy conservatively suppresses that
kind/ID from default selection. Explicit ID, origin-scoped, and includeInactive
lookup retain access rather than silently choosing a globally authoritative
version. This avoids resurrecting old facts from a second origin.

/forge-memory diagnostics and project_memory diagnostics report archive
availability, scan limits and corrupt checkpoints. These describe extension
selection, not provider-wire delivery or model attention.

## Evidence, privacy and operational limits

- Source copies are at most 32 entries per OM capsule, with at most 2,000
  characters per user/assistant text excerpt. Missing/truncated sources are
  labeled. Tool stdout, tool arguments, thinking and system prompts are not
  copied. Full tool evidence still requires the original transcript or project
  files. Captured model-written observations can themselves quote output.
- Recognized credentials are redacted before writing and when rendering.
  Detection is best-effort; review the folder before sharing or committing it.
  The extension never commits or pushes project memory files.
- The existing projectMemory=false and untrusted-project gates disable
  capture, recall and orientation. Context projection removes generated live
  reminders; existing archive files are left intact.
- Objects commit before a manifest is atomically replaced. Different sessions
  have separate write locks; identical objects deduplicate. A failed/interrupted
  update leaves the last manifest usable. Inspect an abandoned
  archive/sessions/*.lock before manually removing it. Leftover objects do not
  become active merely because they exist on disk.
- Capture skips unchanged immutable entry-ID sets. Reads cache immutable
  objects (up to 8 MiB/512 objects) and the latest selected view; manifest stat
  changes invalidate the view. Already loaded immutable objects are not
  repeatedly verified for in-place tampering; reload to revalidate saved bytes.
- Each object is at most 1 MiB and each manifest at most 2 MiB. A search scans
  at most 128 session manifests, 4,096 object references and 64 MiB of capsule
  content. It never folds a partial manifest, which could omit later
  tombstones. Limits/corruption are surfaced, not treated as proof that memory
  is empty. Use the paged sessions catalog and sessionId scoping when the
  project exceeds the aggregate scan limit. An individually oversized manifest
  still requires offline inspection rather than partial automatic import.
  A single branch capture above 4,096 OM entries is refused without replacing
  the prior checkpoint. Previously captured source excerpts survive later
  disappearance of the original source messages.
- Archive disk storage grows with durable history; this feature does not
  automatically prune it. The 2 MiB task-state limit applies to memory.json,
  not the total archive. Back up the folder deliberately.
- A hard crash before a checkpoint can leave recent session-file entries
  uncopied. Reopen the original session and sync to recover them. Old sessions
  are not silently crawled on disk; reopen/sync each one that needs importing.
- Non-Git projects use the current working directory as their project root.
  Start the next session in the same directory. Concurrent machines modifying
  copies of the same origin manifest need explicit reconciliation; this is
  not a distributed merge protocol.

The existing /blackhole-export remains a separate Markdown export from the
host's project session corpus. It does not export this folder or restore it.
Copy .context-forge for portable archive recall.

Omni-advisor retains retry, recovery, escalation and stopping ownership.
Context-forge provides persistence, retrieval and reference context only.
Linux synthetic tests validate the package and hook contracts; native OMP
lifecycle availability and individual model attention remain runtime boundaries.
