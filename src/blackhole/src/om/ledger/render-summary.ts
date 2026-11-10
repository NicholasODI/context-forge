/**
 * Summary rendering — formats observations/reflections for compaction output.
 *
 * Upstream: https://github.com/elpapi42/pi-observational-memory (src/session-ledger/render-summary.ts)
 * Modified: separator-aware whole-record output caps.
 */
import type { Observation, Reflection } from "./types.js";
import { estimateStringTokens } from "../tokens.js";

const OM_INSTRUCTIONS_FULL = `Bracketed ids in reflections and observations connect to their source session entries. These are condensed memories from earlier in this session.
When entries conflict, the most recent observation reflects the latest known state.
Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When exact source context is needed for precision or traceability, use the \`recall\` tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently.`;

const OM_INSTRUCTIONS_BASIC = `Use \`recall\` with an id to retrieve original context, or \`#N:path\` drill-down to explore file content from referenced entries.
When entries conflict, the most recent entry reflects the latest known state.`;

export const OM_FOOTER_FULL = `----\n${OM_INSTRUCTIONS_FULL}\n----`;
export const OM_FOOTER_BASIC = `----\n${OM_INSTRUCTIONS_BASIC}\n----`;

export function observationToSummaryLine(observation: Observation): string {
  return `[${observation.id}] ${observation.timestamp} [${observation.relevance}]${observation.pinned ? " [pinned]" : ""} ${observation.content}`;
}

/** Same conservative rendered-cost basis for pressure, targets, and pruning. */
export function observationRenderedTokens(observation: Observation): number {
  return estimateStringTokens(observationToSummaryLine(observation)) + 1;
}

/** Score an observation for cap/trim selection.
 *  Relevance tier dominates: medium (5+) always outranks low (max 2).
 *  Recency is based on position in the flat-mapped array (0 = oldest, N-1 = newest),
 *  avoiding wall-clock dependency that punishes sessions spanning days or weeks. */
export function scoreObservation(obs: Observation, index: number, total: number): number {
  const base = obs.pinned ? 1000 : obs.relevance === "critical" ? 20 :
    obs.relevance === "high" ? 10
      : obs.relevance === "medium"
        ? 5
        : 1;
  const recency = total > 1 ? index / (total - 1) : 1;
  return base + recency;
}

function queryBonus(content: string, query: string): number {
  const stop = new Set(["the", "and", "for", "with", "this", "that", "from", "into"]);
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])].filter(t => !stop.has(t));
  const lower = content.toLowerCase();
  return Math.min(2, terms.filter(t => lower.includes(t)).length * 0.5);
}

/** Select observations up to a token budget, keeping high-relevance items
 *  first and filling the remaining budget with the best-scoring medium and
 *  low observations (relevance-tiered + recency).
 *
 *  The budget is a hard cap: when high/critical items alone exceed it, the
 *  newest are kept and the oldest are sacrificed (sessions can accumulate
 *  hundreds of high-relevance observations, which previously pushed the
 *  rendered pool far past the budget).
 *
 *  Observations stay in the branch either way; this only caps what is rendered
 *  in the compaction summary output. */
export function selectPriorObservations(
  observations: Observation[],
  maxTokens: number,
  query = "",
): Observation[] {
  const ranked = observations.map((obs, index) => ({
    obs,
    index,
    score: scoreObservation(obs, index, observations.length) + queryBonus(obs.content, query),
  }));
  ranked.sort((a, b) => b.score - a.score);
  const selected: typeof ranked = [];
  let usedTokens = 0;
  for (const item of ranked) {
    const cost = estimateStringTokens(observationToSummaryLine(item.obs)) + (selected.length ? 1 : 0);
    if (usedTokens + cost > maxTokens) {
      if (item.obs.pinned) throw new PinnedMemoryOverflowError();
      continue;
    }
    selected.push(item);
    usedTokens += cost;
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.obs);
}

export function reflectionToSummaryLine(reflection: Reflection): string {
  return `[${reflection.id}]${reflection.pinned ? " [pinned]" : ""} ${reflection.content}`;
}

export class PinnedMemoryOverflowError extends Error {
  override readonly name = "PinnedMemoryOverflowError";
  constructor() { super("Pinned memory exceeds the configured output budget. Inspect/unpin or supersede records before compacting; no pinned record was silently omitted."); }
}

/** Bound compaction output only; worker reflection prompts stay unchanged. */
export function selectPriorReflections(reflections: Reflection[], maxTokens: number, query = ""): Reflection[] {
  const selected: Reflection[] = [];
  let usedTokens = 0;
  const rank = { low: 0, medium: 5, high: 10, critical: 20 };
  const ranked = reflections.map((reflection, i) => ({ reflection, i, score: (reflection.pinned ? 1000 : rank[reflection.relevance ?? "medium"]) + queryBonus(reflection.content, query) + i / Math.max(1, reflections.length) }))
    .sort((a, b) => b.score - a.score);
  for (const { reflection } of ranked) {
    const cost = estimateStringTokens(reflectionToSummaryLine(reflection)) + (selected.length ? 1 : 0);
    if (usedTokens + cost > maxTokens) {
      if (reflection.pinned) throw new PinnedMemoryOverflowError();
      continue;
    }
    selected.push(reflection);
    usedTokens += cost;
  }
  const ids = new Set(selected.map(r => r.id));
  return reflections.filter(r => ids.has(r.id));
}

export function renderSummary(reflections: Reflection[], observations: Observation[]): string {
  const hasContent = reflections.length > 0 || observations.length > 0;

  const parts: string[] = [];
  if (reflections.length > 0) {
    parts.push(`## Reflections\n${reflections.map(reflectionToSummaryLine).join("\n")}`);
  }
  if (observations.length > 0) {
    parts.push(`## Observations\n${observations.map(observationToSummaryLine).join("\n")}`);
  }

  const footer = hasContent ? OM_FOOTER_FULL : OM_FOOTER_BASIC;
  if (parts.length > 0) {
    parts.push(footer);
    return parts.join("\n\n");
  }
  return footer;
}
