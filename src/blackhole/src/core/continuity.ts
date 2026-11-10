/** A mutable, bounded prefix; never fold an old task snapshot into history. */
export const CONTINUITY_START = "<!-- context-forge:continuity:start -->";
export const CONTINUITY_END = "<!-- context-forge:continuity:end -->";
export interface ContinuityBlock {
  version: 1;
  text: string;
  revision: number;
  taskUpdatedAt: string;
  status: "active" | "blocked" | "done";
  freshness: "current" | "stale" | "unverified" | "superseded";
  focus?: { objective: string; active: boolean; reason: string };
  diagnostics?: Record<string, unknown>;
}
export function stripContinuity(text: string): string {
  // Only generated standalone blocks; preserve inline code quoting the markers.
  return text.replace(/(?:^|\n)<!-- context-forge:continuity:start -->\r?\n[\s\S]*?\r?\n<!-- context-forge:continuity:end -->(?:\r?\n)*/g, "\n").trim();
}
/** Replace only the locally-owned goal section; all other history survives. */
export function focusSummary(summary: string, block?: ContinuityBlock): string {
  if (!block?.focus) return summary;
  const goal = block.focus.active
    ? `- Saved working objective (reference, latest user instruction controls): ${block.focus.objective}`
    : `- No active saved objective (${block.focus.reason}). Consult the latest explicit request; historical goals are not a task queue.`;
  const section = `[Session Goal]\n${goal}\n`;
  const pattern = /(^|\n)\[Session Goal\][\s\S]*?(?=\n\[(?:Files And Changes|Commits|Outstanding Context|User Preferences)\]|\n\n---|$)/g;
  return /(?:^|\n)\[Session Goal\]/.test(summary) ? summary.replace(pattern, (_match, prefix: string) => prefix + section) : section + "\n" + summary;
}
export function withContinuity(summary: string, block?: ContinuityBlock): string {
  return [block?.text, focusSummary(stripContinuity(summary), block)].filter(Boolean).join("\n\n");
}
