import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PROFILES, runMemoryProfile, gradeAnswers } from "./memory-quality";

it("measures retention separately from model recall across three 300-compaction profiles", async () => {
  const profiles = PROFILES.map(p => runMemoryProfile(p));
  for (const { metrics: m } of profiles) {
    expect(m.pinnedHits).toBe(m.pinnedChecks);
    expect(m.correctedHits).toBe(m.correctedChecks);
    expect(m.staleLeaks + m.budgetViolations + m.prefixViolations + m.staleActionLeaks).toBe(0);
    expect(m.archiveRecovered).toBe(m.archiveChecks);
    expect(m.pruned).toBeGreaterThan(0);
    expect(m.hostCompactionMessages).toBe(1);
    expect(m.estimatedSummaryFitsWindow).toBe(true);
    expect(m.exposedProbes).toBeGreaterThanOrEqual(5);
  }
  if (process.env.npm_lifecycle_event === "benchmark:memory") {
    const directory = fileURLToPath(new URL("./results/", import.meta.url));
    await mkdir(directory, { recursive: true });
    let answers: Record<string, unknown> | undefined;
    if (process.env.FORGE_MEMORY_ANSWERS) answers = JSON.parse(await readFile(process.env.FORGE_MEMORY_ANSWERS, "utf8"));
    const report = { version: 1, mode: "offline-synthetic", providerCalls: 0,
      scope: "Deterministic selection/continuity and source recall. Worker semantics, provider overhead, native omp, and model attention are not measured.",
      profiles: profiles.map(({ request: _request, ...profile }) => ({ ...profile,
        modelRecall: answers ? { status: "scored-supplied-answers", ...gradeAnswers(profile.probes, answers[profile.profile]) } : profile.modelRecall })),
    };
    await writeFile(new URL("./results/latest.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
    await writeFile(new URL("./results/probes.json", import.meta.url), JSON.stringify(profiles.map(p => p.request), null, 2) + "\n");
    console.info(JSON.stringify(report, null, 2));
  }
}, 30000);

it("scores actual supplied answers separately and rejects mixed old/new transport claims", () => {
  const probes = [{ id: "transport", question: "Transport?", expected: "UNIX-NEW", forbidden: "TCP-OLD", exposed: true },
    { id: "old", question: "Old value?", expected: "17", exposed: false }];
  expect(gradeAnswers(probes, { transport: "UNIX-NEW", old: "unknown" })).toMatchObject({ exactCorrect: 1, exposedCorrect: 1, unexposedAbstentions: 1 });
  expect(gradeAnswers(probes, { transport: "TCP-OLD or UNIX-NEW" }).exactCorrect).toBe(0);
  expect(gradeAnswers(probes, null).exactCorrect).toBe(0);
});

it("produces identical synthetic metrics and requests from the same inputs", () => {
  expect(runMemoryProfile(PROFILES[0], 4)).toEqual(runMemoryProfile(PROFILES[0], 4));
});
