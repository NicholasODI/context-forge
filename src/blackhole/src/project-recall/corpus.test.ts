import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OM_OBSERVATIONS_RECORDED } from "../om/ledger/types.ts";
import { buildProjectMemoryCorpus, buildProjectMemoryCorpusAsync, encodeScopeDir, type CorpusProgress } from "./corpus.ts";

it("shares scope, active-file exclusion, and pending attribution across both corpus builders", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "forge-corpus-"));
  try {
    const gitRoot = join(agentDir, "project");
    const cwd = join(gitRoot, "subdirectory");
    const scope = (path: string) => join(agentDir, "sessions", encodeScopeDir(path));
    const pending = join(agentDir, "pi-blackhole");
    const foreign = scope(join(agentDir, "foreign"));
    await Promise.all([scope(cwd), scope(gitRoot), foreign, pending].map(path => mkdir(path, { recursive: true })));

    const session = (id: string, content?: string) => [
      JSON.stringify({ type: "session", id }),
      ...(content === undefined ? [] : [
        "invalid JSON line",
        JSON.stringify({ type: "custom", customType: OM_OBSERVATIONS_RECORDED, data: { observations: [{ content }] } }),
      ]),
    ].join("\n");
    const batch = (content: string) => ({ data: { observations: [{ content }] } });
    const activeSessionFile = join(scope(cwd), "active.jsonl");
    await Promise.all([
      writeFile(activeSessionFile, session("active", "active file contents")),
      writeFile(join(scope(cwd), "shared.jsonl"), session("project", "primary scope")),
      writeFile(join(scope(gitRoot), "shared.jsonl"), session("duplicate", "duplicate basename")),
      writeFile(join(scope(gitRoot), "no-markers.jsonl"), session("root")),
      writeFile(join(foreign, "session_foreign.jsonl"), "malformed header"),
      writeFile(join(pending, "root-pending.json"), JSON.stringify({ observationBatches: [batch("main buffer")] })),
      writeFile(join(pending, "root-pending.stale.json"), JSON.stringify({ observation: batch("superseded backup") })),
      writeFile(join(pending, "missing-pending.stale.json"), JSON.stringify({ observation: batch("orphaned legacy buffer") })),
      writeFile(join(pending, "foreign-pending.json"), JSON.stringify({ observation: batch("foreign buffer") })),
    ]);

    const options = { agentDir, gitRoot, cwd, activeSessionFile };
    const progress: CorpusProgress[] = [];
    const corpus = await buildProjectMemoryCorpusAsync(options, event => progress.push(event));
    expect(corpus).toEqual(buildProjectMemoryCorpus(options));
    expect(corpus).toMatchObject({ projectRoot: gitRoot, sessionsConsidered: 2, filesWithMarkers: 1, orphanedSessions: 1 });
    expect(corpus.knownSessionIds).toEqual(new Set(["project", "root"]));
    expect(corpus.observations.map(({ content, source }) => `${source}: ${content}`).sort()).toEqual([
      "branch: primary scope",
      "orphan: orphaned legacy buffer",
      "pending: main buffer",
    ]);
    expect(progress).toEqual([
      { scanned: 0, total: 2, phase: "scanning" },
      { scanned: 2, total: 2, phase: "scanning" },
    ]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
